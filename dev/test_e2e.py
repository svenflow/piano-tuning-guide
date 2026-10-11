#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.47", "numpy>=1.26"]
# ///
"""End-to-end tests in real Chrome (Playwright, channel "chrome").

Usage: dev/test_e2e.py BASE_URL [--only NAME]
Serve the repo first, e.g.  uv run python -m http.server 8791 --bind 127.0.0.1
Prints PASS/FAIL per check and exits 1 on any failure.
"""
import argparse, asyncio, base64, json, sys
import numpy as np
from playwright.async_api import async_playwright

RESULTS = []
def check(cond, name, detail=""):
    RESULTS.append((bool(cond), name, detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)

# Wraps every microphone-related API so the test can see whether the page touched it.
MIC_SPY = """
window.__mic = [];
(() => {
  const note = (n) => window.__mic.push({ name: n, t: performance.now() });
  const md = navigator.mediaDevices;
  if (md) {
    const gum = md.getUserMedia && md.getUserMedia.bind(md);
    md.getUserMedia = (c) => { note('getUserMedia'); return window.__fakeMic ? window.__fakeMic(c) : gum(c); };
    if (md.enumerateDevices) { const ed = md.enumerateDevices.bind(md); md.enumerateDevices = () => { note('enumerateDevices'); return ed(); }; }
  }
  if (navigator.permissions && navigator.permissions.query) { const q = navigator.permissions.query.bind(navigator.permissions); navigator.permissions.query = (d) => { if (d && /micro|camera/.test(d.name)) note('permissions.query'); return q(d); }; }
  for (const k of ['getUserMedia', 'webkitGetUserMedia']) if (navigator[k]) { const f = navigator[k].bind(navigator); navigator[k] = (...a) => { note(k); return f(...a); }; }
})();
"""
# A fake microphone: an oscillator with harmonics, frequency set by window.__fakeHz.
FAKE_MIC = """
window.__fakeHz = 440;
window.__fakeMic = async () => {
  const ac = new AudioContext();
  const o = ac.createOscillator();
  const re = new Float32Array(9), im = new Float32Array(9); for (let k = 1; k <= 8; k++) im[k] = 1 / k;
  o.setPeriodicWave(ac.createPeriodicWave(re, im)); o.frequency.value = window.__fakeHz;
  const g = ac.createGain(); g.gain.value = 0.5;
  const d = ac.createMediaStreamDestination(); o.connect(g); g.connect(d); o.start();
  window.__fakeCtl = { o, ac, stream: d.stream };
  return d.stream;
};
"""
LAUNCH = ["--autoplay-policy=no-user-gesture-required", "--enable-gpu", "--ignore-gpu-blocklist"]

async def ready(page):
    await page.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=20000)

def collect(page, bucket, tag):
    page.on("console", lambda m: bucket.append(f"[{tag}] console.{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: bucket.append(f"[{tag}] pageerror: {e}"))
    page.on("requestfailed", lambda r: bucket.append(f"[{tag}] requestfailed: {r.url} {r.failure}"))
    page.on("response", lambda r: bucket.append(f"[{tag}] HTTP {r.status}: {r.url}") if r.status >= 400 else None)

async def phone(b, **kw):
    return await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, **kw)

async def desktop(b, **kw):
    return await b.new_context(viewport={"width": 1440, "height": 900}, **kw)

# ---------------------------------------------------------------- tests
async def t_load_and_errors(b, base):
    for mk, tag in ((phone, "390"), (desktop, "1440")):
        ctx = await mk(b); page = await ctx.new_page(); errs = []; collect(page, errs, tag)
        await page.add_init_script(MIC_SPY)
        await page.goto(base + "#step-1"); await ready(page)
        for tab in ("steps", "keys", "tuner", "learn", "steps"):
            sel = f".tabbar [data-tab={tab}]" if tag == "390" else f".seg [data-tab={tab}]"
            await page.click(sel); await page.wait_for_timeout(350)
        await page.click("#next"); await page.wait_for_timeout(300)
        mic = await page.evaluate("window.__mic")
        check(not errs, f"{tag}: no console errors, page errors or failed requests across all tabs", "; ".join(errs)[:400])
        check(mic == [], f"{tag}: no microphone API touched on load or while visiting every tab (Tuner tab included)", json.dumps(mic))
        await ctx.close()

async def t_mic_only_on_tap(b, base):
    ctx = await phone(b); page = await ctx.new_page()
    await page.add_init_script(MIC_SPY); await page.add_init_script(FAKE_MIC)
    await page.goto(base + "#tuner"); await ready(page)
    await page.wait_for_timeout(500)
    before = await page.evaluate("window.__mic.length")
    await page.click("#tunerBtn"); await page.wait_for_timeout(600)
    after = await page.evaluate("window.__mic.map(x => x.name)")
    check(before == 0 and after == ["getUserMedia"], "getUserMedia is called once, only after tapping Start tuner (positive control)", f"before={before} after={after}")
    await page.click("#tunerBtn"); await page.wait_for_timeout(200)
    ended = await page.evaluate("window.__tuner.lastStream.getTracks().map(t => t.readyState)")
    check(ended and all(s == "ended" for s in ended), "Stop tuner ends every mic track", str(ended))
    await ctx.close()

async def reading(page, hz, wait=1400):
    await page.evaluate(f"window.__fakeCtl.o.frequency.value = {hz}")
    await page.wait_for_timeout(wait)
    return await page.evaluate("({lock: window.__lock, note: document.querySelector('#tnNote').textContent, cents: document.querySelector('#tnCents').textContent, dir: document.querySelector('#tnDir').textContent, status: document.querySelector('#tunerCard').dataset.status, bar: document.querySelector('#tbar').dataset.status, barHidden: document.querySelector('#tbar').hidden})")

async def t_tuner_targets(b, base):
    ctx = await phone(b); page = await ctx.new_page()
    await page.add_init_script(MIC_SPY); await page.add_init_script(FAKE_MIC)
    await page.goto(base + "#step-9"); await ready(page)   # step 9 tunes D4
    d4 = 440 * 2 ** ((62 - 69) / 12)
    await page.evaluate(f"window.__fakeHz = {d4 * 2 ** (-3 / 1200)}")
    await page.click("[data-mic=step]"); await page.wait_for_timeout(1500)
    r = await reading(page, d4 * 2 ** (-3 / 1200))
    check(r["lock"]["target"] == 62 and r["bar"] == "near" and not r["barHidden"], "step 9: the tuner aims at D4 and the bar shows amber when 3 cents flat", json.dumps(r["lock"]))
    check(abs(r["lock"]["cents"] + 3) < 0.3, "D4 -3 cents reads -3 (+-0.3)", f"{r['lock']['cents']:.2f}")
    await page.click(".tabbar [data-tab=tuner]"); await page.wait_for_timeout(300)
    r = await reading(page, d4 * 2 ** (-3 / 1200), 600)
    check("Turn up" in r["dir"] and r["status"] == "near", "flat -> 'Turn up' arrow, amber", r["dir"])
    r = await reading(page, d4 * 2 ** (20 / 1200))
    check("Turn down" in r["dir"] and r["status"] == "off" and abs(r["lock"]["cents"] - 20) < 0.5, "20 cents sharp -> 'Turn down', red", f"{r['dir']} {r['lock']['cents']:.2f}")
    await page.evaluate(f"window.__fakeCtl.o.frequency.value = {d4 * 2 ** (0.4 / 1200)}")
    seen = []
    for _ in range(30):
        await page.wait_for_timeout(50); seen.append(await page.evaluate("window.__lock.status"))
    first_lock = seen.index("locked") if "locked" in seen else None
    settle_ms = None
    if first_lock is not None and "settling" in seen[:first_lock]:
        settle_ms = (first_lock - seen.index("settling")) * 50
    check(first_lock is not None and settle_ms is not None and settle_ms >= 400, "within 1.5 cents: 'hold it' first, green lock only after about half a second", f"{seen[:first_lock + 1] if first_lock else seen} settle {settle_ms} ms")
    flick = seen[first_lock:] if first_lock is not None else []
    check(flick and all(x == "locked" for x in flick), "once locked it does not flicker", str(flick))
    r = await reading(page, d4 * 2 ** (2.0 / 1200), 900)
    check(r["lock"]["status"] == "locked", "hysteresis: 2.0 cents stays locked (releases only past 2.5)", r["lock"]["status"])
    r = await reading(page, d4 * 2 ** (4 / 1200), 900)
    check(r["lock"]["status"] == "near", "4 cents sharp releases the lock (amber)", r["lock"]["status"])
    r = await reading(page, 440 * 2 ** ((64 - 69) / 12))
    check(r["status"] == "wrong" and r["dir"] == "You're playing E4. This step wants D4.", "Guided, wrong key: says which note you are on (not a red 'off')", r["dir"])
    r = await reading(page, d4 * 2)
    check(r["status"] == "wrong" and "an octave above" in r["dir"], "Guided, an octave off: says so", r["dir"])
    r = await reading(page, d4 * 2 ** (-70 / 1200))
    check(r["status"] == "off" and "Turn up" in r["dir"], "70 cents flat on the right key is still 'turn up' (red), not 'wrong key'", r["dir"])
    # Raw mode: nearest note, cents and Hz, and the choice is remembered
    await page.click("#modeSeg [data-raw='1']"); await page.wait_for_timeout(200)
    r = await reading(page, 440 * 2 ** (19.6 / 1200))
    hz = await page.evaluate("document.querySelector('#tnHz').textContent")
    check(r["note"] == "A4" and abs(r["lock"]["cents"] - 19.6) < 0.4 and "445" in hz, "Raw mode: 445.1 Hz reads A4 +19.6 cents and shows Hz", f"{r['note']} {r['lock']['cents']:.2f} | {hz}")
    px = await page.evaluate("(() => { const c = document.querySelector('#trace'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let ink = 0, green = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 200 && d[i] < 60 && d[i + 1] < 60) ink++; if (d[i + 1] > d[i] + 20 && d[i + 3] > 20) green++; } return [ink, green]; })()")
    check(px[0] > 50 and px[1] > 50, "the 3-second trace draws the pitch line and the green band", str(px))
    stored = await page.evaluate("localStorage.getItem('ptg.tunerRaw')")
    check(stored == "1", "Raw choice is saved", str(stored))
    await page.click("#modeSeg [data-raw='0']"); await page.wait_for_timeout(150)
    await page.evaluate("window.__app.showNote(58)")  # A#3 picked in Keys
    await page.click("#srcKey"); await page.wait_for_timeout(200)
    r = await reading(page, 440 * 2 ** ((58 - 69) / 12) * 2 ** (-0.2 / 1200), 1500)
    check(r["lock"]["target"] == 58 and r["lock"]["status"] == "locked", "key mode: A#3 is the target and locks", json.dumps(r["lock"]))
    # low and high notes through the same path
    for m, cents in ((33, 0.0), (45, 7.0), (96, -5.0), (105, 3.0)):
        await page.evaluate(f"window.__app.showNote({m})"); await page.click("#srcKey")
        r = await reading(page, 440 * 2 ** ((m - 69) / 12) * 2 ** (cents / 1200), 1600)
        check(r["lock"]["target"] == m and abs(r["lock"]["cents"] - cents) < 1.0, f"key {m}: reads {cents:+} cents (+-1)", f"{r['lock']['cents']:.2f}")
    await page.click("#tunerBtn"); await page.wait_for_timeout(200)
    check(await page.evaluate("window.__tuner.lastStream.getTracks().every(t => t.readyState === 'ended')"), "stop from the Tuner tab ends the tracks")
    await ctx.close()

async def t_mode_remembered(b, base):
    ctx = await phone(b); page = await ctx.new_page()
    await page.goto(base + "#tuner"); await ready(page)
    await page.click("#modeSeg [data-raw='1']"); await page.reload(); await ready(page)
    st = await page.evaluate("[document.querySelector('#modeSeg [data-raw=\"1\"]').getAttribute('aria-pressed'), document.querySelector('#srcRow').hidden, window.__mic ? 1 : 0]")
    check(st[0] == "true" and st[1] is True, "Raw/Guided choice survives a reload", str(st))
    await ctx.close()

async def t_no_webgl(b_unused, base, pw):
    b = await pw.chromium.launch(channel="chrome", headless=True, args=["--disable-webgl", "--disable-3d-apis"])
    ctx = await phone(b); page = await ctx.new_page(); errs = []; collect(page, errs, "no-webgl")
    await page.goto(base + "#step-9"); await ready(page)
    txt = await page.evaluate("document.querySelector('#stepCard .title').textContent")
    msg = await page.evaluate("!document.querySelector('#no3d').hidden")
    await page.click("#next"); await page.wait_for_timeout(300)
    nxt = await page.evaluate("document.querySelector('#stepCard .title').textContent")
    check(txt.startswith("D4 from A3") and msg and nxt.startswith("G3 from D4"), "without WebGL the steps still work and the stage says why it is empty", f"{txt} -> {nxt}, message {msg}")
    check(not [e for e in errs if "pageerror" in e], "no uncaught errors without WebGL", "; ".join(errs)[:300])
    await ctx.close(); await b.close()

async def t_no_sideways(b, base):
    """No inner panel may scroll sideways (shoot only checks the page width)."""
    for (w, h) in ((320, 568), (390, 844), (844, 390), (1440, 900)):
        mobile = w < 900
        ctx = await b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile)
        page = await ctx.new_page(); await page.goto(base + "#step-1"); await ready(page)
        # no animations, and let the panels scroll sideways again, so real overflow shows up in scrollWidth
        await page.add_style_tag(content="*, *::before, *::after { animation: none !important; transition: none !important; } .scroll { overflow-x: auto !important; }")
        bad = await page.evaluate("""(() => {
          const out = [], over = (sel, tag) => { const e = document.querySelector(sel); if (e && e.scrollWidth > e.clientWidth + 1) out.push(tag + ' ' + e.scrollWidth + '>' + e.clientWidth); };
          const A = window.__app;
          for (let i = 0; i < A.PLAN.steps.length; i++) { A.setTab('steps', { push: false }); A.showStep(i, { push: false }); over('#stepScroll', 'step ' + (i + 1)); }
          A.setTab('keys', { push: false });
          for (const m of [21, 22, 28, 33, 40, 45, 58, 62, 69, 84, 96, 108]) { A.showNote(m, { push: false }); over('#noteScroll', 'note ' + m); }
          A.setTab('learn', { push: false }); document.querySelectorAll('#learnCard details').forEach((d) => (d.open = true)); over('#learnScroll', 'learn');
          A.setTab('tuner', { push: false }); over('#view-tuner .scroll', 'tuner');
          if (document.documentElement.scrollWidth > innerWidth) out.push('page ' + document.documentElement.scrollWidth);
          return out;
        })()""")
        check(bad == [], f"{w}x{h}: no step, key, Learn or Tuner panel scrolls sideways", "; ".join(bad)[:300])
        await ctx.close()

async def t_landscape(b, base):
    ctx = await b.new_context(viewport={"width": 844, "height": 390}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = await ctx.new_page(); await page.goto(base + "#step-9"); await ready(page)
    hgt = await page.evaluate("[document.querySelector('#stepScroll').clientHeight, document.querySelector('#stage').clientWidth]")
    check(hgt[0] > 150 and hgt[1] > 300, "phone landscape: the step card has room (side by side with the 3D)", str(hgt))
    await ctx.close()

async def t_real_fake_device(b_unused, base, pw):
    b = await pw.chromium.launch(channel="chrome", headless=True, args=LAUNCH + ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
    ctx = await phone(b); await ctx.grant_permissions(["microphone"]); page = await ctx.new_page()
    errs = []; collect(page, errs, "fake-device")
    await page.add_init_script(MIC_SPY)
    await page.goto(base + "#step-12"); await ready(page)
    check(await page.evaluate("window.__mic.length") == 0, "real-API run: nothing called before the tap")
    await page.click("[data-mic=step]"); await page.wait_for_timeout(1500)
    live = await page.evaluate("window.__tuner.running && window.__tuner.stream.getTracks().map(t => t.readyState)")
    check(live and all(s == "live" for s in live), "real getUserMedia (Chrome fake device) starts a live track from the step's mic button", str(live))
    await page.click("#next"); await page.wait_for_timeout(400)
    bar = await page.evaluate("[document.querySelector('#tbar').hidden, window.__tuner.running]")
    check(bar == [False, True], "moving to the next step keeps the tuner listening and shows the bar", str(bar))
    await page.click("#tbStop"); await page.wait_for_timeout(300)
    ended = await page.evaluate("window.__tuner.lastStream.getTracks().map(t => t.readyState)")
    check(all(s == "ended" for s in ended) and await page.evaluate("document.querySelector('#tbar').hidden"), "Stop in the bar ends the track and hides the bar", str(ended))
    check(not [e for e in errs if "pageerror" in e or "console.error" in e], "no errors on the real mic path", "; ".join(errs)[:300])
    await ctx.close(); await b.close()

async def t_steps_walk(b, base):
    ctx = await phone(b); page = await ctx.new_page(); errs = []; collect(page, errs, "walk")
    await page.goto(base + "#step-1"); await ready(page)
    plan = await page.evaluate("window.__app.PLAN.steps.map(s => [s.n, s.title.replace(/#/g, '♯')])")
    bad = []; radii = []
    for n, title in plan:
        got = await page.evaluate("[document.querySelector('#stepCard .eyebrow').textContent, document.querySelector('#stepCard .title').textContent, window.__app.state.step]")
        if not (got[0].startswith(f"Step {n} of {len(plan)}") and got[1] == title): bad.append((n, got))
        radii.append(await page.evaluate("window.__scene.view.r"))
        if n < len(plan): await page.click("#next"); await page.wait_for_timeout(950)
    check(not bad and len(plan) == 27, f"Next walks all {len(plan)} steps and each card matches the plan", str(bad)[:300])
    check(len(set(round(r, 3) for r in radii)) >= 6, "the camera reframes between steps", f"{len(set(round(r, 3) for r in radii))} distinct framings")
    check(not errs, "no errors walking the steps", "; ".join(errs)[:300])
    # swipe on the 3D stage with real touch events
    await page.goto(base + "#step-9"); await ready(page); await page.wait_for_timeout(900)
    cdp = await ctx.new_cdp_session(page)
    box = await page.evaluate("(() => { const r = document.querySelector('#c').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
    # CDP timestamps are seconds since the epoch: take them from the page clock, 16 ms apart, so the
    # gesture timing does not depend on how busy the test machine is (timestamps far from the
    # browser clock crash the renderer, so never invent a time base)
    y = box[1] + box[3] * 0.5; x0 = box[0] + box[2] * 0.8
    t0 = await page.evaluate("Date.now() / 1000")
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y}], "timestamp": t0})
    for i in range(1, 7):
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 - i * 40, "y": y}], "timestamp": t0 + i * 0.016})
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": [], "timestamp": t0 + 0.12})
    await page.wait_for_timeout(500)
    check(await page.evaluate("window.__app.state.step") == 9, "a fast left swipe on the 3D stage goes to the next step", str(await page.evaluate("window.__app.state.step + 1")))
    t1 = await page.evaluate("Date.now() / 1000")
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y}], "timestamp": t1})
    for i in range(1, 16):
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 - i * 8, "y": y}], "timestamp": t1 + i * 0.04})
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": [], "timestamp": t1 + 0.66}); await page.wait_for_timeout(300)
    st = await page.evaluate("[window.__app.state.step, window.__scene.user.az]")
    check(st[0] == 9 and abs(st[1]) > 0.1, "a slow drag turns the model instead of the page", str(st))
    await ctx.close()

async def t_pick_a_note(b, base):
    ctx = await phone(b); page = await ctx.new_page()
    await page.goto(base + "#note-A4"); await ready(page); await page.wait_for_timeout(1200)
    got = []
    for m in (69, 70, 67, 66, 72):
        pos = await page.evaluate(f"(() => {{ const s = window.__scene; const p = s.project(s.keyAnchor({m})); const r = document.querySelector('#c').getBoundingClientRect(); return [r.left + p.x, r.top + p.y + 6]; }})()")
        await page.touchscreen.tap(pos[0], pos[1]); await page.wait_for_timeout(250)
        got.append((m, await page.evaluate("window.__app.state.note"), await page.evaluate("document.querySelector('#noteCard h2').textContent")))
    names = {69: "A4", 70: "A♯4", 67: "G4", 66: "F♯4", 72: "C5"}
    check(all(a == b_ and names[a] == t for a, b_, t in got), "tapping keys on the 3D keyboard selects them (white and black)", str(got))
    # a tap on a key in Steps mode opens it in Keys
    await page.goto(base + "#step-9"); await ready(page); await page.wait_for_timeout(1300)
    pos = await page.evaluate("(() => { const s = window.__scene; const p = s.project(s.keyAnchor(62)); const r = document.querySelector('#c').getBoundingClientRect(); return [r.left + p.x, r.top + p.y + 4]; })()")
    await page.touchscreen.tap(pos[0], pos[1]); await page.wait_for_timeout(500)
    st = await page.evaluate("[window.__app.state.tab, window.__app.state.note, !!document.querySelector('#noteCard .backchip')]")
    check(st == ["keys", 62, True], "tapping D4 in step 9 opens D4 in Keys with a back link", str(st))
    # every key: the Keys card names the same step the plan does, and temperament rates match
    res = await page.evaluate("""(() => {
      const P = window.__app.PLAN, out = [];
      for (let m = 21; m <= 108; m++) {
        window.__app.showNote(m);
        const link = document.querySelector('#noteCard [data-goto-step]:not(.backchip)');
        const n = link ? Number(link.dataset.gotoStep) : null;
        if (n !== P.notes[m].tunedBy.step) out.push([m, n, P.notes[m].tunedBy.step]);
      }
      for (const s of P.steps) if (s.target && s.target.ref && s.target.kind !== 'P8') {
        window.__app.setTab('steps', { push: false }); window.__app.showStep(s.n - 1, { push: false });
        const stepRate = document.querySelector('#stepCard .rate .big').textContent;
        window.__app.setTab('keys', { push: false }); window.__app.showNote(window.__app.midiOf(s.target.note), { push: false });
        const keyRate = document.querySelector('#noteCard .checks li:not(.hd) .r').firstChild.textContent;
        if (stepRate.replace('≈', '').trim() !== keyRate.replace('≈', '').trim()) out.push([s.target.note, stepRate, keyRate]);
      }
      return out;
    })()""")
    check(res == [], "all 88 keys link to the step that tunes them, and step and key cards show the same rate", str(res)[:300])
    await ctx.close()

def beat_rate(x, sr, hz):
    """Beat rate and modulation depth of signal x around frequency hz: demodulate at hz,
    low-pass (40 ms), drop the attack and release, remove the slow decay, then find the
    strongest envelope frequency. depth = envelope swing at that rate / mean envelope."""
    n = np.arange(len(x)); z = x * np.exp(-2j * np.pi * hz * n / sr)
    k = int(sr * 0.04); env = np.abs(np.convolve(z, np.ones(k) / k, mode="same"))
    env = env[int(0.4 * sr): -int(0.4 * sr)]
    t = np.arange(len(env)) / sr
    trend = np.polyval(np.polyfit(t, env, 3), t); res = env - trend
    f = np.abs(np.fft.rfft(res * np.hanning(len(res)), 64 * len(res)))
    fr = np.fft.rfftfreq(64 * len(res), 1 / sr); sel = (fr > 0.3) & (fr < 30)
    fb = float(fr[sel][np.argmax(f[sel])])
    amp = 2 * abs(np.sum(res * np.exp(-2j * np.pi * fb * t))) / len(res)
    return fb, float(amp / np.mean(env))

async def t_tuner_tap_key(b, base):
    ctx = await phone(b); page = await ctx.new_page()
    await page.add_init_script(MIC_SPY)
    await page.goto(base + "#step-9"); await ready(page); await page.wait_for_timeout(800)
    await page.evaluate("window.__app.setTab('tuner')")
    await page.wait_for_timeout(1300)
    got = []
    for m in (62, 64, 61):
        pos = await page.evaluate(f"(() => {{ const s = window.__scene; const p = s.project(s.keyAnchor({m})); const r = document.querySelector('#c').getBoundingClientRect(); return [r.left + p.x, r.top + p.y + 6]; }})()")
        await page.touchscreen.tap(pos[0], pos[1]); await page.wait_for_timeout(450)
        got.append((m, await page.evaluate("[window.__app.state.tab, window.__app.state.tunerSource, window.__app.state.note]"), await page.evaluate("document.querySelector('#tnTarget').textContent")))
    ok = all(st == ["tuner", "key", m] and t.startswith("Aiming at") for m, st, t in got)
    check(ok, "Tuner tab: tapping a key on the piano aims the tuner at it and stays on the Tuner tab", str([(m, st, t[:30]) for m, st, t in got]))
    await page.click("#srcStep"); await page.wait_for_timeout(300)
    back = await page.evaluate("[window.__app.state.tunerSource, document.querySelector('#tnTarget').textContent.slice(0, 40)]")
    check(back[0] == "step", "Tuner tab: the Step button goes back to the step's note", str(back))
    mic = await page.evaluate("window.__mic.length")
    check(mic == 0, "Tuner tab: tapping keys never asks for the microphone", f"calls={mic}")
    blocked = await page.evaluate("""(() => { const out = {}; for (const id of ['trace', 'c']) { const el = document.getElementById(id); const ev = new TouchEvent('touchstart', { cancelable: true, bubbles: true, touches: [] }); el.dispatchEvent(ev); out[id] = ev.defaultPrevented; } return out; })()""")
    check(blocked == {"trace": False, "c": True}, "touch blocking is scoped to the 3D stage: the tuner trace still lets a scroll start", str(blocked))
    await ctx.close()

async def t_audio(b, base):
    ctx = await desktop(b); page = await ctx.new_page(); errs = []; collect(page, errs, "audio")
    await page.goto(base + "#step-9"); await ready(page)
    await page.click("#stepCard [data-demo=step]"); await page.wait_for_timeout(700)
    st = await page.evaluate("(() => { const l = document.querySelector('[data-light]'); return [document.querySelector('[data-demo=step]').classList.contains('on'), document.querySelector('[data-state]').textContent]; })()")
    check(st[0] and "Pure" in st[1], "Hear it starts the demo (pure phase first)", str(st))
    ops = []
    for _ in range(8): ops.append(await page.evaluate("document.querySelector('[data-light]').style.getPropertyValue('--glow')")); await page.wait_for_timeout(120)
    await page.wait_for_timeout(5200)
    ops2 = []
    for _ in range(10): ops2.append(float(await page.evaluate("document.querySelector('[data-light]').style.getPropertyValue('--glow')") or 0)); await page.wait_for_timeout(110)
    check(max(ops2) - min(ops2) > 0.2, "the beat light pulses during the tempered phase", str([round(o, 2) for o in ops2]))
    await page.click("#stepCard [data-demo=step]")
    # measure what the demos actually play
    cases = [("A3", "D4", "P4", "D4", 880.0, 0.994), ("F3", "A3", "M3", "A3", 880.0, 6.929), ("F3", "C4", "P5", "C4", 523.5, 0.591), ("A3", "A4", "P8", "A3", 440.0, 1.0)]
    for lo, hi, kind, tgt, hz, want in cases:
        data = await page.evaluate(f"""(async () => {{
          const ph = window.__app.phasesFor({{ type: 'interval', lo: '{lo}', hi: '{hi}', kind: '{kind}', target: '{tgt}' }});
          const bufs = await window.__app.renderOffline(ph, 22050);
          const b64 = (f) => {{ const u = new Uint8Array(f.buffer); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }};
          return {{ labels: ph.map(p => p.label), bufs: bufs.map(b64) }};
        }})()""")
        sig = [np.frombuffer(base64.b64decode(x), dtype=np.float32) for x in data["bufs"]]
        r0, s0 = beat_rate(sig[0], 22050, hz); r1, s1 = beat_rate(sig[1], 22050, hz)
        if kind == "P8":   # "slightly off" (1 beat/s) first, then still
            check(abs(r0 - want) < 0.08 and s0 > 0.3 and s1 < 0.05, f"octave demo {lo}+{hi}: first phase beats {r0:.2f}/s, second is still", f"{data['labels']}, depth {s0:.2f} -> {s1:.3f}")
        else:
            check(s0 < 0.05 and s1 > 0.3 and abs(r1 - want) / want < 0.06, f"{lo}+{hi} demo: pure phase still, tempered phase beats {r1:.2f}/s (want {want})", f"modulation depth pure {s0:.3f}, tempered {s1:.2f}")
    check(not errs, "no errors in the audio demos", "; ".join(errs)[:300])
    await ctx.close()

async def t_offline(b, base):
    ctx = await phone(b); page = await ctx.new_page(); errs = []; collect(page, errs, "offline")
    await page.goto(base + "#step-1"); await ready(page)
    ok = await page.evaluate("navigator.serviceWorker ? navigator.serviceWorker.ready.then(() => true) : false")
    await page.reload(); await ready(page); await page.wait_for_timeout(800)
    await ctx.set_offline(True)
    await page.reload();
    try:
        await ready(page); loaded = True
    except Exception:
        loaded = False
    title = await page.evaluate("document.querySelector('#stepCard .title') && document.querySelector('#stepCard .title').textContent") if loaded else None
    check(ok and loaded and title, "after one visit the guide reloads with the network off (service worker)", str(title))
    await ctx.close()

async def main():
    ap = argparse.ArgumentParser(); ap.add_argument("base"); ap.add_argument("--only", default=None); a = ap.parse_args()
    base = a.base.rstrip("/") + "/"
    async with async_playwright() as pw:
        b = await pw.chromium.launch(channel="chrome", headless=True, args=LAUNCH)
        tests = [("load", t_load_and_errors), ("mic", t_mic_only_on_tap), ("tuner", t_tuner_targets), ("steps", t_steps_walk), ("keys", t_pick_a_note), ("tunerkeys", t_tuner_tap_key), ("audio", t_audio), ("offline", t_offline), ("mode", t_mode_remembered), ("landscape", t_landscape), ("sideways", t_no_sideways)]
        for name, fn in tests:
            if a.only and a.only != name: continue
            try: await fn(b, base)
            except Exception as e: check(False, f"{name}: crashed", repr(e)[:300])
        if not a.only or a.only == "nowebgl":
            try: await t_no_webgl(None, base, pw)
            except Exception as e: check(False, "nowebgl: crashed", repr(e)[:300])
        if not a.only or a.only == "device":
            try: await t_real_fake_device(None, base, pw)
            except Exception as e: check(False, "device: crashed", repr(e)[:300])
        await b.close()
    bad = [r for r in RESULTS if not r[0]]
    print(f"\n{len(RESULTS) - len(bad)} passed, {len(bad)} failed")
    sys.exit(1 if bad else 0)

asyncio.run(main())
