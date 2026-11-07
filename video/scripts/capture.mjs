// Records the real, live Vigil deployment for the demo film.
//
//   ONLY=check  node scripts/capture.mjs   log in to Mattermost and the Switch dashboard, save check shots (no writes)
//   ONLY=switch node scripts/capture.mjs   tour of the Switch dashboard (read only)
//   ONLY=run RUN=yes node scripts/capture.mjs
//       the live incident: three browsers record at once (War Room, Mattermost #vigil-hotfix and
//       #vigil-releases) while one chaos release runs to the end. Writes, all on the live site:
//       one chaos release, Claude Code's session (by Claude Code), one "Test Rogue Agent Block"
//       click (a refused agent approval). The approval is typed by the owner, never by this script.
//
// Output: .cache/frames/<clip>/ (JPEG screencast + frames.json), .cache/marks.json (event times,
// wall clock), .cache/meta.json (per clip: element rects in CSS px), public/stills/ and data/run.json.
// scripts/encode.mjs turns the frames into public/footage/<clip>.mp4.
//
// Logins come from video/.capture.env (gitignored) and are never printed.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, sleep } from "./cdp.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const FRAMES = join(ROOT, ".cache/frames");
const STILLS = join(ROOT, "public/stills");
const CHECK = join(ROOT, ".cache/check");
const SCALE = 2;
const VIEW = { w: 1600, h: 900 };
const VIGIL = process.env.VIGIL_URL || "https://vigil.netlayerlabs.com";
const SCENARIO = "jpy_zero_decimal_500";
const ONLY = process.env.ONLY?.split(",");
if (!ONLY) { console.error("Set ONLY=<check|switch|run>. The run clip makes live writes; never re-run it by accident."); process.exit(1); }
const want = (c) => ONLY.includes(c);
for (const d of [FRAMES, STILLS, CHECK, join(ROOT, "data")]) mkdirSync(d, { recursive: true });

// ---- logins (never printed)
const ENV = {};
const envFile = join(ROOT, ".capture.env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) ENV[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const need = (k) => { if (!ENV[k]) { console.error(`Missing ${k} in video/.capture.env`); process.exit(1); } return ENV[k]; };

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(0)}s`, ...a);
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const marks = readJson(join(ROOT, ".cache/marks.json"));
const meta = readJson(join(ROOT, ".cache/meta.json"));
const mark = (k) => { marks[k] = Date.now() / 1000; log("mark", k); save(); };
function save() {
  writeFileSync(join(ROOT, ".cache/marks.json"), JSON.stringify(marks, null, 1));
  writeFileSync(join(ROOT, ".cache/meta.json"), JSON.stringify(meta, null, 1));
}
function setMeta(clip, data) {
  const prev = meta[clip] || {};
  meta[clip] = { deviceScale: SCALE, viewport: VIEW, ...prev, ...data, rects: { ...(prev.rects || {}), ...(data.rects || {}) } };
  save();
}

// ---- one browser = one "camera"
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const OVERLAY = `(() => {
  window.__ease = (el, prop, to, ms) => new Promise((done) => {
    const from = el[prop]; const start = performance.now();
    const f = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => { const p = Math.min(1, (now - start) / ms); el[prop] = from + (to - from) * f(p); if (p < 1) requestAnimationFrame(step); else done(el[prop]); };
    requestAnimationFrame(step);
  });
  if (document.getElementById('__cur')) return;
  const s = document.createElement('style');
  s.textContent = '#__cur{position:fixed;left:-40px;top:-40px;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:rgba(255,255,255,.96);box-shadow:0 0 0 2px rgba(14,107,71,.85),0 4px 16px rgba(0,0,0,.35);z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .3s ease,transform .12s ease-out,left .8s cubic-bezier(.22,1,.36,1),top .8s cubic-bezier(.22,1,.36,1)}#__cur.down{transform:scale(.7)}.__ring{position:fixed;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;border:2px solid rgba(23,199,132,.9);z-index:2147483646;pointer-events:none;animation:__r .6s ease-out forwards}@keyframes __r{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}';
  document.head.appendChild(s);
  const c = document.createElement('div'); c.id = '__cur'; document.body.appendChild(c);
})()`;

async function camera(name) {
  const b = await launch({ width: VIEW.w, height: VIEW.h, extraArgs: [`--force-device-scale-factor=${SCALE}`, "--disable-blink-features=AutomationControlled", `--user-agent=${UA}`] });
  await b.send("Emulation.setDeviceMetricsOverride", { width: VIEW.w, height: VIEW.h, deviceScaleFactor: SCALE, mobile: false });
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})" });
  const js = (e) => b.js(e);
  const cam = {
    b, js, name,
    overlay: () => js(OVERLAY),
    async glide(x, y, settle = 900) {
      await js(`(() => { const k = document.getElementById('__cur'); if (k) { k.style.opacity = '1'; k.style.left = '${x}px'; k.style.top = '${y}px'; } })()`);
      await sleep(820);
      await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sleep(Math.max(0, settle - 820));
    },
    async clickAt(x, y) {
      await js(`(() => { const k = document.getElementById('__cur'); k?.classList.add('down'); const r = document.createElement('div'); r.className = '__ring'; r.style.left = '${x}px'; r.style.top = '${y}px'; document.body.appendChild(r); setTimeout(() => { k?.classList.remove('down'); r.remove(); }, 650); })()`);
      await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await sleep(90);
      await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    },
    hide: () => js(`(() => { const k = document.getElementById('__cur'); if (k) k.style.opacity = '0'; })()`),
    center: (finder) => js(`(() => { const e = ${finder}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`),
    rect: async (finder) => { const r = await b.rectOf(finder); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; },
    async press(finder, settle = 700) {
      const p = await cam.center(finder);
      if (!p) throw new Error(`${name}: not found ${finder.slice(0, 90)}`);
      await cam.glide(p.x, p.y, 1000);
      await cam.clickAt(p.x, p.y);
      await sleep(settle);
    },
    async type(text, cps = 14) { for (const ch of text) { await b.send("Input.insertText", { text: ch }); await sleep(1000 / cps + Math.random() * 30); } },
    async waitFor(cond, ms = 30000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await js(`!!(${cond})`).catch(() => false)) return true; await sleep(400); }
      throw new Error(`${name}: timed out waiting for ${String(cond).slice(0, 120)}`);
    },
    async shot(file) { await b.shot(file); },
    stop: null,
    async rec(clip) {
      const dir = join(FRAMES, clip);
      rmSync(dir, { recursive: true, force: true });
      cam.stop = await b.screencast(dir);
      mark(`${clip}:start`);
    },
    async endRec(clip) {
      if (!cam.stop) return;
      mark(`${clip}:end`);
      const frames = await cam.stop();
      cam.stop = null;
      const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
      log(`${clip}: ${frames.length} frames over ${span.toFixed(1)}s`);
    },
  };
  return cam;
}
const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().replace(/\\s+/g, ' ').includes(${JSON.stringify(text)}))`;

// ---- Mattermost
async function mattermost(cam, channel) {
  const base = need("MM_URL").replace(/\/$/, "");
  // Skip the "desktop app or browser" chooser.
  await cam.b.goto(base + "/", 1500);
  await cam.js(`try { localStorage.setItem('__landingPageSeen__', 'true') } catch {}`);
  await cam.b.goto(base + "/login", 5000);
  await cam.js(`(${byText("a,button", "View in Browser")})?.click()`).catch(() => {});
  await sleep(1500);
  await cam.waitFor(`document.querySelector('#input_loginId, input[name=loginId]')`, 20000);
  const fill = (sel, val) => cam.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, ${JSON.stringify(val)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await fill("#input_loginId, input[name=loginId]", need("MM_USER"));
  await fill("#input_password-input, input[type=password]", need("MM_PASS"));
  await cam.js(`(document.querySelector('#saveSetting') || ${byText("button", "Log in")})?.click()`);
  await cam.waitFor(`!location.pathname.includes('/login')`, 20000);
  await sleep(3000);
  const path = await cam.js(`location.pathname`);
  const teamName = path.split("/").filter(Boolean)[0];
  await cam.b.goto(`${base}/${teamName}/channels/${channel}`, 7000);
  // Close the email-preview banner, tips and tours if any.
  await cam.js(`document.querySelectorAll('.announcement-bar__close, .announcement-bar [class*=close]').forEach((e) => { try { e.click() } catch {} })`).catch(() => {});
  await sleep(800);
  await cam.js(`document.querySelectorAll('[aria-label="Close"], .tipButton, #tipNextButton').forEach((e) => { try { e.click() } catch {} })`).catch(() => {});
  await cam.overlay();
  return { base, teamName };
}

// ---- Switch Gateway dashboard
async function switchDash(cam) {
  const base = need("SWITCH_DASH_URL").replace(/\/$/, "");
  await cam.b.goto(base + "/login", 5000);
  const fill = (sel, val) => cam.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, ${JSON.stringify(val)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await fill("input[type=email]", need("SWITCH_DASH_USER"));
  await fill("input[type=password]", need("SWITCH_DASH_PASS"));
  await cam.js(`(${byText("button", "Sign in")})?.click()`);
  await cam.waitFor(`!location.pathname.includes('/login')`, 20000);
  await sleep(3000);
  await cam.overlay();
  return base;
}

const state = async () => (await fetch(`${VIGIL}/api/state`)).json();

// ---------------------------------------------------------------- clips
if (want("check")) {
  const mm = await camera("check-mm");
  try {
    const { teamName } = await mattermost(mm, "vigil-hotfix");
    await mm.shot(join(CHECK, "mattermost-hotfix.png"));
    log("mattermost ok, team:", teamName);
  } catch (e) { log("mattermost FAILED:", e.message); await mm.shot(join(CHECK, "mattermost-fail.png")).catch(() => {}); }
  mm.b.close();
  const sw = await camera("check-switch");
  try {
    await switchDash(sw);
    await sw.shot(join(CHECK, "switch-home.png"));
    log("switch dashboard ok:", await sw.js("location.pathname"));
    log(JSON.stringify(await sw.js(`[...document.querySelectorAll('a,button')].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 40)`)));
  } catch (e) { log("switch dashboard FAILED:", e.message); await sw.shot(join(CHECK, "switch-fail.png")).catch(() => {}); }
  sw.b.close();
}

if (want("run")) {
  if (process.env.RUN !== "yes") { console.error("The run makes live writes. Set RUN=yes once the owner has agreed."); process.exit(1); }
  const before = await state();
  if (before.activeIncident) { console.error(`An incident is already open (${before.activeIncident.incidentId}). Not starting.`); process.exit(1); }
  if (before.patchMode !== "external") { console.error(`Patch mode is ${before.patchMode}, not external. Not starting.`); process.exit(1); }

  const war = await camera("warroom");
  const hot = await camera("mm-hotfix");
  const rel = await camera("mm-releases");
  await Promise.all([mattermost(hot, "vigil-hotfix"), mattermost(rel, "vigil-releases")]);
  await war.b.goto(`${VIGIL}/app`, 6000);
  await war.overlay();
  setMeta("warroom", { url: "vigil.netlayerlabs.com/app" });
  setMeta("mm_hotfix", { url: "vigil-chat.netlayerlabs.com · #vigil-hotfix" });
  setMeta("mm_releases", { url: "vigil-chat.netlayerlabs.com · #vigil-releases" });

  await Promise.all([war.rec("warroom"), hot.rec("mm_hotfix"), rel.rec("mm_releases")]);
  await sleep(4000);

  // The chaos release.
  const chaos = byText("button", "JPY Zero-Decimal 500");
  await war.waitFor(chaos);
  await war.press(chaos, 400);
  mark("run.chaos");

  // Follow the incident by its live state; mark every stage change.
  const seen = new Set();
  let incidentId = null, rogueDone = false, patchTabOpen = false;
  const deadline = Date.now() + 45 * 60 * 1000;
  while (Date.now() < deadline) {
    const s = await state().catch(() => null);
    const inc = s?.activeIncident ?? (incidentId ? s?.incidents?.find((i) => i.incidentId === incidentId) : null);
    if (inc) {
      incidentId = inc.incidentId;
      if (!seen.has(inc.stage)) { seen.add(inc.stage); mark(`run.stage.${inc.stage}`); }
      if (inc.patchVerification && !seen.has("verified")) { seen.add("verified"); mark("run.verified"); }
      if (inc.stage === "awaiting_human_gate" && !patchTabOpen) {
        patchTabOpen = true;
        await sleep(2500);
        await war.press(byText("button", "Patch & Canary"), 2500);
        mark("run.patchtab");
        await sleep(9000);
      }
      if (inc.stage === "awaiting_human_gate" && patchTabOpen && !rogueDone) {
        rogueDone = true;
        await war.press(byText("button", "Test Rogue Agent Block"), 600);
        mark("run.rogue");
        log(">>> Now type in Mattermost #vigil-releases:  @vigil-release-gate approve " + incidentId + " promote");
      }
      if (inc.stage?.startsWith("resolved") || inc.stage === "interrupted") {
        mark("run.closed");
        await sleep(15000);
        break;
      }
    }
    await sleep(1000);
  }
  await Promise.all([war.endRec("warroom"), hot.endRec("mm_hotfix"), rel.endRec("mm_releases")]);
  for (const c of [war, hot, rel]) await c.shot(join(STILLS, `${c.name}-end.png`)).catch(() => {});
  [war, hot, rel].forEach((c) => c.b.close());

  // The incident's real record, for every figure the film quotes.
  const after = await state();
  const inc = after.incidents.find((i) => i.incidentId === incidentId);
  writeFileSync(join(ROOT, "data/run.json"), JSON.stringify({ checkedAt: new Date().toISOString(), source: `${VIGIL}/api/state`, incident: inc }, null, 1));
  log("saved data/run.json for", incidentId, inc?.stage);
}

if (want("switch")) {
  const sw = await camera("switch");
  const base = await switchDash(sw);
  setMeta("switch", { url: base.replace(/^https?:\/\//, "") + "/rooms" });
  await sw.b.goto(base + "/rooms", 5000);
  await sw.overlay();
  await sw.rec("switch");
  await sleep(2500);
  setMeta("switch", { rects: { table: await sw.rect(`document.querySelector('table')`) } });
  // Hover the three Vigil rooms.
  for (const room of ["vigil-incidents", "vigil-hotfix", "vigil-releases"]) {
    const p = await sw.center(byText("[role=gridcell], td", room));
    if (p) { await sw.glide(p.x, p.y, 1300); mark(`switch.row.${room}`); }
  }
  await sleep(800);
  await sw.press(byText("button,a", "Graph view"), 400);
  await sw.hide();
  await sleep(4100);
  mark("switch.graph");
  await sw.shot(join(STILLS, "switch-graph.png"));
  await sleep(5000);
  await sw.hide();
  await sw.b.goto(base + "/rooms", 4000);
  await sw.overlay();
  log("on /rooms:", JSON.stringify(await sw.js(`({ h: [...document.querySelectorAll('h1,h2')].map((e) => e.textContent.trim()), b: [...document.querySelectorAll('button,a')].map((e) => (e.getAttribute('aria-label') || e.textContent.trim()).slice(0, 30)).filter(Boolean).slice(0, 30) })`)));
  const back = `[...document.querySelectorAll('button,a')].find((e) => /back/i.test(e.getAttribute('aria-label') || '') || (e.nextElementSibling && /Rooms graph/.test(e.nextElementSibling.textContent || '')))`;
  if (await sw.js(`!!(${back})`)) await sw.press(back, 3000);
  await sw.waitFor(byText("[role=gridcell], td", "vigil-hotfix"), 20000);
  await sw.press(byText("[role=gridcell], td", "vigil-hotfix"), 400);
  await sw.hide();
  await sleep(4100);
  mark("switch.room");
  await sw.shot(join(STILLS, "switch-room.png"));
  await sleep(4000);
  await sw.endRec("switch");
  sw.b.close();
}

// Read only: scroll back through one incident's conversation in a Mattermost channel.
async function story(clip, channel, firstText, ms) {
  const cam = await camera(clip);
  await mattermost(cam, channel);
  await sleep(2500);
  const post = byText("[id^=post_], .post", firstText);
  // Bring the first post of the incident to the top of the message list.
  const scroller = `(() => { let e = ${post}; while (e && !(e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY))) e = e.parentElement; return e; })()`;
  for (let i = 0; i < 12 && !(await cam.js(`!!(${post})`)); i++) {
    await cam.js(`(() => { const s = [...document.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.closest('#post-list, .post-list-holder-by-time, [data-testid=postView], .post-list__dynamic, #channel_view')); if (s) s.scrollTop -= 700; })()`);
    await sleep(900);
  }
  if (!(await cam.js(`!!(${post})`))) throw new Error(`${clip}: first post not found: ${firstText}`);
  const top = await cam.js(`(() => { const s = ${scroller}; const p = ${post}; return s.scrollTop + p.getBoundingClientRect().top - s.getBoundingClientRect().top - 12; })()`);
  await cam.js(`(() => { const s = ${scroller}; s.scrollTop = ${top}; })()`);
  await sleep(1500);
  setMeta(clip, { url: `vigil-chat.netlayerlabs.com · #${channel}` });
  await cam.rec(clip);
  await sleep(2500);
  mark(`${clip}.scroll`);
  await cam.js(`(() => { const s = ${scroller}; return window.__ease(s, 'scrollTop', s.scrollHeight - s.clientHeight, ${ms}); })()`);
  mark(`${clip}.bottom`);
  await sleep(3000);
  await cam.endRec(clip);
  cam.b.close();
}
if (want("story_hotfix")) await story("story_hotfix", "vigil-hotfix", "[ESCALATE INC-2046", 16000);
if (want("story_releases")) await story("story_releases", "vigil-releases", "[HANDOFF INC-2046]", 12000);
if (want("story_incidents")) await story("story_incidents", "vigil-incidents", "INC-2046, SEV-1", 6000);

save();
log("done");
