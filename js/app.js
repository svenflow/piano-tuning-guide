/*
 * app.js - the page: tabs (Steps, Keys, Tuner, Learn), cards built from PLAN,
 * the 3D diagram, sounds, the tuner and the glossary sheet.
 * Deep links: #step-9, #note-As3 (s = sharp), #tuner, #learn; add &still for captures.
 */
import * as THREE from 'three';
import { PLAN, GLOSSARY, SOURCES, KINDS, PUBLISHED, LOW, HIGH, nameOf, midiOf, freq, beat, pureFreq,
  plainRate, fmtRate, noteInfo, temperamentTable, isBlack } from './data.js';
import { PianoScene, keyX } from './scene.js';
import * as audio from './audio.js';
import { Tuner } from './tuner.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const STEPS = PLAN.steps;
const STILL = /(^|[#&])still\b/.test(location.hash);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const REPO = 'https://github.com/svenflow/piano-tuning-guide';
const state = { tab: 'steps', step: 0, note: midiOf('A4'), keysCx: keyX(midiOf('A4')), from: null, tunerSource: 'step', tunerRaw: false, tunerHeard: null, rendered: { step: -1, note: -1 } };

/* ---------- text helpers ---------- */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const srcNo = (id) => SOURCES.findIndex((s) => s.id === id) + 1;
function rich(t) {
  if (!t) return '';
  return esc(t)
    .replace(/([A-G])#(-?\d)/g, '$1♯$2')
    .replace(/\[\[([a-z]+)(?:\|([^\]]+))?\]\]/g, (_, k, label) => `<a class="term" href="#term-${k}" data-term="${k}">${label || (GLOSSARY[k] ? GLOSSARY[k][0].toLowerCase() : k)}</a>`)
    .replace(/(?:\s?\[src:[a-z0-9-]+\])+/g, (run) => srcChip([...run.matchAll(/\[src:([a-z0-9-]+)\]/g)].map((m) => m[1])));
}
function srcChip(ids) {
  const order = ids.map((id, i) => [srcNo(id), id]).sort((a, b) => a[0] - b[0]);
  return `<a class="src" href="#src-${order[0][1]}" data-src="${order.map((o) => o[1]).join(' ')}" aria-label="Source${ids.length > 1 ? 's' : ''} ${order.map((o) => o[0]).join(', ')}">[${order.map((o) => o[0]).join(', ')}]</a>`;
}
const urlNote = (m) => nameOf(m).replace('#', 's');
const fromUrlNote = (s) => midiOf(s.replace('s', '#'));
const sharpWord = (n) => n.replace('#', '♯');
const pairTxt = (b) => `${sharpWord(b.loName || nameOf(b.lo))}+${sharpWord(b.hiName || nameOf(b.hi))}`;
const svg = (d, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const P_PLAY = '<path d="M8 5.5v13l10.5-6.5z"/>', P_STOP = '<rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor"/>';
const P_SPK = '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>';
const ICO_PLAY = `<span class="ico">${svg(P_PLAY, 'i-off')}${svg(P_STOP, 'i-on')}</span>`;
const ICO_SPK = `<span class="ico">${svg(P_SPK, 'i-off')}${svg(P_STOP, 'i-on')}</span>`;
const ICON_GO = svg('<path d="M9 5l7 7-7 7"/>');
const ICON_BACK = svg('<path d="M15 5l-7 7 7 7"/>');
const ICON_DOWN = svg('<path d="M6 9l6 6 6-6"/>');
const ICON_MIC = svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>');
const P_NEXT = '<path d="M9 5l7 7-7 7"/>', P_RESTART = '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>';

/* ---------- scene (with a fallback when WebGL is missing) ---------- */
function stubScene() {
  const v = () => new THREE.Vector3();
  const base = { w: 1, h: 1, user: { az: 0, el: 0, pan: 0 }, view: { r: 1 }, keyAnchor: v, keyFront: v, pinAnchor: v,
    project: () => ({ x: -999, y: -999, vis: false }), pick: () => null, keyRangeBox: () => new THREE.Box3(), pxPerMetre: () => 1 };
  return new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => {}) });
}
function noThreeD() { $('#app').classList.add('no3d'); $('#no3d').hidden = false; $('#c').style.visibility = 'hidden'; }
let scene;
try { scene = new PianoScene($('#c'), { still: STILL || REDUCED }); }
catch (err) { scene = stubScene(); noThreeD(); }
$('#c').addEventListener('webglcontextlost', (e) => { e.preventDefault(); noThreeD(); });
window.__scene = scene; // for tests
const wide = () => scene.w >= 700;   // big stage: show the whole action, not just the keys

const labelsEl = $('#labels');
let labelSpec = [];
scene.onFrame(placeLabels);
function placeLabels() {
  const pool = labelsEl.children;
  while (pool.length < labelSpec.length) { const d = document.createElement('div'); d.className = 'lbl'; labelsEl.appendChild(d); }
  const placed = [];
  let downY = -Infinity; // labels hanging below the keys share one baseline
  for (const L of labelSpec) if (L.side === 'down') { const q = scene.project(L.at); if (q.vis) downY = Math.max(downY, q.y); }
  labelSpec.forEach((L, i) => {
    const el = pool[i];
    const p = scene.project(L.at);
    const side = L.side || 'up';
    el.className = 'lbl ' + side + ' ' + (L.cls || '');
    if (el.textContent !== L.text) el.textContent = L.text;
    const w = el.offsetWidth || 60, h = el.offsetHeight || 22;
    let x, y, off, leg;
    if (side === 'left') {
      x = p.x - (L.lift || 16); y = p.y; leg = L.lift || 16;
      off = !p.vis || x - w < 2 || y < h / 2 || y > scene.h - h / 2;
      el.style.transform = `translate(${x}px, ${y}px) translate(-100%, -50%)`;
    } else {
      const dir = side === 'down' ? 1 : -1;
      y = (side === 'down' && isFinite(downY) ? downY : p.y) + dir * (L.lift || 10); x = Math.min(Math.max(p.x, w / 2 + 6), scene.w - w / 2 - 6);
      for (let k = 0; k < 6; k++) { // step past labels already placed on the same side
        const hit = placed.find((q) => q.side === side && Math.abs(q.x - x) < (q.w + w) / 2 + 4 && Math.abs(q.y - y) < h + 2);
        if (!hit) break; y = hit.y + dir * (h + 4);
      }
      leg = Math.max(4, Math.abs(p.y - y));
      off = !p.vis || p.x < -20 || p.x > scene.w + 20 || (dir < 0 ? y - h < 2 : y + h > scene.h - 2) || (dir < 0 ? y > scene.h - 2 : y < 2);
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, ${dir < 0 ? '-100%' : '0'})`;
    }
    el.style.setProperty('--leg', leg + 'px');
    el.style.zIndex = String(1000 - Math.round(leg)); // long legs go under short ones, so a leader never crosses a pill
    el.classList.toggle('off', off);
    placed.push({ x, y, w, side });
  });
  for (let i = labelSpec.length; i < pool.length; i++) pool[i].classList.add('off');
}
const keyLabel = (m, text, cls) => ({ at: scene.keyFront(m), text, cls, side: 'down', lift: 8 });
const keyLabelUp = (m, text, cls) => ({ at: scene.keyAnchor(m), text, cls, side: 'up' });
const pinLabel = (m, text, cls) => ({ at: scene.pinAnchor(m), text, cls, side: 'left', lift: 14 });
const insetFor = () => ({ top: 8, bottom: 52 }); // room for the labels that hang below the keys
const WHOLE = new THREE.Box3(new THREE.Vector3(-0.68, 0.02, -0.30), new THREE.Vector3(0.68, 1.12, 0.06));
const rangeM = (a, b) => { const o = []; for (let m = midiOf(a); m <= midiOf(b); m++) o.push(m); return o; };

function sceneForStep(s) {
  const tune = [], ref = [], soft = [], done = [];
  for (let m = LOW; m <= HIGH; m++) { const tb = PLAN.notes[m].tunedBy; if (tb && tb.step < s.n && s.n >= 8) done.push(m); }
  let box, dir = [0.18, 0.32, 1], labels = [], lever = null, leverString = null, strip = false, mute = null, fitPad = 1.08;
  const F = (n) => midiOf(n);
  if (s.target) { tune.push(F(s.target.note)); if (s.target.ref) ref.push(F(s.target.ref)); }
  const range = (a, b) => { const out = []; for (let m = a; m <= b; m++) out.push(m); return out; };
  scene.setAction(true);
  switch (s.view) {
    case 'overview':
      box = WHOLE; dir = [0.62, 0.34, 1]; fitPad = wide() ? 1.06 : 0.94;
      soft.push(...range(F('F3'), F('F4')));
      labels = [keyLabel(F('C4'), 'F3 to F4: middle octave'), keyLabelUp(F('A4'), 'A4 = 440 Hz', 'tune')];
      tune.push(F('A4'));
      break;
    case 'temperament': {
      const f = s.focus.map(F); const lo = Math.min(...f, F('F3')), hi = Math.max(...f, F('F4'));
      box = scene.keyRangeBox(lo - 1, hi + 1, { top: 'pins', bottom: 0.64 }); dir = [0.16, 0.30, 1];
      if (s.id === 'why') { ref.push(F('F3')); tune.push(F('C4')); }
      if (s.id === 'thirds') soft.push(...range(F('F3'), F('F4')));
      if (s.target) {
        labels.push(keyLabel(F(s.target.note), sharpWord(s.target.note) + ' · tune', 'tune'));
        if (s.target.ref) labels.push(keyLabel(F(s.target.ref), sharpWord(s.target.ref) + ' · play with', 'ref'));
        labels.push(pinLabel(F(s.target.note), sharpWord(s.target.note) + ' pin', 'tune'));
      } else if (s.id === 'why') { labels.push(keyLabel(F('F3'), 'F3', 'ref'), keyLabel(F('C4'), 'C4', 'tune')); }
      else if (s.id === 'thirds') { labels.push(keyLabel(F('F3'), 'F3'), keyLabel(F('F4'), 'F4')); }
      lever = s.lever ? F(s.lever) : null;
      if (s.n >= 7 && s.n <= 20) strip = true;
      break; }
    case 'pins': {
      const m = F(s.lever); const p = scene.pinAnchor(m);
      box = new THREE.Box3(new THREE.Vector3(p.x - 0.09, 0.80, -0.30), new THREE.Vector3(p.x + 0.16, 1.12, -0.12)); dir = [0.42, 0.22, 1];
      lever = m; tune.push(m);
      labels = [pinLabel(m, 'tuning pin', 'tune'), { at: new THREE.Vector3(p.x + 0.135, p.y + 0.13, p.z + 0.06), text: 'lever', cls: 'note', side: 'up' }, { at: new THREE.Vector3(p.x - 0.05, p.y + 0.07, -0.26), text: 'pin block', cls: 'note', side: 'up' }, { at: new THREE.Vector3(p.x - 0.03, 0.87, -0.22), text: 'hammers', cls: 'note', side: 'left' }];
      break; }
    case 'strip': {
      box = scene.keyRangeBox(F('D3'), F('A4'), { top: 0.96, bottom: 0.76, front: -0.2 }); dir = [0.2, 0.28, 1]; strip = true;
      soft.push(...range(F('E3'), F('G4')));
      labels = [{ at: new THREE.Vector3(keyX(F('C4')), 0.826, -0.24), text: 'felt strip, E3 to G4', cls: 'note', side: 'down', lift: 18 }, { at: new THREE.Vector3(keyX(F('C4')), 0.875, -0.22), text: 'hammers', cls: 'note', side: 'up', lift: 14 }];
      break; }
    case 'unison': {
      const m = F(s.focus[0]); const p = scene.pinAnchor(m);
      box = new THREE.Box3(new THREE.Vector3(p.x - 0.06, 0.78, -0.30), new THREE.Vector3(p.x + 0.12, 1.10, -0.15)); dir = [0.32, 0.22, 1];
      tune.push(m);
      if (s.id === 'unisons') { lever = m; leverString = 0; mute = m; labels = [pinLabel(m, 'left string pin', 'tune'), { at: new THREE.Vector3(p.x + 0.004, 0.81, -0.24), text: 'rubber mute', cls: 'note', side: 'down', lift: 16 }]; }
      else labels = [{ at: new THREE.Vector3(p.x, 0.89, -0.245), text: 'A4: 3 strings', cls: 'tune', side: 'left', lift: 24 }];
      break; }
    case 'region': {
      const a = F(s.range[0]), b = F(s.range[1]);
      const up = s.id === 'treble' || s.id === 'top';
      const first = up ? a : b, octv = up ? first - 12 : first + 12, last = up ? b : a;
      box = scene.keyRangeBox(Math.max(LOW, Math.min(a, octv) - 2), Math.min(HIGH, Math.max(b, octv) + 2), { top: 'pins', bottom: 0.64 }); dir = [0.2, 0.36, 1];
      soft.push(...range(a, b));
      tune.push(first); ref.push(octv);
      labels = [keyLabel(first, sharpWord(nameOf(first)) + ' · first', 'tune'), keyLabel(octv, sharpWord(nameOf(octv)) + ' · octave', 'ref'), keyLabel(last, sharpWord(nameOf(last)) + ' · last')];
      lever = first;
      break; }
    default: box = WHOLE;
  }
  scene.setHighlights({ tune, ref, soft, done });
  scene.setStrip(strip);
  scene.setMute(mute);
  scene.setLever(lever, leverString, !!s.turn && !STILL && !REDUCED);
  if ((STILL || REDUCED) && lever != null && s.turn) scene.playTurn();
  scene.setUser({ az: 0, el: 0, pan: 0 });
  scene.frame(box, dir, { inset: insetFor(), pad: fitPad });
  labelSpec = labels;
  $('#replay').hidden = !(lever != null && s.turn) || REDUCED;
}

/* ---------- tabs ---------- */
function setTab(tab, { push = true } = {}) {
  const changed = tab !== state.tab;
  state.tab = tab;
  $('#app').dataset.tab = tab;
  scene.resize(); // the stage is shorter on the phone's Tuner tab
  if (changed) scene.instantOnce = true; // switching tabs is frequent: no camera flight
  $$('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  for (const t of ['steps', 'keys', 'tuner', 'learn']) $('#view-' + t).hidden = t !== tab;
  audio.stopAll();
  if (tab === 'steps') state.tunerSource = 'step';
  if (tab === 'keys') state.tunerSource = 'key';
  $('#tbar').hidden = !tuner.running || tab === 'tuner';
  resetLock();
  if (tab === 'steps') showStep(state.step, { push: false });
  if (tab === 'keys') showNote(state.note, { push: false, recenter: true });
  if (tab === 'tuner') showTunerScene();
  if (tab === 'learn') showLearn();
  if (push) writeHash();
  try { localStorage.setItem('ptg.tab', tab); } catch (e) { /* private mode */ }
}
$$('[role=tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
function writeHash() {
  const h = state.tab === 'steps' ? 'step-' + (state.step + 1) : state.tab === 'keys' ? 'note-' + urlNote(state.note) : state.tab;
  history.replaceState(null, '', '#' + h + (STILL ? '&still' : ''));
}

/* ---------- steps ---------- */
function rateBlock(b, demo) {
  const isOct = b.kind === 'P8' || b.kind === 'U';
  return `<div class="rate"><span class="big">${isOct ? '0' : '≈' + fmtRate(b.rate)}</span><span class="unit">${isOct ? 'beats/s: completely still' : 'beats/s · ' + (b.sense === 'wide' ? '<a class="term" href="#term-wide" data-term="wide">wide</a>' : '<a class="term" href="#term-narrow" data-term="narrow">narrow</a>')}</span>
    <span class="plain">${isOct ? 'No wobble at all.' : 'Target: ' + plainRate(b.rate) + '. Ideal-string value; real strings vary a little.'}</span></div>${demoRow(demo)}`;
}
function demoRow(demo, label = 'Hear it') {
  if (!demo) return '';
  if (demo.type === 'reference') return `<div class="demo"><button class="btn hear" type="button" data-demo="ref" data-label="Play 440 Hz">${ICO_SPK}<span>Play 440 Hz</span></button><span class="demo-state" data-state>A steady 440 Hz tone until you tap Stop.</span></div>`;
  return `<div class="demo"><button class="btn hear" type="button" data-demo="step" data-label="${label}">${ICO_SPK}<span>${label}</span></button><span class="light" data-light aria-hidden="true"></span><span class="demo-state" data-state>${demo.type === 'interval' ? (demo.kind === 'P8' ? 'Off by 1 wobble a second, then still' : 'Pure (still), then as tuned') : demo.type === 'series' ? 'All nine 3rds, low to high' : 'Still, then ' + demo.off + ' wobble' + (demo.off === 1 ? '' : 's') + ' a second'}</span></div>`;
}
function micRow(note, mode) {
  const on = tuner.running;
  return `<div class="microw"><button class="btn small mic${on ? ' on' : ''}" type="button" data-mic="${mode}" data-label="Tune ${sharpWord(note)} with mic">${ICON_MIC}<span>${on ? 'Stop mic' : 'Tune ' + sharpWord(note) + ' with mic'}</span></button><span class="fine">Gets you close, within a cent or two. Your ear finishes it: the wobble.</span></div>`;
}
function checkRow(c, i) {
  const ivs = c.intervals || c.pair || [c];
  const pair = ivs.map((b) => `${pairTxt(b)} <span class="kind">${KINDS[b.kind].name}</span>`).join(' &nbsp;vs&nbsp; ');
  const r = ivs.map((b) => (b.rate < 0.03 ? '0.00' : fmtRate(b.rate))).join(' / ');
  const sense = ivs.map((b) => (b.rate < 0.03 ? 'still' : b.sense)).join(' / ');
  return `<li><span class="pair">${pair}</span><span class="r">${r}<small>${sense}</small></span>
    <span class="what">${rich(c.comment || '')}</span>
    <span class="play"><button class="playbtn" type="button" data-check="${i}" aria-label="Play ${ivs.map(pairTxt).join(' then ')}">${ICO_PLAY}</button></span></li>`;
}
let stepChecks = [];
const CHECK_HD = '<li class="hd"><span>Interval</span><span class="r">beats/s</span></li>';
function renderStep(s) {
  const card = $('#stepCard');
  const t = s.target;
  let html = `<p class="eyebrow">Step ${s.n} of ${STEPS.length} · ${esc(s.chapter)}</p><h2 class="title">${rich(s.title)}</h2><p class="lead">${rich(s.lead)}</p>`;
  if (t && t.ref) {
    const b = { rate: t.rate, sense: t.sense, kind: t.kind };
    html += `<div class="target"><div class="pairline"><span class="chip ${t.lo === t.note ? 'tune' : 'ref'}">${sharpWord(t.lo)}</span><span class="plus">+</span><span class="chip ${t.hi === t.note ? 'tune' : 'ref'}">${sharpWord(t.hi)}</span><span class="kind">${KINDS[t.kind].name} · tune ${sharpWord(t.note)}</span></div>${rateBlock(b, s.demo)}${micRow(t.note, 'step')}</div>`;
  } else if (s.demo) {
    html += `<div class="target">${demoRow(s.demo)}${t ? micRow(t.note, 'step') : ''}</div>`;
  }
  if (s.series) {
    const lo = 6, hi = 12, pos = (r) => ((Math.min(hi, Math.max(lo, r)) - lo) / (hi - lo) * 100).toFixed(1);
    html += `<ul class="series" id="series"><li class="hd"><span>Major 3rd</span><span class="r">beats/s</span><span class="ax"><span>${lo}</span><span>${hi}</span></span></li>${s.checks.map((c, i) => `<li data-i="${i}"><span>${pairTxt(c)}</span><span class="r">${fmtRate(c.rate)}</span><span class="trk"><i style="left:${pos(c.rate)}%"></i></span></li>`).join('')}</ul>`;
  }
  html += `<ol class="acts">${s.acts.map((a) => `<li>${rich(a)}</li>`).join('')}</ol>`;
  if (s.listen) html += `<p class="note-line"><b>Where to listen.</b> ${rich(s.listen)}</p>`;
  if (s.why) html += `<p class="note-line"><b>Why sharp?</b> ${rich(s.why)}</p>`;
  stepChecks = (!s.series && s.checks) ? s.checks : [];
  if (stepChecks.length) html += `<h3 class="sec-h">Check it</h3><ul class="checks">${CHECK_HD}${stepChecks.map((c, i) => checkRow(c, i)).join('')}</ul>`;
  if (s.range) html += `<p class="note-line"><b>Each key has its own checks.</b> <button class="linkbtn" type="button" data-note="${midiOf(s.range[0])}">See ${sharpWord(s.range[0])} in Keys ${ICON_GO}</button></p>`;
  if (s.tip) html += `<p class="tip">${rich(s.tip)}</p>`;
  if (s.src && s.src.length) html += `<p class="sources">Based on ${srcChip([...s.src].sort((a, b) => srcNo(a) - srcNo(b)))} <button class="linkbtn" type="button" data-goto-learn="sources">All sources</button></p>`;
  card.innerHTML = html;
}
function animateIn(el, dir) {
  if (STILL || REDUCED) return;
  el.classList.remove('enter'); void el.offsetWidth; el.style.setProperty('--from', (dir * 8) + 'px'); el.classList.add('enter');
}
function showStep(i, { push = true } = {}) {
  i = Math.max(0, Math.min(STEPS.length - 1, i));
  const changed = i !== state.rendered.step;
  const dir = i >= state.step ? 1 : -1;
  state.step = i; audio.stopAll();
  const s = STEPS[i];
  if (changed) { renderStep(s); $('#stepScroll').scrollTop = 0; if (state.rendered.step >= 0) animateIn($('#stepCard'), dir); state.rendered.step = i; }
  sceneForStep(s);
  $$('.countText').forEach((e) => (e.textContent = `${s.n} / ${STEPS.length}`));
  $('#prev').disabled = i === 0;
  const last = i === STEPS.length - 1;
  $('#nextLabel').textContent = i === 0 ? 'Start' : last ? 'Start over' : 'Next step';
  $('#next').classList.toggle('on', last);
  if (push) writeHash();
  try { localStorage.setItem('ptg.step', String(i)); } catch (e) { /* private mode */ }
}
$('#prev').addEventListener('click', () => showStep(state.step - 1));
$('#next').addEventListener('click', () => showStep(state.step === STEPS.length - 1 ? 0 : state.step + 1));
$('#replay').addEventListener('click', () => scene.playTurn());

/* ---------- demos ---------- */
let lightRaf = 0, playingBtn = null;
function setPlaying(btn, on) {
  if (playingBtn && playingBtn !== btn) { playingBtn.classList.remove('on'); swapLabel(playingBtn, false); }
  playingBtn = on ? btn : null;
  if (btn) { btn.classList.toggle('on', on); swapLabel(btn, on); }
  if (!on) { cancelAnimationFrame(lightRaf); $$('[data-light]').forEach((l) => l.style.removeProperty('--glow')); }
}
function swapLabel(btn, on) {
  const sp = btn.querySelector(':scope > span:not(.ico)'); if (!sp) return;
  if (on) btn.style.minWidth = btn.offsetWidth + 'px'; else btn.style.minWidth = '';
  sp.textContent = on ? 'Stop' : (btn.dataset.label || 'Hear it');
}
function phasesFor(demo) {
  if (demo.type === 'beats') return [
    { freqs: [demo.hz, demo.hz], dur: 3, beat: 0, label: 'Same pitch: still', notes: [midiOf('A4')] },
    { freqs: [demo.hz, demo.hz + demo.off], dur: 4.5, beat: demo.off, label: demo.off + ' Hz apart: ' + demo.off + ' wobble' + (demo.off === 1 ? '' : 's') + ' a second', notes: [midiOf('A4')] }];
  if (demo.type === 'series') return demo.pairs.map(([a, b]) => { const lo = midiOf(a), hi = midiOf(b); const bt = beat(lo, 'M3', hi); return { freqs: [freq(lo), freq(hi)], dur: 2.3, beat: bt.rate, label: pairTxt(bt) + ': ' + fmtRate(bt.rate) + ' a second', notes: [lo, hi] }; });
  if (demo.type === 'interval' || demo.type === 'check') {
    const lo = midiOf(demo.lo), hi = midiOf(demo.hi); const t = demo.target ? midiOf(demo.target) : hi;
    const K = KINDS[demo.kind]; const bt = beat(lo, demo.kind, hi);
    const up = t === hi; const refM = up ? lo : hi; const fRef = freq(refM);
    const pure = pureFreq(refM, demo.kind, up);
    const slow = (r) => Math.min(7, Math.max(3.2, 3 / Math.max(r, 0.01) + 0.6));
    if (demo.type === 'check') return [{ freqs: [freq(lo), freq(hi)], dur: bt.rate < 0.03 ? 3 : slow(bt.rate), beat: bt.rate, label: pairTxt(bt) + (bt.rate < 0.03 ? ': still' : ': ' + fmtRate(bt.rate) + ' a second'), notes: [lo, hi] }];
    if (bt.rate < 0.03) {
      const off = 1; const fOff = up ? (K.lo * fRef - off) / K.hi : (K.hi * fRef - off) / K.lo;
      return [{ freqs: [fRef, fOff], dur: 4, beat: off, label: 'Slightly off: 1 wobble a second', notes: [lo, hi] }, { freqs: [fRef, pure], dur: 3.5, beat: 0, label: 'In tune: still', notes: [lo, hi] }];
    }
    return [{ freqs: [fRef, pure], dur: slow(bt.rate), beat: 0, label: 'Pure: still', notes: [lo, hi] },
      { freqs: [freq(lo), freq(hi)], dur: slow(bt.rate), beat: bt.rate, label: 'As tuned: ' + plainRate(bt.rate), notes: [lo, hi] }];
  }
  return [];
}
function runDemo(btn, phases, { onPhase } = {}) {
  if (playingBtn === btn) { audio.stopAll(); return; }
  const scope = btn.closest('.target, .demo, li, .card') || document;
  const light = scope.querySelector('[data-light]') || (btn.closest('.card') || document).querySelector('[data-light]');
  const stateEl = (btn.closest('.demo') || scope).querySelector('[data-state]');
  const original = stateEl ? stateEl.textContent : '';
  setPlaying(btn, true);
  let ph = null, t0 = 0;
  audio.playPhases(phases, {
    onPhase: (i, p, start) => { ph = p; t0 = start; if (stateEl) stateEl.textContent = p.label; scene.holdKeys(p.dur * 1000, p.notes || []); if (onPhase) onPhase(i, p); },
    onEnd: () => { setPlaying(btn, false); if (stateEl) stateEl.textContent = original; if (onPhase) onPhase(-1); },
  });
  const tick = () => {
    if (light && ph) { const t = audio.now() - t0; const v = ph.beat > 0 ? 0.5 + 0.5 * Math.cos(2 * Math.PI * ph.beat * t) : 1; light.style.setProperty('--glow', String(0.1 + 0.9 * (t < 0 ? 0 : v))); }
    lightRaf = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(lightRaf); lightRaf = requestAnimationFrame(tick);
}
document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-demo]');
  if (d) {
    if (d.dataset.demo === 'ref') {
      if (playingBtn === d) { audio.stopAll(); return; }
      setPlaying(d, true); audio.playReference(440, 45, { onEnd: () => setPlaying(d, false) }); return;
    }
    const demo = d.dataset.demo === 'step' ? STEPS[state.step].demo : learnDemos[d.dataset.demo];
    if (!demo) return;
    runDemo(d, phasesFor(demo), { onPhase: demo.type === 'series' ? seriesPhase : null });
    return;
  }
  const c = e.target.closest('[data-check]');
  if (c) {
    const list = state.tab === 'keys' ? noteChecks : stepChecks;
    const item = list[Number(c.dataset.check)]; if (!item) return;
    const ivs = item.intervals || item.pair || [item];
    runDemo(c, ivs.flatMap((b) => phasesFor({ type: 'check', lo: nameOf(b.lo), hi: nameOf(b.hi), kind: b.kind })), {
      onPhase: (i, p) => { if (i < 0 || !p) return; scene.setHighlights({ tune: [p.notes[1]], ref: [p.notes[0]] }); } });
    return;
  }
  const term = e.target.closest('[data-term]'); if (term) { e.preventDefault(); openTerm(term.dataset.term, term); return; }
  const src = e.target.closest('[data-src]'); if (src) { e.preventDefault(); openSource(src.dataset.src, src); return; }
  const note = e.target.closest('[data-note]'); if (note) { openNote(Number(note.dataset.note)); return; }
  const go = e.target.closest('[data-goto-step]'); if (go) { setTab('steps', { push: false }); showStep(Number(go.dataset.gotoStep) - 1); return; }
  const gl = e.target.closest('[data-goto-learn]'); if (gl) { gotoLearn(gl.dataset.gotoLearn, gl.dataset.anchor); return; }
  const row = e.target.closest('[data-row]'); if (row) { tableRow(row); }
});
function seriesPhase(i, p) {
  $$('#series li').forEach((li) => li.classList.toggle('now', Number(li.dataset.i) === i));
  if (i >= 0 && p) scene.setHighlights({ tune: [p.notes[1]], ref: [p.notes[0]], soft: rangeM('F3', 'F4') });
  else sceneForStep(STEPS[state.step]);
}

/* ---------- keys (pick a note) ---------- */
let noteChecks = [];
function openNote(m) {
  if (state.tab === 'steps') state.from = state.step;
  state.note = m; state.keysCx = keyX(m);
  if (state.tab !== 'keys') setTab('keys'); else showNote(m, { recenter: true });
}
function showNote(m, { push = true, recenter = false, ms } = {}) {
  m = Math.max(LOW, Math.min(HIGH, m));
  const changed = m !== state.rendered.note;
  state.note = m;
  const info = noteInfo(m);
  const tb = info.tunedBy;
  let html = '';
  if (state.from != null) html += `<button class="backchip" type="button" data-goto-step="${state.from + 1}">${ICON_BACK}Back to step ${state.from + 1}</button>`;
  html += `<div class="note-title"><h2>${sharpWord(info.name)}</h2>${info.flat ? `<span class="alt">also ${info.flat}</span>` : ''}</div>`;
  const outer = m < midiOf('C3') || m > midiOf('C6');
  html += `<p class="facts"><span class="f">${info.hz.toFixed(2)} Hz ideal</span> <span class="f">key ${info.key} of 88</span> <span class="f">${info.strings} ${info.strings === 1 ? 'string' : 'strings'}${info.wound ? ', wound' : ''}</span>${outer ? `<span class="fine">A tuned piano sits ${m > midiOf('C6') ? 'sharp' : 'flat'} of this out here on purpose (<a class="term" href="#term-stretch" data-term="stretch">stretch</a>): a few cents near the middle, up to about 35 at the very ends.${rich(' [src:stretch]')}</span>` : ''}<span class="fine">String count is typical for an upright; yours may differ.${rich(' [src:ubc]')}</span></p>`;
  html += `<h3 class="sec-h">How it is tuned</h3>`;
  const st = STEPS[tb.step - 1];
  noteChecks = [];
  if (!tb.from) html += `<p>${rich('First, from the 440 Hz reference (fork, tone or tuner).')} <button class="linkbtn" type="button" data-goto-step="${tb.step}">Step ${tb.step}: ${rich(st.title)} ${ICON_GO}</button></p>`;
  else {
    const b = tb.interval; const isOct = b.kind === 'P8';
    noteChecks = [{ intervals: [b], comment: isOct ? 'Tune it until the octave is completely still.' : 'Tune it to ' + plainRate(b.rate) + ', a hair ' + b.sense + '.' }];
    html += `<p>${rich('From ' + nameOf(tb.from) + ', ' + (isOct ? 'as an [[octave]]' : 'as a ' + KINDS[b.kind].name) + (m > tb.from ? ' up' : ' down') + '.')} <button class="linkbtn" type="button" data-goto-step="${tb.step}">Step ${tb.step}: ${rich(st.title)} ${ICON_GO}</button></p>`;
    html += `<ul class="checks">${CHECK_HD}${checkRow(noteChecks[0], 0)}</ul>`;
  }
  const extra = info.checks.map((c) => ({ intervals: c.intervals, comment: c.comment, steps: c.steps, test: c.test }));
  if (extra.length) {
    html += `<h3 class="sec-h">Check it against <small>pale keys</small></h3><ul class="checks">${CHECK_HD}${extra.map((c, i) => checkRow(Object.assign({}, c, { comment: (c.test ? c.test[0].toUpperCase() + c.test.slice(1) + ': ' : '') + c.comment + ' (step ' + c.steps.join(', ') + ')' }), i + noteChecks.length)).join('')}</ul>`;
    noteChecks = noteChecks.concat(extra);
  }
  html += micRow(info.name, 'key');
  if (info.usedFor.length) html += `<h3 class="sec-h">Notes tuned from it</h3><ul class="used">${info.usedFor.map((u) => `<li><button type="button" data-note="${u.note}">${sharpWord(nameOf(u.note))} <span class="kind">step ${u.step}</span></button></li>`).join('')}</ul>`;
  if (info.strings > 1) html += `<p class="note-line"><b>Unison.</b> ${info.strings} strings: set ${info.strings === 3 ? 'the middle one' : 'one'} first, then tune the other${info.strings === 3 ? 's' : ''} to it until the wobble disappears (step ${info.unisonStep}).</p>`;
  else html += `<p class="note-line"><b>One string.</b> No unison to tune on this key.</p>`;
  html += `<p class="fine phone-only">Tap a key on the piano or the strip above to jump; drag the piano to slide along it.</p>`;
  $('#noteCard').innerHTML = html;
  if (changed) { $('#noteScroll').scrollTop = 0; if (state.rendered.note >= 0 && state.tab === 'keys') animateIn($('#noteCard'), m > state.rendered.note ? 1 : -1); state.rendered.note = m; }
  $('#notePrev').disabled = m <= LOW; $('#noteNext').disabled = m >= HIGH;
  $('#notePrevLabel').textContent = m > LOW ? sharpWord(nameOf(m - 1)) : 'Lower';
  $('#noteNextLabel').textContent = m < HIGH ? sharpWord(nameOf(m + 1)) : 'Higher';
  const rel = new Set(); if (tb.from) rel.add(tb.from);
  info.checks.forEach((c) => c.intervals.forEach((b) => { if (b.lo !== m) rel.add(b.lo); if (b.hi !== m) rel.add(b.hi); }));
  scene.setHighlights({ tune: [m], ref: tb.from ? [tb.from] : [], soft: [...rel].filter((x) => x !== tb.from) });
  scene.setStrip(false); scene.setMute(null);
  if (recenter) state.keysCx = keyX(m);
  labelSpec = [keyLabel(m, sharpWord(info.name), 'tune')].concat(tb.from ? [keyLabel(tb.from, sharpWord(nameOf(tb.from)) + ' · from', 'ref')] : []);
  if (wide()) { // big stage: the region with its strings, pins and the lever on this note
    scene.setAction(true); scene.setLever(m, null, false);
    const lo = Math.min(m, tb.from || m), hi = Math.max(m, tb.from || m);
    scene.frame(scene.keyRangeBox(Math.max(LOW, lo - 5), Math.min(HIGH, hi + 5), { top: 'pins', bottom: 0.64 }), [0.16, 0.30, 1], { inset: insetFor(), ms });
    labelSpec.push(pinLabel(m, sharpWord(info.name) + ' pin', 'tune'));
  } else { scene.setAction(false); scene.setLever(null); frameKeys(!recenter, ms); }
  $('#replay').hidden = true;
  drawMini(m, rel, tb.from);
  if (push) writeHash();
}
function keysHalfWidth() { return (scene.w / 40) * 0.0235 / 2; }
function frameKeys(instant, ms) {
  if (wide()) return;
  const hw = keysHalfWidth(); const lim = 52 * 0.0235 / 2 - hw * 0.6;
  state.keysCx = Math.max(-lim, Math.min(lim, state.keysCx));
  const box = new THREE.Box3(new THREE.Vector3(state.keysCx - hw, 0.66, -0.16), new THREE.Vector3(state.keysCx + hw, 0.73, 0.02));
  scene.frame(box, [0, 1.6, 1], { instant, pad: 1.0, inset: { top: 6, bottom: 34 }, ms });
  drawMiniWindow();
}
$('#notePrev').addEventListener('click', () => showNote(state.note - 1, { recenter: true, ms: 250 }));
$('#noteNext').addEventListener('click', () => showNote(state.note + 1, { recenter: true, ms: 250 }));

/* mini keyboard */
const mini = $('#mini');
const MW = 520 / 52;
function miniX(m) { let i = 0; for (let k = LOW; k < m; k++) if (!isBlack(k)) i++; return isBlack(m) ? i * MW - MW * 0.3 : i * MW; }
function drawMini(sel, rel, from) {
  let w = '', b = '';
  for (let m = LOW; m <= HIGH; m++) {
    const cls = m === sel ? ' sel' : m === from ? ' rel' : rel && rel.has(m) ? ' chk' : '';
    if (isBlack(m)) b += `<rect class="b${cls}" x="${miniX(m).toFixed(1)}" y="0" width="${(MW * 0.6).toFixed(1)}" height="26"/>`;
    else w += `<rect class="w${cls}" x="${miniX(m).toFixed(1)}" y="0" width="${MW.toFixed(1)}" height="44"/>`;
  }
  mini.innerHTML = w + b + '<rect class="win" id="miniWin" x="0" y="1" width="10" height="42"/>';
  drawMiniWindow();
}
function drawMiniWindow() {
  const win = $('#miniWin'); if (!win) return;
  if (wide()) { win.setAttribute('width', '0'); return; }
  const hw = keysHalfWidth(); const toMini = (x) => (x / 0.0235 + 26) * MW;
  win.setAttribute('x', toMini(state.keysCx - hw).toFixed(1)); win.setAttribute('width', (2 * hw / 0.0235 * MW).toFixed(1));
}
function miniToMidi(clientX) {
  const r = mini.getBoundingClientRect(); const x = (clientX - r.left) / r.width * 520;
  let best = LOW, bd = Infinity;
  for (let m = LOW; m <= HIGH; m++) if (!isBlack(m)) { const d = Math.abs(miniX(m) + MW / 2 - x); if (d < bd) { bd = d; best = m; } }
  return best;
}
let miniDrag = null;
mini.addEventListener('pointerdown', (e) => { miniDrag = { x0: e.clientX, moved: false }; mini.setPointerCapture(e.pointerId); });
mini.addEventListener('pointermove', (e) => {
  if (!miniDrag) return; if (Math.abs(e.clientX - miniDrag.x0) > 6) miniDrag.moved = true;
  if (miniDrag.moved && !wide()) { const r = mini.getBoundingClientRect(); state.keysCx = ((e.clientX - r.left) / r.width * 520 / MW - 26) * 0.0235; frameKeys(true); }
});
mini.addEventListener('pointerup', (e) => { if (miniDrag && !miniDrag.moved) showNote(miniToMidi(e.clientX), { recenter: true, ms: 250 }); miniDrag = null; });

/* ---------- tuner ----------
   The mic is requested only from a tap on a Start button. Two modes, remembered:
   Guided aims at the note of the current step (or the picked key) in equal temperament;
   Raw is a plain chromatic tuner (nearest note, cents, Hz). While it runs it keeps
   listening across tabs; a compact bar shows the reading and a Stop button. */
const tuner = new Tuner(onReading);
window.__tuner = tuner;
const LOCK_IN = 1.5, LOCK_OUT = 2.0, LOCK_MS = 500, TRACE_S = 3, TRACE_C = 20;
const lock = { smooth: null, since: 0, locked: false, key: null, lastHeard: 0 };
const trace = [];
try { state.tunerRaw = localStorage.getItem('ptg.tunerRaw') === '1'; } catch (e) { state.tunerRaw = false; }
(function drawTicks() {
  let s = '';
  for (let c = -50; c <= 50; c += 5) {
    const a = (c / 50) * 60 * Math.PI / 180; const major = c % 25 === 0; const r0 = major ? 104 : 112, r1 = 124;
    const x0 = 150 + Math.sin(a) * r0, y0 = 155 - Math.cos(a) * r0, x1 = 150 + Math.sin(a) * r1, y1 = 155 - Math.cos(a) * r1;
    s += `<line class="tk${major ? ' major' : ''}${c === 0 ? ' zero' : ''}" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`;
    if (major) s += `<text x="${(150 + Math.sin(a) * 140).toFixed(1)}" y="${(160 - Math.cos(a) * 140).toFixed(1)}" text-anchor="middle">${c > 0 ? '+' + c : c}</text>`;
  }
  const arc = (c) => { const a = (c / 50) * 60 * Math.PI / 180; return `${(150 + Math.sin(a) * 96).toFixed(1)} ${(155 - Math.cos(a) * 96).toFixed(1)}`; };
  s += `<path class="win" d="M ${arc(-LOCK_IN)} A 96 96 0 0 1 ${arc(LOCK_IN)}"/>`;
  s += `<text x="29" y="120" text-anchor="middle">flat</text><text x="271" y="120" text-anchor="middle">sharp</text>`;
  $('#ticks').innerHTML = s;
})();
function setNeedle(c) {
  const v = Math.max(-50, Math.min(50, c));
  $('#needle').style.transform = `rotate(${(v / 50) * 60}deg)`;
  $('#tbNeedle').style.left = (50 + Math.max(-20, Math.min(20, c)) * 2.5) + '%'; // the bar spans +-20 cents
  $('#tbar').classList.toggle('out', Math.abs(c) > 20);
}
/* what Guided mode aims at: {m, why, src} or null (Raw, or a step without a single note) */
function tunerTarget() {
  if (state.tunerRaw) return null;
  const t = STEPS[state.step].target;
  if (state.tunerSource === 'key' || !t) return { m: state.note, why: t ? 'the key you picked' : 'the key you picked (step ' + (state.step + 1) + ' has no single note)', src: 'key' };
  return { m: midiOf(t.note), why: 'step ' + (state.step + 1), src: 'step' };
}
function setRaw(raw) {
  state.tunerRaw = !!raw; try { localStorage.setItem('ptg.tunerRaw', raw ? '1' : '0'); } catch (e) { /* private mode */ }
  resetLock(); trace.length = 0; renderTargetPicker(); drawTrace(); if (state.tab === 'tuner') showTunerScene();
}
function renderTargetPicker() {
  $$('#modeSeg button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.raw === '1') === state.tunerRaw)));
  const st = STEPS[state.step].target;
  const bs = $('#srcStep'), bk = $('#srcKey');
  bs.disabled = !st; bs.querySelector('span').textContent = st ? `Step ${state.step + 1}: ${sharpWord(st.note)}` : `Step ${state.step + 1}: no single note`;
  bk.querySelector('span').textContent = 'Key: ' + sharpWord(nameOf(state.note));
  const useKey = state.tunerSource === 'key' || !st;
  bs.setAttribute('aria-pressed', String(!useKey)); bk.setAttribute('aria-pressed', String(useKey));
  $('#srcRow').hidden = state.tunerRaw;
  const tg = tunerTarget();
  $('#tnTarget').innerHTML = state.tunerRaw ? 'Raw: the nearest note to whatever you play, in cents and Hz.'
    : tg ? `Aiming at <b>${sharpWord(nameOf(tg.m))}</b>, ${freq(tg.m).toFixed(2)} Hz in equal temperament, from ${esc(tg.why)}. Tap any key on the piano to aim there.`
    : 'This step has no single note to aim at, so the tuner shows the nearest note. Tap a key on the piano to aim at it, or go to a tuning step.';
  $('#tnStretch').hidden = !(tg && (tg.m < midiOf('C3') || tg.m > midiOf('C6')));
  $('#tunerCard').dataset.mode = state.tunerRaw ? 'raw' : 'guided';
}
$$('#modeSeg button').forEach((b) => b.addEventListener('click', () => setRaw(b.dataset.raw === '1')));
$('#srcStep').addEventListener('click', () => { state.tunerSource = 'step'; resetLock(); renderTargetPicker(); showTunerScene(); });
$('#srcKey').addEventListener('click', () => { state.tunerSource = 'key'; resetLock(); renderTargetPicker(); showTunerScene(); });
/* Tuner tab: tap a key on the piano to aim the tuner at it (Guided). "Step" in the picker goes back. */
function aimTunerAt(m) {
  state.note = m; state.tunerSource = 'key';
  if (state.tunerRaw) setRaw(false);
  resetLock(); showTunerScene();
  toast('Tuner aiming at ' + sharpWord(nameOf(m)));
}
function resetLock() { lock.smooth = null; lock.since = 0; lock.locked = false; }

/* 3-second pitch trace: cents against time, the green lock band labelled on the band itself.
   Readings past +-20 cents are drawn dashed at the edge, with their value. */
const traceCv = $('#trace');
function drawTrace(now = performance.now()) {
  const cv = traceCv; const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const y = (c) => h / 2 - (Math.max(-TRACE_C, Math.min(TRACE_C, c)) / TRACE_C) * (h / 2 - 4);
  g.fillStyle = 'rgba(14,115,64,.16)'; g.fillRect(0, y(LOCK_IN), w, y(-LOCK_IN) - y(LOCK_IN));
  g.strokeStyle = 'rgba(14,115,64,.75)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, h / 2 + .5); g.lineTo(w, h / 2 + .5); g.stroke();
  g.font = '400 13px "Geist Mono", monospace';
  g.fillStyle = '#545454'; g.textBaseline = 'top'; g.fillText('+' + TRACE_C + ' c', 4, 2); g.textBaseline = 'bottom'; g.fillText('−' + TRACE_C + ' c', 4, h - 1);
  g.fillStyle = '#0e7340'; g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillText('±1.5 c', w - 4, y(LOCK_IN) - 1); g.textAlign = 'left';
  while (trace.length && now - trace[0].t > TRACE_S * 1000) trace.shift();
  g.strokeStyle = '#141414'; g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round';
  const lastP = trace.length ? trace[trace.length - 1] : null;
  const label = (txt, x, yy, align, base, color) => {
    g.textAlign = align; g.textBaseline = base; const tw = g.measureText(txt).width;
    const bx = align === 'right' ? x - tw : x, by = base === 'top' ? yy : yy - 13;
    g.fillStyle = 'rgba(255,255,255,.88)'; g.fillRect(bx - 2, by - 1, tw + 4, 15); g.fillStyle = color; g.fillText(txt, x, yy);
  };
  // axis and band labels go UNDER the line (drawn first), so they never hide data
  const hiOut = lastP && lastP.c != null && lastP.c > TRACE_C;
  g.save(); g.globalAlpha = 0.9;
  label('+' + TRACE_C + ' c', 4, 2, 'left', 'top', '#545454');
  label('−' + TRACE_C + ' c', 4, h - 1, 'left', 'bottom', '#545454');
  label('±1.5 c', w - 4, hiOut ? y(-LOCK_IN) + 1 : y(LOCK_IN) - 1, 'right', hiOut ? 'top' : 'bottom', '#0e7340');
  g.restore();
  // split into runs: break at gaps, and switch between solid and dashed (off-scale) pieces
  let run = null; const runs = [];
  for (const p of trace) {
    if (p.c == null) { run = null; continue; }
    const pt = { x: w - ((now - p.t) / (TRACE_S * 1000)) * w, c: p.c, out: Math.abs(p.c) > TRACE_C };
    if (!run || run.out !== pt.out) { const prev = run && run.pts[run.pts.length - 1]; run = { out: pt.out, pts: prev ? [prev] : [] }; runs.push(run); }
    run.pts.push(pt);
  }
  for (const r of runs) {
    if (r.pts.length < 2) continue;
    g.setLineDash(r.out ? [3, 3] : []); g.beginPath(); g.moveTo(r.pts[0].x, y(r.pts[0].c));
    for (const q of r.pts.slice(1)) g.lineTo(q.x, y(q.c));
    g.stroke();
  }
  g.setLineDash([]);
  if (lastP && lastP.c != null && Math.abs(lastP.c) > TRACE_C) label((lastP.c > 0 ? '+' : '−') + Math.abs(lastP.c).toFixed(0) + ' c', w - 4, lastP.c > 0 ? 8 : h - 8, 'right', lastP.c > 0 ? 'top' : 'bottom', '#141414');
  g.textAlign = 'left';
}
window.addEventListener('resize', () => drawTrace());

function wrongNote(heard, tg) {
  const d = heard - tg.m, H = sharpWord(nameOf(heard)), T = sharpWord(nameOf(tg.m));
  const oct = d % 12 === 0 ? `, ${Math.abs(d) === 12 ? 'an octave' : Math.abs(d) / 12 + ' octaves'} ${d > 0 ? 'above' : 'below'}` : '';
  return `You're playing ${H}${oct}. ${tg.src === 'step' ? 'This step wants' : 'You picked'} ${T}.`;
}
function tunerStatus(st, c, tg, heard) {
  $('#tunerCard').dataset.status = st; $('#tbar').dataset.status = st;
  const abs = Math.abs(c);
  const raw = state.tunerRaw || !tg;
  let dir;
  if (st === 'wrong') dir = wrongNote(heard, tg);
  else if (st === 'locked') dir = raw ? 'In tune.' : 'Locked in. Now count the wobble by ear.';
  else if (st === 'settling') dir = 'Hold it there…';
  else if (c < 0) dir = raw ? 'Flat' : '↑ Turn up' + (abs <= 10 ? ' a hair' : '') + ' (clockwise)';
  else dir = raw ? 'Sharp' : '↓ Turn down' + (abs <= 10 ? ' a hair' : '') + ' (counter-clockwise)';
  $('#tnDir').textContent = dir;
  $('#tbDir').textContent = st === 'wrong' ? 'play ' + sharpWord(nameOf(tg.m)) : st === 'locked' ? (raw ? 'in tune' : 'locked in') : st === 'settling' ? 'hold…' : raw ? (c < 0 ? 'flat' : 'sharp') : c < 0 ? '↑ turn up' : '↓ turn down';
  $('#tnCents').textContent = st === 'wrong' ? '–' : (c >= 0 ? '+' : '−') + abs.toFixed(1) + ' cents';
  $('#tbCents').textContent = st === 'wrong' ? '' : (c >= 0 ? '+' : '−') + abs.toFixed(1) + ' c';
}
function onReading(r) {
  const now = performance.now();
  const tg = tunerTarget();
  const key = tg ? 't' + tg.m : 'raw';
  if (key !== lock.key) { lock.key = key; resetLock(); trace.length = 0; }
  if (!r.hz) {
    if (now - lock.lastHeard > 400) {
      resetLock(); $('#tunerCard').dataset.status = 'idle'; $('#tbar').dataset.status = 'idle';
      $('#tnDir').textContent = r.level < -58 ? 'Listening: play the note and let it ring' : 'Listening…'; $('#tbDir').textContent = 'listening';
      trace.push({ t: now, c: null });
    }
    drawTrace(now); return;
  }
  lock.lastHeard = now;
  const heard = r.midi;
  const m = tg ? tg.m : heard;
  const c = 1200 * Math.log2(r.hz / freq(m));
  let st;
  $('#tnNote').textContent = sharpWord(nameOf(m)); $('#tbNote').textContent = sharpWord(nameOf(m));
  $('#tnHz').textContent = tg ? r.hz.toFixed(2) + ' Hz heard' : r.hz.toFixed(2) + ' Hz (' + sharpWord(nameOf(m)) + ' is ' + freq(m).toFixed(2) + ')';
  if (tg && heard !== tg.m && Math.abs(c) > 75) {           // a different key (or an octave off): say so, no needle
    st = 'wrong'; resetLock(); setNeedle(0); trace.push({ t: now, c: null });
  } else {
    lock.smooth = lock.smooth == null || Math.abs(c - lock.smooth) > 30 ? c : lock.smooth + 0.35 * (c - lock.smooth);
    const sc = lock.smooth;
    if (lock.locked) { if (Math.abs(sc) > LOCK_OUT) { lock.locked = false; lock.since = 0; st = Math.abs(sc) <= 10 ? 'near' : 'off'; } else st = 'locked'; }
    else if (Math.abs(sc) <= LOCK_IN) { if (!lock.since) lock.since = now; if (now - lock.since >= LOCK_MS) { lock.locked = true; st = 'locked'; } else st = 'settling'; }
    else { lock.since = 0; st = Math.abs(sc) <= 10 ? 'near' : 'off'; }
    setNeedle(sc); trace.push({ t: now, c: sc });
  }
  tunerStatus(st, lock.smooth == null ? c : lock.smooth, tg, heard);
  drawTrace(now);
  window.__lock = { status: st, cents: lock.smooth, target: m, heard, raw: state.tunerRaw };
  if (state.tab === 'tuner' && heard >= LOW && heard <= HIGH && heard !== state.tunerHeard) { state.tunerHeard = heard; showTunerScene(); }
}
function setTunerUi(on) {
  const btn = $('#tunerBtn'); btn.classList.toggle('stop', on); btn.querySelector('span').textContent = on ? 'Stop tuner' : 'Start tuner';
  $$('[data-mic]').forEach((b) => { b.style.minWidth = on ? b.offsetWidth + 'px' : ''; b.classList.toggle('on', on); const sp = b.querySelector('span'); if (sp) sp.textContent = on ? 'Stop mic' : (b.dataset.label || 'Tune with mic'); });
  $('#tbar').hidden = !on || state.tab === 'tuner';
  $('#tunerCard').dataset.status = on ? 'idle' : 'off-mic';
  if (!on) { setNeedle(0); $('#tnNote').textContent = '–'; $('#tbNote').textContent = '–'; $('#tnCents').textContent = '–'; $('#tnDir').textContent = 'Tap Start, then play the note'; $('#tnHz').textContent = ''; trace.length = 0; drawTrace(); }
}
function tunerMsg(text, err = false) { const el = $('#tunerMsg'); el.textContent = text; el.classList.toggle('err', err); }
async function startTuner() {
  const btn = $('#tunerBtn');
  try {
    btn.disabled = true; tunerMsg('Asking for the microphone…');
    await tuner.start();
    resetLock(); setTunerUi(true);
    tunerMsg('Listening. The mic stays on until you tap Stop (it also stops if you leave the page).');
    $('#tnDir').textContent = 'Listening: play the note and let it ring';
  } catch (err) {
    tunerMsg((err && err.name === 'NotAllowedError') ? 'Microphone blocked. Allow it for this site in your browser settings, then try again.' : 'Could not start the microphone: ' + (err && err.message ? err.message : err), true);
    if (state.tab !== 'tuner') toast('Microphone not available');
  } finally { btn.disabled = false; }
}
function stopTuner() {
  tuner.stop(); setTunerUi(false);
  tunerMsg('Microphone off. It is used only while the tuner runs, only on this device. Nothing is recorded or sent.');
}
$('#tunerBtn').addEventListener('click', () => (tuner.running ? stopTuner() : startTuner()));
$('#tbStop').addEventListener('click', stopTuner);
$('#tbOpen').addEventListener('click', () => setTab('tuner'));
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-mic]'); if (!b) return;
  if (tuner.running) { stopTuner(); return; }
  state.tunerSource = b.dataset.mic; if (state.tunerRaw) setRaw(false); else renderTargetPicker();
  resetLock(); startTuner();
});
document.addEventListener('visibilitychange', () => { if (document.hidden && tuner.running) stopTuner(); });
function showTunerScene() {
  renderTargetPicker();
  const tg = tunerTarget();
  const heard = state.tunerHeard;
  const m = tg ? tg.m : heard || midiOf('A4');
  scene.setHighlights({ tune: tg || heard ? [m] : [], done: heard && heard !== m ? [heard] : [], soft: tg || heard ? [] : [midiOf('A4')] });
  scene.setStrip(false); scene.setMute(null);
  state.keysCx = keyX(m);
  labelSpec = [keyLabel(m, sharpWord(nameOf(m)) + (tg ? ' · target' : heard ? ' · heard' : ' = 440 Hz'), tg || heard ? 'tune' : 'note')];
  if (tg && heard && heard !== m && Math.abs(heard - m) < 10) labelSpec.push(keyLabel(heard, sharpWord(nameOf(heard)) + ' · heard', 'note'));
  if (wide()) {
    scene.setAction(true); scene.setLever(m, null, false);
    scene.frame(scene.keyRangeBox(Math.max(LOW, m - 6), Math.min(HIGH, m + 6), { top: 'pins', bottom: 0.64 }), [0.16, 0.30, 1], { inset: insetFor() });
    labelSpec.push(pinLabel(m, sharpWord(nameOf(m)) + ' pin', 'tune'));
  } else {
    scene.setAction(false); scene.setLever(null);
    const hw = keysHalfWidth();
    scene.frame(new THREE.Box3(new THREE.Vector3(state.keysCx - hw, 0.66, -0.16), new THREE.Vector3(state.keysCx + hw, 0.73, 0.02)), [0, 1.6, 1], { pad: 1, inset: { top: 4, bottom: 30 } });
  }
  $('#replay').hidden = true;
  requestAnimationFrame(() => drawTrace());
}

/* ---------- learn ---------- */
const learnDemos = {
  beat: { type: 'beats', hz: 440, off: 2 },
  fifth: { type: 'interval', lo: 'F3', hi: 'C4', kind: 'P5', target: 'C4' },
  third: { type: 'interval', lo: 'C4', hi: 'E4', kind: 'M3', target: 'E4' },
};
let learnBuilt = false;
function showLearn() {
  if (!learnBuilt) buildLearn();
  scene.setAction(true);
  scene.setHighlights({ soft: rangeM('F3', 'F4') }); scene.setLever(null); scene.setStrip(false); scene.setMute(null);
  scene.frame(scene.keyRangeBox(midiOf('E3'), midiOf('A4'), { top: 'pins', bottom: 0.64 }), [0.16, 0.3, 1], { inset: insetFor() });
  labelSpec = [keyLabel(midiOf('F3'), 'F3'), keyLabel(midiOf('F4'), 'F4')];
  $('#replay').hidden = true;
}
function gotoLearn(section, anchor) {
  setTab('learn');
  requestAnimationFrame(() => {
    const d = document.getElementById('learn-' + section);
    if (d && d.tagName === 'DETAILS') d.open = true;
    const t = (anchor && document.getElementById(anchor)) || d;
    if (t) t.scrollIntoView({ block: 'start' });
  });
}
function buildLearn() {
  learnBuilt = true;
  const rows = temperamentTable();
  const maxDiff = Math.max(...PUBLISHED.map(([a, b, k, v]) => Math.abs(beat(midiOf(a), k, midiOf(b)).rate - v)));
  const demo = (k, label, stateTxt) => `<div class="demo"><button class="btn hear" type="button" data-demo="${k}" data-label="${label}">${ICO_SPK}<span>${label}</span></button><span class="light" data-light aria-hidden="true"></span><span class="demo-state" data-state>${stateTxt}</span></div>`;
  $('#learnCard').innerHTML = `<div class="learn">
  <p class="eyebrow">Learn</p><h2 class="title">How tuning by ear works</h2>
  <p class="lead">${rich('You never tune a note on its own. You tune it against a note that is already right, and you listen to the [[beat|wobble]] the two make together.')}</p>
  <h3 id="learn-beat">A beat is a wobble</h3>
  <p>${rich('Two pitches that are close but not equal drift in and out of step, so the sound swells and fades: wah, wah, wah. The number of swells per second is exactly the difference between the two frequencies. 440 against 442 Hz wobbles twice a second; at 440 against 440 it stops. [src:beats]')}</p>
  ${demo('beat', 'Hear a beat', 'Still, then 2 wobbles a second')}
  <h3 id="learn-why">Why not make every interval pure?</h3>
  <p>${rich('A pure [[fifth|5th]] is the ratio 3:2. Go up twelve pure 5ths and you should land on the same note seven octaves up, but you overshoot by about a quarter of a semitone (23.5 [[cents]], the Pythagorean comma). And three pure [[third|major 3rds]] fall about 41 cents short of an octave. So pure 5ths, pure 3rds and pure octaves cannot all exist together. [src:comma] [src:diesis] [src:iu-comma]')}</p>
  <p>${rich('[[et|Equal temperament]] keeps the octaves clean and shares the error out evenly: every 5th a hair [[narrow]] (about 2 cents), every 4th a hair [[wide]], and every major 3rd quite wide (about 14 cents). No key is better or worse than another, which is why almost all pianos are tuned this way. [src:wiki-tuning]')}</p>
  ${demo('fifth', 'Hear a 5th', 'F3+C4: pure, then as tuned (about 3 wobbles in 5 seconds)')}
  ${demo('third', 'Hear a 3rd', 'C4+E4: pure, then as tuned (about 10 a second)')}
  <h3 id="learn-method">The method in one breath</h3>
  <p>${rich('Set A4 to 440. Tune the middle octave (the [[tempoct|temperament octave]], F3 to F4) with 4ths and 5ths set to a slow wobble, using the fast 3rds and 6ths to check. Make each note\'s strings agree ([[unison|unisons]]). Then copy the octave outward, one still octave at a time, with a couple of checks for each new note. Technicians differ in the details (the order, how wide, which checks); this guide uses one classic, well-checked route. [src:white] [src:iu-et] [src:wiki-tuning]')}</p>
  <h3 id="learn-count">Counting slow wobbles</h3>
  <p>${rich('Count for 5 seconds against a clock. 3 wobbles is 0.6 a second, 5 is 1 a second. Fast 3rds (7 to 11 a second) are too quick to count one by one: compare them with the 3rd next door instead. A metronome helps you learn the speeds.')}</p>
  <details class="curious" id="learn-words"><summary>Words, in plain English (${Object.keys(GLOSSARY).length}) ${ICON_DOWN}</summary><div class="in">
    <ul class="gloss">${Object.entries(GLOSSARY).map(([k, [t, d]]) => `<li id="term-${k}"><b>${esc(t)}</b><span>${esc(d)}</span></li>`).join('')}</ul>
  </div></details>
  <details class="curious" id="learn-table"><summary>For the curious: the beat-rate table ${ICON_DOWN}</summary><div class="in">
    <p>${rich('Beats per second for the 4th, 5th, major 3rd and major 6th above each note of the temperament octave, in ideal equal temperament at A4 = 440 Hz. Tap a note to hear its 3rd.')}</p>
    <div class="tbl-wrap"><table class="rates"><thead>
      <tr class="span"><th></th><th></th><th colspan="4">beats per second</th></tr>
      <tr><th>Note</th><th>Hz</th><th>4th up<small>wide</small></th><th>5th up<small>narrow</small></th><th>M3 up<small>wide</small></th><th>M6 up<small>wide</small></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><button class="rowbtn" type="button" data-row="${r.m}" aria-label="Play the 3rd ${pairTxt({ lo: r.m, hi: r.m + 4 })}">${sharpWord(r.name)}</button></td><td>${r.hz.toFixed(2)}</td><td>${fmtRate(r.P4.rate)}</td><td>${fmtRate(r.P5.rate)}</td><td>${fmtRate(r.M3.rate)}</td><td>${fmtRate(r.M6.rate)}</td></tr>`).join('')}
    </tbody></table></div>
    <p>${rich('How it is computed: each note\'s frequency is 440 × 2^((n − 69) / 12). A beat comes from the two [[partial|partials]] that nearly coincide: the 3rd partial of the lower note against the 2nd of the upper for a 5th, 4th against 3rd for a 4th, 5th against 4th for a major 3rd, 5th against 3rd for a major 6th. The beat rate is their difference.')}</p>
    <p class="xcheck">${rich('Cross-check: ' + PUBLISHED.length + ' values from two published tables (US Patent 8,569,607 Fig. 4 and Wikipedia\'s equal-temperament table) agree with these to within ' + maxDiff.toFixed(3) + ' beats per second. [src:patent] [src:wiki-tuning] [src:guinn]')}</p>
    <p>${rich('Why "approximately": real piano wire is stiff ([[inharm|inharmonicity]]), so its partials run a little sharp. Clean octaves come out slightly wide ([[stretch]]) and the real beat rates drift from these ideal ones, more so on small uprights. Technicians treat the numbers as a guide and the smooth progression of 3rds as the real test. [src:railsback] [src:bremmer] [src:pianometer]')}</p>
  </div></details>
  <details class="curious" id="learn-sources"><summary>Sources (${SOURCES.length}) ${ICON_DOWN}</summary><div class="in">
    <p class="fine">Links checked October 2026.</p>
    <ol class="srclist">${SOURCES.map((s) => `<li id="src-${s.id}"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.t)}</a> · ${esc(s.by)}<span>${esc(s.why)}</span></li>`).join('')}</ol>
  </div></details>
  <h3 id="learn-about">About this guide</h3>
  <p>${rich('Rates are computed in the page from equal-temperament frequencies; the steps, the Keys tab and the table all read the same data, so they agree. The 3D piano is a simplified diagram, not a model of your piano: always follow the string from the hammer to its pin. Open source (MIT):')} <a href="${REPO}" target="_blank" rel="noopener">${REPO.replace('https://', '')}</a>.</p>
  <p class="fine">Not a substitute for a technician when a piano is far flat, has loose pins or rusty strings.</p>
  </div>`;
}
function tableRow(btn) {
  const m = Number(btn.dataset.row);
  $$('table.rates tr').forEach((r) => r.classList.toggle('now', r.contains(btn)));
  scene.setHighlights({ ref: [m], tune: [m + 4], soft: rangeM('F3', 'F4') });
  audio.stopAll(); setPlaying(null, false);
  const ph = phasesFor({ type: 'check', lo: nameOf(m), hi: nameOf(m + 4), kind: 'M3' });
  audio.playPhases(ph, { onPhase: (i, p) => { if (p) scene.holdKeys(p.dur * 1000, p.notes); } });
}

/* ---------- sheet (glossary, sources, step list): a bottom sheet you can drag down ---------- */
let sheetReturn = null;
let sheetT = 0;
function openSheet(title, html, from) {
  clearTimeout(sheetT);
  sheetReturn = from || document.activeElement;
  $('#sheetTitle').textContent = title; $('#sheetBody').innerHTML = html;
  const sh = $('#sheet'), sc = $('#scrim');
  sh.classList.remove('closing'); sh.style.transform = ''; sh.style.removeProperty('--dy');
  sh.hidden = false; sc.hidden = false; $('#app').inert = true;
  requestAnimationFrame(() => { sh.classList.add('on'); sc.classList.add('on'); sh.focus({ preventScroll: true }); });
}
function closeSheet() {
  const sh = $('#sheet'), sc = $('#scrim'); if (sh.hidden || sh.classList.contains('closing')) return;
  clearTimeout(sheetT);
  sh.classList.add('closing'); sh.classList.remove('on'); sc.classList.remove('on'); sh.style.transform = '';
  $('#app').inert = false;
  sheetT = setTimeout(() => { sh.hidden = true; sc.hidden = true; sh.classList.remove('closing'); sh.style.removeProperty('--dy'); }, 200);
  if (sheetReturn && sheetReturn.focus) sheetReturn.focus({ preventScroll: true });
}
$('#sheetClose').addEventListener('click', closeSheet);
$('#scrim').addEventListener('click', closeSheet);
(function sheetDrag() {
  const sh = $('#sheet'); let d = null;
  const start = (e) => { if (wide() || e.target.closest('.close')) return; d = { y0: e.clientY, t0: e.timeStamp, id: e.pointerId }; sh.classList.add('drag'); try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } };
  const move = (e) => { if (!d || e.pointerId !== d.id) return; const dy = Math.max(0, e.clientY - d.y0); sh.style.transform = `translateY(${dy}px)`; };
  const end = (e) => { if (!d || e.pointerId !== d.id) return; const dy = Math.max(0, e.clientY - d.y0), v = dy / Math.max(1, e.timeStamp - d.t0); sh.classList.remove('drag'); d = null; if (dy > 120 || v > 0.5) { sh.style.setProperty('--dy', dy + 'px'); closeSheet(); } else sh.style.transform = ''; };
  for (const el of [$('.grab'), $('.sheet-head')]) { el.addEventListener('pointerdown', start); el.addEventListener('pointermove', move); el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); }
})();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSheet(); return; }
  if (!$('#sheet').hidden || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const d = e.key === 'ArrowRight' ? 1 : -1;
    const tl = e.target.closest && e.target.closest('[role=tablist]');
    if (tl) { const t = [...tl.querySelectorAll('[role=tab]')]; const n = t[(t.indexOf(e.target) + d + t.length) % t.length]; n.focus(); setTab(n.dataset.tab); return; }
    if (state.tab === 'steps') showStep(state.step + d);
    else if (state.tab === 'keys') showNote(state.note + d, { recenter: true, ms: 250 });
  }
});
function openTerm(k, from) {
  const g = GLOSSARY[k]; if (!g) return;
  openSheet(g[0], `<p>${esc(g[1])}</p><button class="linkbtn" type="button" data-goto-learn="words" data-anchor="term-${k}">All words ${ICON_GO}</button>`, from);
}
function openSource(ids, from) {
  const list = String(ids).split(' ').map((id) => SOURCES.find((x) => x.id === id)).filter(Boolean); if (!list.length) return;
  openSheet(list.length > 1 ? 'Sources ' + list.map((s) => srcNo(s.id)).join(', ') : 'Source ' + srcNo(list[0].id),
    list.map((s) => `<p><b>${esc(s.t)}</b><br><span class="kind">${esc(s.by)}</span></p><p>${esc(s.why)}. <a class="linkbtn" href="${esc(s.url)}" target="_blank" rel="noopener">Open the page ${ICON_GO}</a></p>`).join(''), from);
}
function openStepList(e) {
  let h = '<ul class="steplist">', ch = null;
  for (const s of STEPS) {
    if (s.chapter !== ch) { ch = s.chapter; h += `<li class="ch">${esc(ch)}</li>`; }
    h += `<li><button type="button" data-goto-step="${s.n}" ${s.n - 1 === state.step ? 'aria-current="step"' : ''}><span class="n">${s.n}</span><span>${rich(s.title)}</span></button></li>`;
  }
  openSheet('All steps', h + '</ul>', e.currentTarget);
  requestAnimationFrame(() => { const cur = $('#sheetBody [aria-current="step"]'); if (cur) cur.scrollIntoView({ block: 'center' }); });
}
$('#stepCount').addEventListener('click', openStepList);
$('#stepCount2').addEventListener('click', openStepList);
$('#sheetBody').addEventListener('click', (e) => { if (e.target.closest('[data-goto-step], [data-goto-learn]')) closeSheet(); });

/* ---------- gestures on the 3D stage ---------- */
const canvas = $('#c');
let g = null;
const panMode = () => (state.tab === 'keys' || state.tab === 'tuner') && !wide();
canvas.addEventListener('pointerdown', (e) => {
  if (g) { g.multi = true; return; }
  g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, lx: e.clientX, ly: e.clientY, mode: 'pending', az0: scene.user.az, el0: scene.user.el };
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
});
canvas.addEventListener('pointermove', (e) => {
  if (!g || e.pointerId !== g.id) return;
  const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
  if (g.mode === 'pending' && Math.hypot(dx, dy) > 10) {
    if (panMode()) g.mode = 'pan';
    else if (state.tab === 'steps') { const v = Math.hypot(dx, dy) / Math.max(1, e.timeStamp - g.t0); g.mode = (Math.abs(dx) > 1.4 * Math.abs(dy) && v > 0.35) ? 'swipe' : 'orbit'; } // px per ms: a flick, not a drag
    else g.mode = 'orbit';
  }
  if (g.mode === 'orbit') scene.setUser({ az: Math.max(-0.55, Math.min(0.55, g.az0 - dx / 300)), el: Math.max(-0.2, Math.min(0.35, g.el0 + dy / 400)) });
  if (g.mode === 'pan') { state.keysCx -= (e.clientX - g.lx) / scene.pxPerMetre(); frameKeys(true); }
  g.lx = e.clientX; g.ly = e.clientY;
});
function endGesture(e) {
  if (!g || e.pointerId !== g.id) return;
  const dx = e.clientX - g.x0, dt = e.timeStamp - g.t0;
  if (g.mode === 'pending' && !g.multi && dt < 600) {
    const r = canvas.getBoundingClientRect(); const m = scene.pick(e.clientX - r.left, e.clientY - r.top);
    if (m != null) { scene.pressKey(m); if (state.tab === 'keys') showNote(m, { ms: 250 }); else if (state.tab === 'tuner') aimTunerAt(m); else if (state.tab === 'steps') { toast('Showing ' + sharpWord(nameOf(m)) + ' in Keys'); openNote(m); } }
  } else if (g.mode === 'swipe' && Math.abs(dx) > 40) showStep(state.step + (dx < 0 ? 1 : -1));
  g = null;
}
canvas.addEventListener('pointerup', endGesture);
canvas.addEventListener('pointercancel', () => { g = null; });
canvas.addEventListener('wheel', (e) => { if (!panMode()) return; e.preventDefault(); state.keysCx += (e.deltaX || e.deltaY) / scene.pxPerMetre(); frameKeys(true); }, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

let toastT = 0;
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 1600); }

/* ---------- start ---------- */
function route() {
  const h = location.hash.replace(/^#/, '').split('&')[0];
  let m;
  if ((m = /^step-(\d+)$/.exec(h))) { state.step = Math.max(0, Math.min(STEPS.length - 1, Number(m[1]) - 1)); setTab('steps', { push: false }); }
  else if ((m = /^note-([A-G]s?-?\d)$/.exec(h))) { try { state.note = fromUrlNote(m[1]); } catch (e) { /* bad note */ } state.keysCx = keyX(state.note); setTab('keys', { push: false }); }
  else if (h === 'tuner' || h === 'learn' || h === 'keys') setTab(h, { push: false });
  else if (/^(term|src)-/.test(h)) gotoLearn(h.startsWith('term') ? 'words' : 'sources', h);
  else {
    let st = 0, tab = 'steps';
    try { st = Number(localStorage.getItem('ptg.step') || 0); tab = localStorage.getItem('ptg.tab') || 'steps'; } catch (e) { /* private mode */ }
    state.step = isFinite(st) ? st : 0; setTab(tab === 'tuner' ? 'steps' : tab, { push: false });
  }
}
$$('[data-srcs]').forEach((el) => { el.outerHTML = srcChip(el.dataset.srcs.split(' ')); });
state.tab = null;
route();
window.addEventListener('hashchange', route);
scene.resize();
window.addEventListener('resize', () => { scene.resize(); scene.instantOnce = true; if (state.tab === 'keys') showNote(state.note, { push: false }); else if (state.tab === 'steps') sceneForStep(STEPS[state.step]); else if (state.tab === 'tuner') showTunerScene(); else if (state.tab === 'learn') showLearn(); });
if ('serviceWorker' in navigator && window.isSecureContext && !STILL) navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
window.__app = { state, showStep, showNote, setTab, PLAN, phasesFor, renderOffline: audio.renderOffline, midiOf, nameOf };
document.documentElement.dataset.ready = '1';

// --- mobile baseline: no iOS selection / long-press magnifier on the app chrome,
// and touches on the canvases go to the pointer gestures rather than the browser.
document.addEventListener('selectstart', (e) => { if (!(e.target.closest && e.target.closest('input, textarea, .selectable'))) e.preventDefault(); });
document.addEventListener('contextmenu', (e) => { if (e.target.closest && e.target.closest('canvas, button, .stage')) e.preventDefault(); });
for (const cv of document.querySelectorAll('#c')) {   // the 3D stage only: #trace sits in a scrolling card
  ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach((ev) => cv.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
}
