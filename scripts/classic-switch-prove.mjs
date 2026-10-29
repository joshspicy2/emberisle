// #759 (#641, #750; docs/design/classic-board.md "Loading, failure, and quality"): choosing the Jelly or the Classic land look on the
// island renderer, proven against the actual IsleRenderer (the app's own, at window.__isle) and both production builders
// (jelly-board.ts, classic-board.ts) in a software-GL Chromium. The loader, the construction and the shader compile are wrapped,
// never replaced: each stage is held or failed on demand and then runs the production code.
// - Jelly-only startup never requests the Classic chunk; Classic is requested only when it is asked for;
// - a same-board switch is atomic: every drawn frame shows exactly one of the stand-in slabs and one look, the new look is added
//   and the old removed in one synchronous step, and the old one is disposed after; the shared pieces, tokens, pick blocks,
//   wayfarer, marks, camera matrices, picking and selection are the same objects and the same numbers before and after;
// - imports, construction (mid-build) and shader compilation are each delayed while the old look stays on screen;
// - rapid switches, a new deal, a rematch and disposal: stale completions are rejected and disposed, nothing leaks;
// - failures (import, construction, compile) keep only land that matches the board, stay within five retries, and an explicit
//   retry recovers; a new board shows its own stand-ins whatever the failure;
// - the visibility updates are frozen copies, with no scene object in them, sent before the swap publishes;
// - glow and the blocked hex carry over; no roll, tap, sound, payout or game action is replayed by a switch;
// - reduced motion lands on a still pose; token numerals stay clear of the Classic props; resource counts stay level over
//   repeated switches.
// Run: npm run classic-switch-prove. Port from VITE_PORT, default 8199.
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { createServer } from "vite";

const PORT = Number(process.env.VITE_PORT) || 8199;
const STEP_MS = 120_000;
const vite = await createServer({ server: { host: "127.0.0.1", port: PORT, strictPort: true }, logLevel: "error" });
await vite.listen();

const errors = [];
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : " " + JSON.stringify(detail)}`);
  if (!ok) failed++;
};
const report = (checks) => checks.forEach((c) => check(c.name, c.ok, c.detail));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

// The page's side: installs the harness on the app's renderer. Everything is read off window.__isle; nothing is stubbed out.
function installHarness() {
  const isle = window.__isle;
  const H = (window.__H = { checks: [], imports: [], builds: [], compiles: [], made: [], events: [], seq: 0, gates: {}, fail: {}, plays: 0, frames: [], statuses: [] });
  H.check = (name, ok, detail) => H.checks.push({ name, ok: !!ok, detail });
  H.take = () => H.checks.splice(0);
  H.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  H.until = async (pred, label, ms = 90_000) => {
    const t0 = performance.now();
    isle.wake?.();
    while (!pred()) {
      if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
      await H.sleep(15);
    }
  };
  H.hold = (stage) => {
    let release;
    const p = new Promise((r) => (release = r));
    H.gates[stage] = { p, release: () => (H.gates[stage] = null, release()) };
    return H.gates[stage];
  };
  const gate = async (stage) => {
    const g = H.gates[stage];
    if (g) await g.p;
    if (H.fail[stage]) throw new Error(`injected ${stage} failure`);
  };
  // Sounds: any media element asked to play is counted.
  const realPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    H.plays++;
    return realPlay.apply(this, a);
  };
  const realLoad = isle.loadLook;
  const realCompile = isle.compileLook;
  const tag = (a, look) => {
    const rec = { look, a, disposed: 0, calls: [] };
    const wrap = (name) => {
      const f = a[name].bind(a);
      a[name] = (...args) => {
        rec.calls.push({ name, args });
        H.events.push({ seq: H.seq, tick: H.tick, name: `${look}.${name}` });
        if (name === "dispose") rec.disposed++;
        return f(...args);
      };
    };
    ["update", "glow", "roll", "tap", "robber", "setVisibilityContext", "dispose"].forEach(wrap);
    H.made.push(rec);
    return rec;
  };
  H.tick = 0;
  H.nulls = 0;
  H.throws = [];
  if (isle.landLook) tag(isle.landLook, isle.landStatus().displayed);
  // The camera and the tokens are still when two reads a few frames apart agree.
  H.settle = async () => {
    for (let i = 0; i < 100; i++) {
      const a = H.snap();
      isle.wake?.();
      const n = isle.renders;
      await H.until(() => isle.renders >= n + 2, "two frames", 60000);
      const b = H.snap();
      if (a.persp === b.persp && a.tokens === b.tokens && a.target === b.target) return;
    }
    throw new Error("the camera never settled");
  };
  isle.loadLook = async (look) => {
    H.imports.push(look);
    await gate("import");
    const make = await realLoad(look);
    return async (hexes, key, pause, lite) => {
      H.builds.push(look);
      const my = H.builds.length;
      (H.trace ??= []).push("start" + my);
      await gate("build");
      let a;
      try {
        a = await make(hexes, key, async () => (await gate("mid"), pause()), lite);
      } catch (e) {
        H.throws.push(String(e));
        throw e;
      }
      H.trace.push("end" + my + (a ? "obj" : "null"));
      if (a) tag(a, look);
      else H.nulls++;
      return a;
    };
  };
  isle.compileLook = async (a) => {
    H.compiles.push(a);
    await gate("compile");
    return realCompile(a);
  };
  // Events in one synchronous step share a tick: a microtask boundary bumps it.
  const bump = () => {
    H.tick++;
  };
  for (const m of ["add", "remove"]) {
    const f = isle.living[m].bind(isle.living);
    isle.living[m] = (...a) => {
      const g = a[0];
      if (g && (g.name === "jelly-board" || g.name === "classic-board")) {
        H.events.push({ name: `living.${m}:${g.name}`, tick: H.tick });
        queueMicrotask(bump);
      }
      return f(...a);
    };
  }
  // Every drawn frame: how many look groups stand in the scene, and whether the stand-in slabs do.
  const draw = isle.composer.render.bind(isle.composer);
  isle.composer.render = (...a) => {
    H.frames.push({ looks: isle.living.children.filter((c) => c.name === "jelly-board" || c.name === "classic-board").length, slabs: isle.slabs && isle.slabs.parent === isle.land ? 1 : 0, tokens: isle.tokens.length });
    return draw(...a);
  };
  isle.onLand = (s) => H.statuses.push(s);
  const refs = () => ({
    persp: isle.persp, ortho: isle.ortho, orbit: isle.orbit, wayfarer: isle.wayfarer, pieces: isle.pieces, marks: isle.marks, land: isle.land, living: isle.living,
    raycaster: isle.raycaster, beach: isle.beach, shore: isle.shore, tokens: [...isle.tokens], pickables: [...isle.pickables], caps: [...isle.caps.values()],
    pieceKids: [...isle.pieces.children], markKids: [...isle.marks.children], landKids: isle.land.children.filter((c) => !c.isInstancedMesh),
  });
  // Picking: what a ray through each of a grid of screen points hits among the pick blocks.
  const picks = () => {
    const cam = isle.cam();
    cam.updateMatrixWorld();
    const out = [];
    for (let i = -4; i <= 4; i++)
      for (let j = -4; j <= 4; j++) {
        isle.raycaster.setFromCamera({ x: i / 5, y: j / 5 }, cam);
        const hit = isle.raycaster.intersectObjects(isle.pickables.filter((o) => o.userData.kind === "hex"), true)[0];
        out.push(hit ? `${hit.object.userData.id}@${hit.distance.toFixed(5)}` : "-");
      }
    return out.join();
  };
  H.snap = () => {
    isle.persp.updateMatrixWorld();
    isle.ortho.updateMatrixWorld();
    return {
      refs: refs(),
      persp: [...isle.persp.matrixWorld.elements, ...isle.persp.projectionMatrix.elements].join(),
      ortho: [...isle.ortho.matrixWorld.elements, ...isle.ortho.projectionMatrix.elements].join(),
      target: isle.orbit.target.toArray().join(),
      tokens: isle.tokens.map((t) => [...t.position.toArray(), ...t.rotation.toArray().slice(0, 3), ...t.scale.toArray()].join()).join("|"),
      picks: picks(),
      pending: JSON.stringify(isle.pending ?? null),
      legal: [...isle.legalIds].join(),
      store: (() => {
        const g = window.__emberisle.getState();
        return { state: g.state, seq: g.state.seq, phase: g.state.phase, buildMode: g.buildMode, highlights: JSON.stringify(g.highlights()), pendingPlace: JSON.stringify(g.pendingPlace) };
      })(),
      jellyT: isle.jellyT,
    };
  };
  const sameRefs = (a, b) => Object.keys(a).filter((k) => (Array.isArray(a[k]) ? a[k].length !== b[k].length || a[k].some((x, i) => x !== b[k][i]) : a[k] !== b[k]));
  H.diff = (a, b) => {
    const bad = sameRefs(a.refs, b.refs);
    for (const k of ["persp", "ortho", "target", "tokens", "picks", "pending", "legal"]) if (a[k] !== b[k]) bad.push(k);
    for (const k of ["state", "seq", "phase", "buildMode", "highlights", "pendingPlace"]) if (a.store[k] !== b.store[k]) bad.push(`store.${k}`);
    return bad;
  };
  H.counts = () => {
    const m = isle.renderer.info.memory;
    let objects = 0;
    isle.scene.traverse(() => objects++);
    return { geometries: m.geometries, textures: m.textures, programs: isle.renderer.info.programs?.length ?? 0, objects };
  };
  H.lookGroups = () => isle.living.children.filter((c) => c.name === "jelly-board" || c.name === "classic-board");
  H.status = () => isle.landStatus();
  H.reset = () => {
    H.nulls = 0;
    H.trace = [];
    H.imports.length = 0;
    H.builds.length = 0;
    H.compiles.length = 0;
    H.events.length = 0;
    H.statuses.length = 0;
    H.frames.length = 0;
    H.fail = {};
    H.gates = {};
  };
  // The sight line from the eye to the lowest row of each numeral against the opaque props of the look on screen: the tokens the
  // look hides, and how many it tested. The context is the last one the look was given.
  H.sights = (spread = 0) => {
    const look = isle.landLook;
    const rec = H.made.find((m) => m.a === look);
    const ctx = rec.calls.filter((c) => c.name === "setVisibilityContext").at(-1).args[0];
    const eye = isle.cam().position;
    look.group.updateMatrixWorld(true);
    const meshes = [];
    look.group.traverse((o) => o.isMesh && o.visible && !o.name.startsWith("classic-hex-") && meshes.push(o));
    const rc = isle.raycaster;
    const hits = [];
    const v = eye.clone();
    // `spread`: also the rays to points that far to either side of the numeral's centre, across the view.
    const [sx, sz] = [Math.cos(ctx.azimuth), -Math.sin(ctx.azimuth)];
    for (const k of ctx.tokens)
      for (const w of spread ? [-spread, -spread / 2, 0, spread / 2, spread] : [0]) {
        v.set(k.x + sx * w, k.glyphBottom, k.z + sz * w);
        const dir = v.clone().sub(eye);
        const dist = dir.length();
        rc.set(eye, dir.normalize());
        rc.far = dist;
        const hit = rc.intersectObjects(meshes, false).find((h) => h.distance < dist - 0.02);
        if (hit) hits.push({ x: k.x, z: k.z, w, by: hit.object.name, short: +(dist - hit.distance).toFixed(3) });
      }
    rc.far = Infinity;
    return { tested: ctx.tokens.length, props: meshes.length, view: ctx.view, hits };
  };
  H.live = () => H.made.filter((m) => !m.disposed);
  H.ready = (look) => isle.landStatus().phase === "ready" && isle.landStatus().displayed === look && isle.landStatus().requested === look;
  H.hexIds = (state) => state.hexes.map((h) => h.id).sort().join();
  H.groupHexIds = (group) => group.children.map((c) => c.name).filter((n) => n.startsWith("classic-hex-")).map((n) => n.slice(12)).sort().join();
}

async function open(extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...extra.context });
  await ctx.addInitScript((j) => {
    localStorage.setItem("emberisle-water", "simple");
    localStorage.setItem("emberisle-jelly", j);
  }, extra.quality ?? "lite");
  const page = await ctx.newPage();
  const requests = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => window.__isle?.renders > 0, null, { timeout: STEP_MS });
  return { ctx, page, requests };
}

const play = async (page) => {
  await page.getByRole("button", { name: "Four seats, one table" }).click();
  await page.waitForFunction(() => {
    const g = window.__emberisle?.getState();
    const i = window.__isle;
    return g?.screen === "play" && g.state && i.lastState === g.state && i.landReady && i.landStatus().phase === "ready";
  }, null, { timeout: STEP_MS });
};

// --- 1. Jelly-only startup never requests Classic
{
  const { ctx, page, requests } = await open();
  await play(page);
  await page.evaluate(installHarness);
  const st = await page.evaluate(() => window.__isle.landStatus());
  check("1 default startup asks for Jelly and shows it", st.requested === "jelly" && st.displayed === "jelly" && st.phase === "ready" && st.error === null && st.retries === 0 && st.maxRetries === 5, st);
  check("1 default startup requests no Classic module", !requests.some((u) => /classic/i.test(u)), requests.filter((u) => /classic/i.test(u)));
  check("1 the Jelly chunk was requested", requests.some((u) => /jelly-board/.test(u)));
  await ctx.close();
}

// --- 2..: one session for the switching proofs
const { ctx, page, requests } = await open();
await play(page);
await page.evaluate(installHarness);
const classicBeforeAsk = requests.filter((u) => /classic/i.test(u)).length;
const run = async (name, fn, ...args) => {
  try {
    report(await page.evaluate(async ([src, args]) => {
      const H = window.__H;
      await new Function("H", "args", `return (async () => {${src}})()`)(H, args);
      return H.take();
    }, [fn, args]));
  } catch (e) {
    check(`${name} ran`, false, String(e.message).slice(0, 300));
  }
};

// The default production values.
await run("defaults", `
  const isle = window.__isle;
  const { IsleRenderer } = await import("/src/lib/scene/isle-renderer.ts");
  const c = document.createElement("canvas");
  document.body.appendChild(c);
  const r = new IsleRenderer(c, () => {}, () => {});
  H.check("2 the renderer retries four seconds apart, at most five times", r.retryMs === 4000 && r.landStatus().maxRetries === 5, [r.retryMs, r.landStatus().maxRetries]);
  H.check("2 a new renderer asks for Jelly and shows the stand-ins", r.landStatus().requested === "jelly" && r.landStatus().displayed === null, r.landStatus());
  r.dispose();
  c.remove();
  H.check("2 the status is a frozen copy", Object.isFrozen(isle.landStatus()) && isle.landStatus() !== isle.landStatus());
`);
await page.evaluate(() => window.__H.reset());

// --- 3. A same-board switch, with the import, the construction (mid-build) and the compile each held
await run("switch delayed", `
  const isle = window.__isle;
  H.reset();
  await H.settle();
  const before = H.snap();
  const oldGroup = H.lookGroups()[0];
  const oldLook = isle.landLook;
  const oldRec = H.live();
  const m0 = H.made.length;
  H.check("3 starts on Jelly with one look group in the scene", H.lookGroups().length === 1 && oldGroup.name === "jelly-board" && isle.jellyBoard === oldLook && isle.landStatus().displayed === "jelly");
  const gi = H.hold("import");
  isle.setLandLook("classic");
  const s0 = isle.landStatus();
  H.check("3 requesting Classic marks requested apart from displayed", s0.requested === "classic" && s0.displayed === "jelly" && s0.phase === "building", s0);
  await H.until(() => isle.landStatus().stage === "import" && H.imports.length === 1, "the import");
  await H.sleep(150);
  H.check("3 while the import is held the Jelly look stays on screen", isle.landLook === oldLook && H.lookGroups()[0] === oldGroup && isle.landStatus().stage === "import" && H.imports.join() === "classic");
  const gb = H.hold("build");
  gi.release();
  await H.until(() => isle.landStatus().stage === "build" && H.builds.length === 1, "the build");
  const gm = H.hold("mid");
  gb.release();
  await H.until(() => H.gates.mid && H.made.length === m0 && isle.landStatus().stage === "build", "construction");
  await H.sleep(150);
  H.check("3 while construction is held mid-build the Jelly look stays", isle.landLook === oldLook && isle.landStatus().displayed === "jelly" && H.made.length === m0);
  const gc = H.hold("compile");
  gm.release();
  await H.until(() => H.compiles.length === 1, "the compile");
  await H.sleep(150);
  const compiling = isle.landStatus();
  H.check("3 while shaders compile the Jelly look stays and the Classic one is not in the scene", compiling.stage === "compile" && isle.landLook === oldLook && H.lookGroups().length === 1 && H.lookGroups()[0] === oldGroup && H.compiles[0].group.parent === null, compiling);
  H.check("3 the shared scene is unchanged while Classic builds", H.diff(before, H.snap()).length === 0, H.diff(before, H.snap()));
  H.frames.length = 0;
  H.events.length = 0;
  const plays = H.plays;
  gc.release();
  await H.until(() => isle.landStatus().displayed === "classic" && isle.landStatus().phase === "ready", "the swap");
  isle.wake();
  await H.until(() => H.frames.length >= 2, "frames after the swap", 60000);
  const after = H.snap();
  const newGroup = H.lookGroups()[0];
  H.check("3 the swap leaves exactly the Classic group in the scene", H.lookGroups().length === 1 && newGroup.name === "classic-board" && newGroup !== oldGroup && isle.landLook === H.made.at(-1).a && isle.jellyBoard === null);
  H.check("3 every drawn frame shows exactly one of the slabs and one look", H.frames.every((f) => f.looks + f.slabs === 1), H.frames.slice(0, 6));
  const ev = H.events.filter((e) => e.name.startsWith("living."));
  const add = ev.find((e) => e.name === "living.add:classic-board");
  const rem = ev.find((e) => e.name === "living.remove:jelly-board");
  H.check("3 the new group is added and the old removed in one synchronous step", add && rem && add.tick === rem.tick, ev);
  const names = H.events.map((e) => e.name);
  const iAdd = names.indexOf("living.add:classic-board");
  const iDis = names.indexOf("jelly.dispose");
  H.check("3 the old look is disposed only after the new one is published", iAdd >= 0 && iDis > iAdd, names);
  H.check("3 the new look was told the blocked hex, the glow and the camera before it was shown", ["classic.robber", "classic.update", "classic.setVisibilityContext"].every((n) => names.indexOf(n) >= 0 && names.indexOf(n) < iAdd), names);
  H.check("3 the old Jelly look released its group", oldGroup.children.length === 0);
  H.check("3 shared pieces, tokens, pick blocks, wayfarer, marks and camera objects are the same", H.diff(before, after).length === 0, H.diff(before, after));
  H.check("3 camera matrices, token poses and picking are identical across the swap", before.persp === after.persp && before.ortho === after.ortho && before.tokens === after.tokens && before.picks === after.picks, [before.persp === after.persp, before.tokens === after.tokens, before.picks === after.picks]);
  H.check("3 the switch moved no scene clock backwards", after.jellyT >= before.jellyT);
  H.check("3 no sound played, no action was dispatched", H.plays === plays && after.store.seq === before.store.seq && after.store.state === before.store.state, [H.plays, plays]);
  const s1 = isle.landStatus();
  H.check("3 the status reads Classic ready at the board's quality", s1.requested === "classic" && s1.displayed === "classic" && s1.phase === "ready" && s1.quality === "lite" && s1.stage === null && s1.error === null, s1);
  H.check("3 the terrain stats name the look on screen", window.__terrain.look === "classic" && window.__terrain.ready && window.__terrain.drawCalls > 0 && isle.terrainStats().look === "classic", window.__terrain);
  H.check("3 the Classic look is complete (one tile per hex)", isle.landLook.stats().hexes === isle.lastState.hexes.length && H.groupHexIds(newGroup) === H.hexIds(isle.lastState));
  H.check("3 the old look was disposed exactly once", oldRec.every((m) => m.disposed === 1) && H.made.filter((m) => m.look === "classic").every((m) => !m.disposed));
`);

// --- 4. Back and forth, repeated: stable resource counts
await run("repeated switches", `
  const isle = window.__isle;
  H.reset();
  await H.settle();
  const base = H.snap();
  const counts = [];
  for (let i = 0; i < 6; i++) {
    isle.setLandLook("jelly");
    await H.until(() => H.ready("jelly"), "jelly");
    isle.setLandLook("classic");
    await H.until(() => H.ready("classic"), "classic");
    const n = isle.renders;
    isle.wake();
    await H.until(() => isle.renders >= n + 3, "three frames of the look", 60000);
    counts.push(H.counts());
  }
  const last = counts.slice(1);
  H.check("4 geometries, textures, programs and scene objects stay level over repeated switches", last.every((c) => JSON.stringify(c) === JSON.stringify(last[0])), counts);
  H.check("4 every look but the one on screen has been disposed once", H.made.filter((m) => !m.disposed).length === 1 && H.made.every((m) => m.disposed <= 1), H.made.map((m) => m.look + m.disposed));
  H.check("4 one look group in the scene and the shared scene unchanged after twelve swaps", H.lookGroups().length === 1 && H.diff(base, H.snap()).length === 0, H.diff(base, H.snap()));
  H.check("4 the Classic chunk was imported only as often as it was asked", H.imports.filter((l) => l === "classic").length === 6 && H.imports.filter((l) => l === "jelly").length === 6);
`);

// --- 5. Rapid switches against stale completions at every stage
await run("rapid", `
  const isle = window.__isle;
  H.reset();
  isle.setLandLook("jelly");
  await H.until(() => H.ready("jelly"), "jelly");
  await H.settle();
  H.reset();
  const before = H.snap();
  const made0 = H.made.length;
  const shown = isle.landLook;
  // (a) stale at the import: three requests wait on the held import; only the last may go on.
  const gi = H.hold("import");
  isle.setLandLook("classic");
  isle.setLandLook("jelly");
  isle.setLandLook("classic");
  await H.until(() => H.imports.length === 2, "the two imports (Jelly again is what is on screen: no build)");
  gi.release();
  await H.until(() => H.ready("classic"), "the last request");
  H.check("5a of three rapid requests only the last built a look", H.builds.length === 1 && H.made.length - made0 === 1 && H.made.at(-1).look === "classic", [H.builds, H.made.length - made0]);
  H.check("5a the Jelly look on screen was replaced once, disposed once", H.made.filter((m) => m.a === shown).length === 1 && H.made.filter((m) => m.a === shown).every((m) => m.disposed === 1));
  // (b) stale mid-build and after the build: an old request's construction finishes after a newer one was made.
  H.reset();
  const made1 = H.made.length;
  const gm = H.hold("mid");
  isle.setLandLook("jelly");
  await H.until(() => H.builds.length === 1 && H.gates.mid, "jelly build held mid-way");
  await H.sleep(100);
  const gb = H.hold("build");
  isle.setLandLook("classic");
  H.check("5b asking for what is already on screen ends the build in flight and needs no new one", isle.landStatus().phase === "ready" && isle.landStatus().displayed === "classic", isle.landStatus());
  gm.release();
  await H.sleep(300);
  gb.release();
  await H.sleep(300);
  H.check("5b the cancelled mid-build construction published nothing and left nothing", H.made.length === made1 && H.live().length === 1 && H.live()[0].look === "classic" && H.lookGroups().length === 1 && H.lookGroups()[0].name === "classic-board", [H.made.length - made1, H.live().length]);
  // (c) a construction that finishes after a newer request owns the board is disposed whole.
  H.reset();
  const made2 = H.made.length;
  const gc = H.hold("compile");
  isle.setLandLook("jelly");
  await H.until(() => H.compiles.length === 1, "jelly compile held");
  isle.setLandLook("classic");
  H.check("5c the stale Jelly look finished building while Classic was asked for again", isle.landStatus().displayed === "classic" && H.made.length - made2 === 1 && H.made.at(-1).disposed === 0);
  gc.release();
  await H.until(() => H.made.at(-1).disposed === 1, "the stale look to be disposed");
  await H.sleep(200);
  H.check("5c the stale completion was disposed and never in the scene; the Classic look stays", H.made.at(-1).look === "jelly" && H.lookGroups().length === 1 && H.lookGroups()[0].name === "classic-board" && isle.landStatus().displayed === "classic" && H.live().length === 1);
  H.check("5 the shared scene is unchanged by the rapid switches", H.diff(before, H.snap()).length === 0, H.diff(before, H.snap()));
`);

// --- 6. A new deal while a switch is held: stand-ins first, the stale completion rejected
await run("new deal", `
  const isle = window.__isle;
  const { createGame } = await import("/src/lib/game/board.ts");
  const store = window.__emberisle;
  isle.setLandLook("jelly");
  await H.until(() => H.ready("jelly"), "jelly");
  await H.settle();
  H.reset();
  const dealA = store.getState().state;
  const oldGroup = H.lookGroups()[0];
  const dealB = createGame({ seed: 4242, humans: [{ name: "Elm" }, { name: "Fir" }], bots: 0 });
  H.check("6 fixture: the second deal has other terrain or numbers", H.hexIds(dealA) === H.hexIds(dealB) && JSON.stringify(dealA.hexes.map((h) => h.terrain + h.pip)) !== JSON.stringify(dealB.hexes.map((h) => h.terrain + h.pip)));
  const gb = H.hold("build");
  isle.setLandLook("classic");
  await H.until(() => H.builds.length === 1, "the held build");
  const staleBuild = H.builds.length;
  const sig = (s) => s.hexes.map((h) => h.terrain + (h.pip ?? "")).join();
  store.setState({ state: dealB });
  // Synchronously: the old land is gone, the new board's stand-ins, picks and tokens stand.
  const st = isle.landStatus();
  H.check("6 a new deal discards the old look before anything else is shown", isle.landLook === null && H.lookGroups().length === 0 && oldGroup.children.length === 0 && st.displayed === null && st.requested === "classic" && st.phase === "building", st);
  H.check("6 the new board's slabs stand in", isle.slabs && isle.slabs.parent === isle.land && isle.slabs.count === dealB.hexes.length);
  H.check("6 the new tokens carry the new deal's numbers", isle.tokens.map((t) => t.userData.token).join() === dealB.hexes.filter((h) => h.pip != null).map((h) => h.pip).join());
  H.check("6 the picks are the new board's, on the same ids", isle.pickables.length === dealB.hexes.length && isle.pickables.every((p) => dealB.hexes.some((h) => h.id === p.userData.id)));
  const made = H.made.length;
  gb.release();
  await H.until(() => H.ready("classic"), "classic on the new board", 120000);
  H.check("6 the held build of the old deal was cancelled and published nothing", H.builds.length === staleBuild + 1 && H.nulls === 1 && H.made.slice(made).length === 1 && H.live().length === 1, [H.builds.length, H.nulls, H.trace, H.made.slice(made).map((m) => m.disposed)]);
  H.check("6 the Classic look on screen is the new deal's", H.lookGroups().length === 1 && H.groupHexIds(H.lookGroups()[0]) === H.hexIds(dealB) && isle.landLook === H.live()[0].a);
  // A stale look from before the deal never shows its terrain: the ground under every hex is the new terrain's (the pit is a hole
  // only in clay).
  H.check("6 the board's slabs left once the look landed", isle.slabs === null);
  // The same land again (a rematch with the same seed, a new state of the same deal) keeps the look and builds nothing.
  const keep = isle.landLook;
  const builds = H.builds.length;
  const rematch = createGame({ seed: 4242, humans: [{ name: "Fir" }, { name: "Elm" }], bots: 0, winnerFirst: true });
  store.setState({ state: rematch });
  await H.sleep(200);
  H.check("6 a rematch on the same land keeps the look on screen and builds nothing", sig(rematch) === sig(dealB) && isle.landLook === keep && H.builds.length === builds && isle.landStatus().displayed === "classic" && isle.landStatus().phase === "ready");
  // A rematch with another deal is a new board.
  const gb2 = H.hold("build");
  const dealC = createGame({ seed: 777, humans: [{ name: "Fir" }, { name: "Elm" }], bots: 0, winnerFirst: true });
  store.setState({ state: dealC });
  H.check("6 a rematch with another deal discards the old land at once", isle.landLook === null && H.lookGroups().length === 0 && isle.slabs && isle.slabs.count === dealC.hexes.length && keep.group.children.length === 0, isle.landStatus());
  gb2.release();
  await H.until(() => H.ready("classic"), "classic after the rematch", 120000);
  H.check("6 and the look that follows is the new deal's", H.groupHexIds(H.lookGroups()[0]) === H.hexIds(dealC) && H.live().length === 1);
`);

// --- 7. Failures at each stage
for (const stage of ["import", "build", "compile"]) {
  await run(`failure ${stage}`, `
    const isle = window.__isle;
    isle.setLandLook("jelly");
    await H.until(() => H.ready("jelly"), "jelly");
    await H.settle();
    H.reset();
    const base = H.snap();
    const shown = isle.landLook;
    const group = H.lookGroups()[0];
    const shownRec = H.made.find((m) => m.a === shown);
    const made0 = H.made.length;
    isle.retryMs = 25;
    H.fail.${stage} = true;
    isle.setLandLook("classic");
    await H.until(() => isle.landStatus().phase === "failed", "the failure", 60000);
    const s = isle.landStatus();
    const attempts = { import: H.imports.length, build: H.builds.length, compile: H.compiles.length }["${stage}"];
    H.check("7 ${stage}: the first attempt and five retries, no more", attempts === 6 && s.retries === 5 && s.maxRetries === 5, [attempts, s]);
    H.check("7 ${stage}: the failure is named and the choice stays requested", s.error === "Classic could not load" && s.requested === "classic" && s.displayed === "jelly", s);
    H.check("7 ${stage}: the Jelly land that matches the board stays on screen, untouched", isle.landLook === shown && H.lookGroups().length === 1 && H.lookGroups()[0] === group && group.children.length > 0 && shownRec.disposed === 0);
    H.check("7 ${stage}: nothing built by the failed attempts is left", H.made.slice(made0).every((m) => m.disposed === 1) && H.live().length === 1, H.made.slice(made0).map((m) => m.disposed));
    await H.sleep(400);
    const later = { import: H.imports.length, build: H.builds.length, compile: H.compiles.length }["${stage}"];
    H.check("7 ${stage}: no further attempt is scheduled", later === 6 && isle.landStatus().phase === "failed", later);
    H.check("7 ${stage}: the shared scene is unchanged by the failure", H.diff(base, H.snap()).length === 0, H.diff(base, H.snap()));
    H.fail = {};
    isle.retryLand();
    H.check("7 ${stage}: an explicit retry renews the retries and the status", isle.landStatus().retries === 0 && isle.landStatus().error === null && isle.landStatus().phase === "building", isle.landStatus());
    await H.until(() => H.ready("classic"), "recovery");
    H.check("7 ${stage}: the retry recovers the requested look and clears the message", isle.landStatus().error === null && isle.landStatus().retries === 0 && H.lookGroups().length === 1 && H.lookGroups()[0].name === "classic-board" && group.children.length === 0 && H.live().length === 1);
    isle.retryMs = 4000;
  `);
}

// --- 8. Failure on a new board: the stand-ins, never the old land; cancellation stops the retries
await run("failure new board", `
  const isle = window.__isle;
  const { createGame } = await import("/src/lib/game/board.ts");
  const store = window.__emberisle;
  H.reset();
  isle.setLandLook("classic");
  await H.until(() => H.ready("classic"), "classic");
  const old = H.lookGroups()[0];
  isle.retryMs = 25;
  H.fail.import = true;
  const deal = createGame({ seed: 31337, humans: [{ name: "Elm" }, { name: "Fir" }], bots: 0 });
  store.setState({ state: deal });
  await H.until(() => isle.landStatus().phase === "failed", "the failure", 60000);
  const s = isle.landStatus();
  H.check("8 a failed look on a new deal leaves the new stand-ins and none of the old land", isle.landLook === null && H.lookGroups().length === 0 && old.children.length === 0 && isle.slabs && isle.slabs.parent === isle.land && s.displayed === null && s.retries === 5 && s.error === "Classic could not load", s);
  H.check("8 the board still plays: tokens and picks are the new deal's", isle.tokens.length === deal.hexes.filter((h) => h.pip != null).length && isle.pickables.length === deal.hexes.length);
  H.fail = {};
  isle.retryLand();
  await H.until(() => H.ready("classic"), "recovery on the new board");
  H.check("8 an explicit retry recovers on the new board", H.groupHexIds(H.lookGroups()[0]) === H.hexIds(deal) && isle.slabs === null);
  // A pending retry is cancelled by a newer request.
  isle.retryMs = 300;
  H.reset();
  H.fail.import = true;
  isle.setLandLook("jelly");
  await H.until(() => isle.landStatus().phase === "waiting", "a retry to be scheduled");
  const n = H.imports.length;
  H.check("8 while waiting to retry, the status says so and shows the old look", isle.landStatus().displayed === "classic" && isle.landStatus().error === "Jelly could not load" && isle.landStatus().retries === 0, isle.landStatus());
  H.fail = {};
  isle.setLandLook("classic");
  await H.sleep(700);
  H.check("8 a newer request suppresses the scheduled retry and its error", H.imports.length === n && isle.landStatus().error === null && isle.landStatus().phase === "ready" && H.ready("classic"), [H.imports.length, n, isle.landStatus()]);
  // Retrying when nothing failed does nothing.
  const before = H.imports.length;
  isle.retryLand();
  await H.sleep(100);
  H.check("8 retry with nothing failed does nothing", H.imports.length === before && isle.landStatus().phase === "ready");
  isle.retryMs = 4000;
  isle.setLandLook("jelly");
  await H.until(() => H.ready("jelly"), "jelly");
`);

// --- 9. Immutable visibility updates, glow, the blocked hex, and no replay
await run("presentation", `
  const isle = window.__isle;
  const store = window.__emberisle;
  H.reset();
  isle.setLandLook("jelly");
  await H.until(() => H.ready("jelly"), "jelly");
  const state = store.getState().state;
  const rob = state.robberHex;
  const ids = state.hexes.filter((h) => h.pip != null).slice(0, 2).map((h) => h.id);
  // A paying flash in progress, and pieces still paying.
  isle.flashHexes(ids);
  isle.payingPieces = [{ key: "v:x", age: 0, delay: 0, sounded: true }];
  const flashes = [...isle.flashes];
  const paying = [...isle.payingPieces];
  const replays = [];
  for (const m of ["flashHexes", "pulsePayers", "clearPayers"]) {
    const f = isle[m].bind(isle);
    isle[m] = (...a) => (replays.push(m), f(...a));
  }
  const plays = H.plays;
  const before = H.snap();
  H.events.length = 0;
  isle.setLandLook("classic");
  await H.until(() => H.ready("classic"), "classic");
  const rec = H.made.find((m) => m.look === "classic" && !m.disposed);
  const look = rec.a;
  const names = rec.calls.map((c) => c.name);
  H.check("9 the new look is never rolled or tapped by a switch", !names.includes("roll") && !names.includes("tap"), names);
  H.check("9 the new look is given the blocked hex before it shows", rec.calls.some((c) => c.name === "robber" && c.args[0] === rob) && look.hexes.get(rob).dull === look.hexes.get(rob).dullTo && look.hexes.get(rob).dullTo === 1, [rob]);
  const glows = rec.calls.filter((c) => c.name === "glow");
  H.check("9 it is given the paying glow under way", ids.every((id) => glows.some((g) => g.args[0] === id)) && glows.every((g) => g.args[1] >= 0), glows.map((g) => g.args));
  H.check("9 no flash or paying piece was started again: what remains are the original entries", replays.length === 0 && isle.flashes.every((f) => flashes.includes(f)) && isle.payingPieces.every((p) => paying.includes(p)), replays);
  H.check("9 no sound played and no game action ran", H.plays === plays && store.getState().state === before.store.state && store.getState().state.seq === before.store.seq);
  // Visibility contexts: frozen copies, no scene object, sent when the view changes.
  const ctxs = rec.calls.filter((c) => c.name === "setVisibilityContext").map((c) => c.args[0]);
  H.check("9 the look was given a visibility context before it was shown", ctxs.length >= 1 && H.events.findIndex((e) => e.name === "classic.setVisibilityContext") < H.events.findIndex((e) => e.name === "living.add:classic-board"));
  const n0 = ctxs.length;
  window.__emberisle.getState().setViewChoice("overhead");
  isle.wake();
  await H.until(() => rec.calls.filter((c) => c.name === "setVisibilityContext").length > n0, "a context after the view changed", 60000);
  window.__emberisle.getState().setViewChoice("diorama");
  isle.wake();
  await H.until(() => rec.calls.filter((c) => c.name === "setVisibilityContext").at(-1).args[0].view === "diorama", "a diorama context", 60000);
  await H.settle();
  const all = rec.calls.filter((c) => c.name === "setVisibilityContext").map((c) => c.args[0]);
  const c = all.at(-1);
  const plain = (o) => o === null || typeof o !== "object" ? true : Object.getPrototypeOf(o) === Object.prototype || Array.isArray(o) ? Object.values(o).every(plain) : false;
  const frozen = (o) => o === null || typeof o !== "object" ? true : Object.isFrozen(o) && Object.values(o).every(frozen);
  H.check("9 every context is plain data, deeply frozen", all.every(plain) && all.every(frozen), Object.keys(c));
  H.check("9 each context is a new object, never the last one mutated", new Set(all).size === all.length && all.at(-1) !== all.at(-2));
  H.check("9 it carries the view, the eye, the azimuth and one pose per token", c.view === "diorama" && Number.isFinite(c.camera.y) && Number.isFinite(c.azimuth) && c.tokens.length === isle.tokens.length, [c.view, c.tokens.length]);
  const t0 = isle.tokens[0];
  H.check("9 a token's pose is copied by value, its glyph's lowest row just above its face", c.tokens[0].x === t0.position.x && c.tokens[0].z === t0.position.z && c.tokens[0].glyphBottom < c.tokens[0].y + 0.06 && c.tokens[0].glyphBottom > c.tokens[0].y - 0.2, c.tokens[0]);
  const snapshot = JSON.stringify(c);
  t0.position.y += 5;
  H.check("9 moving a token afterwards cannot change a context already sent", JSON.stringify(c) === snapshot);
  t0.position.y -= 5;
  H.check("9 the overhead view was told apart from the diorama", all.some((x) => x.view === "overhead") && all.some((x) => x.view === "diorama"), all.map((x) => x.view));
`);

// --- 10. Token clearance (the lite Classic ground; the full props are proven in 12)
await run("clearance", `
  const isle = window.__isle;
  H.reset();
  isle.setLandLook("classic");
  await H.until(() => H.ready("classic"), "classic");
  window.__emberisle.getState().setViewChoice("diorama");
  await H.settle();
  const r = H.sights();
  H.check("10 the sight line to every numeral's lowest row clears the Classic look's props", r.tested === isle.tokens.length && r.tested > 0 && r.hits.length === 0, r);
`);

// --- 11. Disposal and cancellation on a renderer of its own
await run("disposal", `
  const { IsleRenderer } = await import("/src/lib/scene/isle-renderer.ts");
  const { createGame } = await import("/src/lib/game/board.ts");
  const mk = async () => {
    const c = document.createElement("canvas");
    c.style.cssText = "position:fixed;left:0;top:0;width:320px;height:240px";
    document.body.appendChild(c);
    const r = new IsleRenderer(c, () => {}, () => {});
    const log = { imports: 0, builds: 0, made: [], compiles: 0, gates: {} };
    const real = r.loadLook;
    r.loadLook = async (look) => {
      log.imports++;
      await (log.gates.import ?? 0);
      const make = await real(look);
      return async (...a) => {
        log.builds++;
        await (log.gates.build ?? 0);
        const x = await make(...a);
        if (x) {
          const d = x.dispose.bind(x);
          const rec = { disposed: 0, a: x };
          x.dispose = () => (rec.disposed++, d());
          log.made.push(rec);
        }
        return x;
      };
    };
    const compile = r.compileLook;
    r.compileLook = async (a) => (log.compiles++, await (log.gates.compile ?? 0), compile(a));
    r.setBoard(createGame({ seed: 99, humans: [{ name: "Elm" }], bots: 0 }), { vertices: [], edges: [], hexes: [] }, false);
    r.wake?.();
    return { r, c, log };
  };
  const hold = (log, stage) => {
    let release;
    log.gates[stage] = new Promise((res) => (release = res));
    return () => (log.gates[stage] = null, release());
  };
  // Disposed during the import.
  {
    const { r, c, log } = await mk();
    const go = hold(log, "import");
    await H.until(() => log.imports === 1, "the import");
    r.dispose();
    go();
    await H.sleep(500);
    H.check("11 disposed during the import: nothing is built or shown", log.builds === 0 && r.landLook === null && r.landStatus().phase !== "ready");
    c.remove();
  }
  // Disposed during construction and during the compile: the finished look is disposed, never published.
  for (const stage of ["build", "compile"]) {
    const { r, c, log } = await mk();
    const go = hold(log, stage);
    await H.until(() => (stage === "build" ? log.builds === 1 : log.compiles === 1), "the " + stage);
    r.dispose();
    go();
    await H.sleep(800);
    H.check("11 disposed during the " + stage + ": any look it finished is disposed, none is shown", r.landLook === null && r.living.children.filter((o) => /-board$/.test(o.name)).length === 0 && log.made.every((m) => m.disposed === 1), log.made.map((m) => m.disposed));
    c.remove();
  }
  // Disposed with a retry scheduled: no timer fires an attempt after it.
  {
    const { r, c, log } = await mk();
    r.retryMs = 150;
    const real = r.loadLook;
    r.loadLook = async (look) => (log.imports++, Promise.reject(new Error("down")));
    r.setLandLook("classic");
    await H.until(() => r.landStatus().phase === "waiting", "a retry");
    const n = log.imports;
    r.dispose();
    await H.sleep(700);
    H.check("11 disposed with a retry scheduled: the timer is cleared and no attempt follows", log.imports === n, [log.imports, n]);
    c.remove();
  }
  // Disposed while the look is showing: it is released.
  {
    const { r, c, log } = await mk();
    await H.until(() => r.landStatus().displayed === "jelly", "the look", 120000);
    const look = r.landLook;
    r.dispose();
    H.check("11 disposing the renderer releases the look on screen", r.landLook === null && look.group.children.length === 0);
    c.remove();
  }
`);

// --- 12. Reduced motion: a still pose on a Classic look, with its props, on a renderer of its own
{
  const rm = await open({ context: { reducedMotion: "reduce" }, quality: "full" });
  await play(rm.page);
  await rm.page.evaluate(installHarness);
  report(await rm.page.evaluate(async () => {
    const H = window.__H;
    const isle = window.__isle;
    H.reset();
    H.check("12 the reduced-motion preference is seen by the renderer", isle.calm());
    // The legacy override asks for the full board here: the Classic look is built with its props.
    isle.setLandLook("classic");
    await H.until(() => H.ready("classic"), "classic (full)", 240_000);
    const look = isle.landLook;
    H.check("12 the Classic look is the full board here, with its props", look.stats().quality === "full" && look.stats().drawCalls > look.stats().hexes, look.stats());
    const pose = () => {
      let h = 0;
      look.group.updateMatrixWorld(true);
      look.group.traverse((o) => {
        if (o.isInstancedMesh) for (const x of o.instanceMatrix.array.subarray(0, o.count * 16)) h = (h * 31 + Math.round(x * 1e5)) | 0;
        for (const x of o.matrix.elements) h = (h * 31 + Math.round(x * 1e5)) | 0;
      });
      return h;
    };
    const p0 = pose();
    for (let t = 1; t < 40; t += 0.5) look.update(t, false, true);
    H.check("12 under reduced motion the decorative motion holds still through forty seconds of scene time", pose() === p0 && !look.busy());
    for (let t = 41; t < 70; t += 0.25) look.update(t);
    H.check("12 and the same look does move when motion is allowed (the check can fail)", pose() !== p0);
    look.update(100, true, true);
    H.check("12 a snap lands the rest pose again", pose() === p0);
    // Token clearance with the full props: the sight lines clear in the diorama, and the check can fail (the same props, shown
    // as the overhead view leaves them, do stand in front of numerals).
    window.__emberisle.getState().setViewChoice("diorama");
    await H.settle();
    const real = H.sights();
    H.check("12 with the full props every numeral's lowest row is in sight from the diorama camera", real.view === "diorama" && real.props > 0 && real.tested === isle.tokens.length && real.hits.length === 0, real);
    const rec = H.made.find((m) => m.a === look);
    const last = rec.calls.filter((c) => c.name === "setVisibilityContext").at(-1).args[0];
    look.setVisibilityContext(Object.freeze({ ...last, view: "overhead" }));
    const raw = H.sights(0.12);
    H.check("12 the same props unadjusted do stand in front of numerals (the check can fail)", raw.hits.length > 0, raw.hits.length);
    look.setVisibilityContext(last);
    const fixed = H.sights(0.12);
    H.check("12 and the adjustment leaves fewer of them standing than unadjusted", fixed.hits.length < raw.hits.length && H.sights().hits.length === 0, [raw.hits.length, fixed.hits.length]);
    // Clearance holds in the rest pose and the camera both ways.
    isle.setLandLook("jelly");
    await H.until(() => H.ready("jelly"), "jelly (full)", 240_000);
    H.check("12 switching back under reduced motion lands Jelly, in one group", H.lookGroups().length === 1 && H.lookGroups()[0].name === "jelly-board" && H.live().length === 1);
    return H.take();
  }));
  await rm.ctx.close();
}

// --- 13. The Classic chunk is requested when asked for, and then once per failed retry URL at most
check("13 the Classic chunk was requested by the session that asked for it", requests.some((u) => /classic-board/.test(u)));
check("13 and not before it was asked for", classicBeforeAsk === 0, classicBeforeAsk);
check("14 no console errors", errors.length === 0, errors.slice(0, 5));

await ctx.close();
await browser.close();
await vite.close();
console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
