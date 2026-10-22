// #80: three headless tabs host, join, ready, start, roll off (#232), play setup and five rolls through server/host.mjs.
// Every step must land the same dice and board on all three tabs, with zero console errors.
// #308: `--seats 4` adds a fourth tab at 1280x720: the lobby seats four, setup runs 1-2-3-4-4-3-2-1, the rail shows
// four cards on every tab with none clipped, and the roll loop runs with four hands. A table trade (ask, answer)
// lands the same hands and goods counts on every tab at either size.
// #116: `--served` skips Vite. The host serves the built dist/ itself and the tabs open it with no ?host=,
// so they must find the socket at the address the page came from (the tunnel case). Run npm run build first.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const seatsArg = process.argv.indexOf("--seats");
const SEATS = seatsArg === -1 ? 3 : Number(process.argv[seatsArg + 1]);
if (![3, 4].includes(SEATS)) {
  console.log(`FAIL --seats ${SEATS}: the table seats 3 or 4`);
  process.exit(1);
}
// Four seats take their own port so this proof can run beside the three-seat one.
const PORT = SEATS === 4 ? 8103 : 8093;
const VIEWPORT = SEATS === 4 ? { width: 1280, height: 720 } : { width: 800, height: 500 };
const ROLLS = 5;
const SERVED = process.argv.includes("--served");
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
if (SERVED && !existsSync(`${DIST}index.html`)) {
  console.log("FAIL no dist/index.html: run npm run build first");
  process.exit(1);
}

// Rooms go to a temp folder, dropped on exit, so the real host never restores this proof's tables (#207).
const ROOMS_DIR = mkdtempSync(path.join(tmpdir(), "emberisle-rooms-"));
process.on("exit", () => rmSync(ROOMS_DIR, { recursive: true, force: true }));
const host = spawn(process.execPath, ["--import", "./register.mjs", "host.mjs"], {
  cwd: new URL("../server/", import.meta.url),
  env: { ...process.env, PORT: "0", DIST, ROOMS_DIR },
});
process.on("exit", () => host.kill());
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(130));
const hostPort = await new Promise((resolve) =>
  host.stdout.on("data", (d) => {
    const m = String(d).match(/listening (\d+)/);
    if (m) resolve(Number(m[1]));
  }),
);
const vite = SERVED
  ? null
  : await createServer({ server: { host: "127.0.0.1", port: PORT, strictPort: true }, logLevel: "error" });
await vite?.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
});

const errors = [];
let code = 0;

// The tab whose failed dials are expected right now (it is offline on purpose), or null.
let offlineTab = null;

// `url` is the page to open; the default is the plain Title page. #304's third tab opens the lobby's copied join link.
async function tab(name, url = SERVED ? `http://127.0.0.1:${hostPort}/` : `http://127.0.0.1:${PORT}/?host=ws://127.0.0.1:${hostPort}`) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  // Four 1280x720 islands under software GL can block a tab's renderer past Playwright's 30 s default for one
  // click or read; the proof's own waits (`until`) set their own windows.
  page.setDefaultTimeout(90_000);
  // A socket that fails while this tab is offline on purpose logs a console error (#196); everything else counts.
  page.on("console", (m) => m.type() === "error" && !(offlineTab === name && /WebSocket connection to .* failed/.test(m.text())) && errors.push(`${name}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${name}: ${e}`));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${name}: ${r.status()} ${r.url()}`));
  await page.addInitScript((n) => localStorage.setItem("emberisle-name", n), name);
  // #248: the page records every resource-flash label the moment it enters or leaves the DOM. Under software
  // GL on a loaded machine one island frame can take longer than the 1.2 s label, so a poll from outside the
  // page only gets to run between frames and can arrive after the label is gone. The observer cannot miss it.
  await page.addInitScript(() => {
    const log = (window.__flashes = []);
    const labels = (n) =>
      n.nodeType === 1 ? [n, ...n.querySelectorAll('[data-testid="resource-flash"]')].filter((e) => e.dataset.testid === "resource-flash") : [];
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) for (const e of labels(n)) log.push({ sign: "+", tag: `${e.dataset.resource}${e.dataset.delta}`, at: performance.now() });
        for (const n of m.removedNodes) for (const e of labels(n)) log.push({ sign: "-", tag: `${e.dataset.resource}${e.dataset.delta}`, at: performance.now() });
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(url);
  return { name, page };
}

// The shared part of a tab's state: everything the host sends to every seat alike.
const view = (t) =>
  t.page.evaluate(() => {
    const s = window.__emberisle.getState();
    const g = s.state;
    if (!g) return null;
    return {
      you: s.localId,
      legal: s.legal,
      mine: g.players.find((p) => p.id === s.localId)?.resources,
      shared: JSON.stringify({
        seq: g.seq,
        phase: g.phase,
        current: g.current,
        dice: g.dice,
        rollOff: g.rollOff,
        robberHex: g.robberHex,
        hexes: g.hexes,
        vertices: g.vertices,
        edges: g.edges,
        bank: g.bank,
        // Other players' hands arrive as a count only (#186), so the shared part is each hand's size.
        players: g.players.map((p) => ({
          id: p.id,
          goods: p.goods ?? Object.values(p.resources).reduce((a, b) => a + b, 0),
          vp: p.vp,
        })),
      }),
    };
  });

const views = (tabs) => Promise.all(tabs.map(view));
const seqOf = (v) => JSON.parse(v.shared).seq;

async function until(check, what, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const got = await check();
    if (got) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${what}`);
}

// Wait for every tab to pass `seq`, then require every tab's shared view to be identical.
async function synced(tabs, seq, what, ms) {
  const vs = await until(async () => {
    const vs = await views(tabs);
    return vs.every((v) => v && seqOf(v) > seq) && new Set(vs.map(seqOf)).size === 1 ? vs : null;
  }, what, ms);
  if (new Set(vs.map((v) => v.shared)).size !== 1) throw new Error(`${what}: tabs disagree on the board`);
  return vs;
}

const act = (t, fn, arg) => t.page.evaluate(([f, a]) => window.__emberisle.getState()[f](...[].concat(a)), [fn, arg]);

try {
  const a = await tab("Ember");
  const b = await tab("Tide");

  // #142: picking a color on the Title screen must reach the actual seat and game state.
  await a.page.locator(".seat-settings > summary").click();
  await a.page.getByRole("radio", { name: "Tide" }).click();
  await a.page.getByRole("button", { name: "Host a table" }).click();
  const tableCode = (await a.page.getByTestId("table-code").textContent()).trim();

  // #304: the lobby's Copy link writes `<this page>?code=<code>`, keeping `?host=` when the page has one. The
  // clipboard is stubbed in the page (headless Chromium's is not readable here), and tab C opens the copied link.
  await a.page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: (t) => ((window.__copied = t), Promise.resolve()) } }));
  await a.page.getByRole("button", { name: "Copy link" }).click();
  const link = await until(() => a.page.evaluate(() => window.__copied ?? null), "Copy link wrote the clipboard");
  const want = new URL(SERVED ? `http://127.0.0.1:${hostPort}/` : `http://127.0.0.1:${PORT}/?host=ws://127.0.0.1:${hostPort}`);
  want.searchParams.set("code", tableCode);
  const got = new URL(link);
  if (got.origin + got.pathname !== want.origin + want.pathname || got.searchParams.get("code") !== tableCode || got.searchParams.get("host") !== want.searchParams.get("host"))
    throw new Error(`Copy link wrote ${link}, wanted ${want.href}`);
  const c = await tab("Pine", link);
  const d = SEATS === 4 ? await tab("Dune") : null;
  const tabs = [a, b, c, ...(d ? [d] : [])];

  // #156/#271: before Join, the color the table already holds is dimmed and cannot be picked.
  const tideDims = async (t) => {
    await t.page.locator(".seat-settings > summary").click();
    const swatch = (n) => t.page.getByRole("radio", { name: n });
    await until(async () => {
      const tide = swatch("Tide (taken)");
      if (!(await tide.count()) || !(await tide.isDisabled())) return null;
      const [opacity, checked] = await tide.evaluate((el) => [getComputedStyle(el).opacity, el.getAttribute("aria-checked")]);
      return opacity === "0.35" && checked === "false" ? true : null;
    }, `Tide swatch dims on ${t.name} before Join`);
    for (const n of ["Ember", "Dune", "Pine"]) if (await swatch(n).isDisabled()) throw new Error(`${n} swatch is disabled on ${t.name}`);
  };
  await b.page.getByPlaceholder(/code/i).fill(tableCode);
  await tideDims(b);
  console.log("tab B typed the code: Tide swatch disabled at opacity 0.35, aria-checked=false; Ember, Dune, Pine enabled");
  // #304: tab C typed nothing. The link filled the field, the peek dimmed Tide, and the code is gone from the URL.
  await until(async () => ((await c.page.getByPlaceholder(/code/i).inputValue()) === tableCode ? true : null), "join link prefills tab C's Join field");
  await tideDims(c);
  const searchC = await c.page.evaluate(() => location.search);
  if (new URLSearchParams(searchC).has("code")) throw new Error(`tab C's URL still carries the code: ${searchC}`);
  if ((await c.page.evaluate(() => window.__emberisle.getState().screen)) !== "title") throw new Error("tab C left the Title before Join");
  if (d) await d.page.getByPlaceholder(/code/i).fill(tableCode);
  for (const t of tabs.slice(1)) {
    await t.page.getByRole("button", { name: "Join" }).click();
    await t.page.getByTestId("table-code").waitFor();
  }
  console.log(`join link: Pine joined from ?code=${tableCode} (link ${link}; URL after open: "${searchC || "/"}")`);
  for (const t of tabs) {
    await until(async () => {
      const counts = await Promise.all(tabs.map((o) => t.page.locator("li", { hasText: o.name }).count()));
      return counts.every((n) => n === 1) ? true : null;
    }, `${t.name} sees ${SEATS} seats`);
    await t.page.getByRole("button", { name: "Ready", exact: true }).click();
  }
  // #488: the chat dock is a lazy chunk the lobby already loaded, so it is in the HUD's first frame, never a frame late.
  for (const t of tabs) {
    await t.page.evaluate(() => {
      window.__dockFrame = new Promise((resolve) => {
        const tick = () => {
          if (!document.querySelector("header")) return requestAnimationFrame(tick);
          resolve(Boolean(document.querySelector('[aria-label="Table chat"], button[aria-label^="Open chat"]')));
        };
        requestAnimationFrame(tick);
      });
    });
  }
  await a.page.getByRole("button", { name: "Start" }).click();
  // #951: four 1280×720 islands under software GL on a busy CI runner often need longer than the
  // default 10 s for every tab to mount the started game. Wait for the real condition (identical
  // shared state on all tabs) with the same 90 s bound already used for the cold first roll; do
  // not loosen any later assertion.
  let vs = await synced(tabs, -1, "start", 90_000);
  for (const t of tabs) {
    if (!(await t.page.evaluate(() => window.__dockFrame))) throw new Error(`${t.name}: the chat dock missed the HUD's first frame`);
  }
  console.log(`chat dock on every tab in the HUD's first frame (${SERVED ? "built chunks" : "dev modules"})`);
  console.log(`table ${tableCode}: ${SEATS} seats, ${SEATS} tabs in, phase ${JSON.parse(vs[0].shared).phase}`);
  // Four 1280x720 islands under software GL starve every tab's HUD. The board is checked here as shared state and
  // the rail and dice are DOM, so at four seats each tab stops drawing the island (as trade-prove does).
  const stopIsland = async (t) => {
    if (SEATS !== 4) return;
    await until(() => t.page.evaluate(() => (window.__isle?.renderer ? (window.__isle.renderer.setAnimationLoop(null), true) : null)), `${t.name} island mounted`, 90_000);
  };
  for (const t of tabs) await stopIsland(t);

  const hostColor = await a.page.evaluate(() => {
    const s = window.__emberisle.getState();
    return s.state.players.find((p) => p.id === s.localId)?.color;
  });
  if (hostColor !== "#2d6ee8") throw new Error(`host picked Tide's color but the seat shows ${hostColor}`);
  console.log(`host's chosen color round-tripped into the game: ${hostColor}`);

  // #232: roll off for first place. Each die is rolled by the tab whose seat is current, and no tab
  // shows a production-roll banner meanwhile. `shared` carries the dice and the seat order.
  for (const t of tabs) {
    await t.page.evaluate(() => {
      window.__banners = [];
      window.__emberisle.subscribe((s) => s.banner && window.__banners.push(s.banner));
    });
  }
  let offRolls = 0;
  while (JSON.parse(vs[0].shared).phase === "rollOff") {
    if (++offRolls > 30) throw new Error("roll-off never ended");
    const cur = JSON.parse(vs[0].shared).current;
    const i = vs.findIndex((v) => v.you === cur);
    if (!vs[i].legal.actions.includes("roll")) throw new Error(`roll-off: ${tabs[i].name} is current but may not roll`);
    await act(tabs[i], "dispatch", [{ type: "roll" }]);
    vs = await synced(tabs, seqOf(vs[0]), `roll-off roll ${offRolls}`);
  }
  const off = JSON.parse(vs[0].shared);
  const offBanners = await Promise.all(tabs.map((t) => t.page.evaluate(() => window.__banners)));
  if (off.phase !== "setupSettle" || off.current !== off.players[0].id) throw new Error(`after the roll-off: ${off.phase}, ${off.current}`);
  if (offBanners.flat().some((x) => /'s roll · /.test(x))) throw new Error(`production banner during the roll-off: ${offBanners.flat().join(" | ")}`);
  console.log(`roll-off: ${offRolls} rolls, each by the current tab, shared on all ${SEATS} tabs; order ${off.players.map((p) => `${p.id} ${off.rollOff.rolls[p.id]}`).join(", ")}; no production banner`);

  // Setup: whoever's turn it is clicks the first glowing spot through the store. Two rounds, an outpost and a path each.
  for (let step = 0; step < SEATS * 4; step++) {
    const cur = JSON.parse(vs[0].shared).current;
    const i = vs.findIndex((v) => v.you === cur);
    const phase = JSON.parse(vs[i].shared).phase;
    if (phase === "setupSettle") await act(tabs[i], "pickVertex", vs[i].legal.outpost[0]);
    else await act(tabs[i], "pickEdge", vs[i].legal.path[0]);
    vs = await synced(tabs, seqOf(vs[0]), `setup step ${step}`);
  }
  if (JSON.parse(vs[0].shared).phase !== "roll") throw new Error(`after setup: ${JSON.parse(vs[0].shared).phase}`);

  // #196: tab B loses its connection and its network for 3 s. It dials again with its seat secret and
  // lands back in the same seat; the table (grace 90 s on the host) has not moved. Chromium keeps an
  // open socket alive under setOffline, so the drop itself comes from the client's drop() hook.
  const me = (t) => t.page.evaluate(() => ({ you: window.__emberisle.getState().localId, screen: window.__emberisle.getState().screen, error: window.__emberisle.getState().error, seq: window.__emberisle.getState().state?.seq ?? -1 }));
  const beforeB = await me(b);
  // #283: the board stays on screen through the rejoin; the lobby never shows and the HUD is not remounted.
  await b.page.evaluate(() => {
    window.__screens = [];
    window.__emberisle.subscribe((s) => window.__screens.push(s.screen));
  });
  const bannerB = await b.page.getByTestId("turn-banner").elementHandle();
  offlineTab = "Tide";
  await b.page.context().setOffline(true);
  await b.page.evaluate(() => window.__emberisle.getState().net.drop());
  const sawReconnecting = await until(async () => ((await me(b)).error?.startsWith("Reconnecting") ? true : null), "tab B notices the drop", 20_000);
  await new Promise((r) => setTimeout(r, 3000));
  await b.page.context().setOffline(false);
  const afterB = await until(async () => {
    const m = await me(b);
    return m.screen === "play" && !m.error && m.you === beforeB.you ? m : null;
  }, "tab B back in its seat", 90_000);
  await new Promise((r) => setTimeout(r, 1000)); // a dial already in flight when the network came back
  offlineTab = null;
  const screensB = await b.page.evaluate(() => window.__screens);
  if (screensB.includes("lobby")) throw new Error(`tab B flashed the lobby during the rejoin: ${screensB.join(",")}`);
  if (!(await bannerB.evaluate((el) => el.isConnected))) throw new Error("tab B's HUD remounted during the rejoin (turn banner detached)");
  console.log(`tab B screens during the rejoin: ${[...new Set(screensB)].join(",")}, turn banner still attached`);
  const back = await until(async () => ((await a.page.evaluate(() => window.__emberisle.getState().lobbyLog)) === "Tide is back." ? true : null), "host says Tide is back", 10_000);
  console.log(`tab B dropped 3 s: saw reconnecting=${sawReconnecting}, back as ${afterB.you} (was ${beforeB.you}), host log on A: Tide is back=${back}`);

  // #196: tab C reloads the page and rejoins from localStorage with the same seat.
  const beforeC = await me(c);
  await c.page.reload();
  const afterC = await until(async () => {
    const m = await me(c);
    return m.screen === "play" && !m.error && m.you === beforeC.you ? m : null;
  }, "tab C back after reload", 90_000); // the reloaded page may block on its cold render first (see the first roll below)
  console.log(`tab C reloaded: back as ${afterC.you} (was ${beforeC.you})`);
  await stopIsland(c);
  vs = await synced(tabs, -1, "after the drop and the reload");
  if (JSON.parse(vs[0].shared).phase !== "roll") throw new Error(`table moved during the blip: ${JSON.parse(vs[0].shared).phase}`);
  console.log(`setup done on all tabs, seq ${seqOf(vs[0])}`);

  // #308: one table trade through the store, run as a flash step below. The current seat asks the table for 1 card
  // another seat holds in return for 1 it holds, that seat says Yes, and every tab's next state shows both hands
  // moved and the same goods counts. Returns the move, or null when no pair of hands can trade this turn.
  let traded = null;
  const tableTrade = (i) => {
    const give = Object.keys(vs[i].mine).find((r) => vs[i].mine[r] > 0);
    if (!give) return null;
    for (const [j, v] of vs.entries()) {
      if (j === i) continue;
      const want = Object.keys(v.mine).find((r) => r !== give && v.mine[r] > 0);
      if (!want) continue;
      return async () => {
        const [asker, taker] = [vs[i], vs[j]];
        await tabs[i].page.evaluate(([g, w]) => window.__emberisle.getState().net.ask({ [g]: 1 }, { [w]: 1 }), [give, want]);
        const tradeId = await until(async () => {
          const ids = await Promise.all(tabs.map((t) => t.page.evaluate(() => window.__emberisle.getState().offer?.tradeId ?? null)));
          return ids.every((x) => x && x === ids[0]) ? ids[0] : null;
        }, "the offer reaches every tab");
        await tabs[j].page.evaluate((id) => window.__emberisle.getState().net.answer(id, true), tradeId);
        vs = await synced(tabs, seqOf(asker), "the table trade lands");
        await until(async () => ((await Promise.all(tabs.map((t) => t.page.evaluate(() => window.__emberisle.getState().offer ?? null)))).every((o) => !o) ? true : null), "offers cleared");
        const [a0, a1, b0, b1] = [asker.mine, vs[i].mine, taker.mine, vs[j].mine];
        if (a1[give] !== a0[give] - 1 || a1[want] !== a0[want] + 1) throw new Error(`asker hand ${JSON.stringify([a0, a1])}`);
        if (b1[give] !== b0[give] + 1 || b1[want] !== b0[want] - 1) throw new Error(`taker hand ${JSON.stringify([b0, b1])}`);
        const total = (h) => Object.values(h).reduce((x, y) => x + y, 0);
        const goods = JSON.parse(vs[0].shared).players;
        if (goods.find((p) => p.id === asker.you).goods !== total(a1) || goods.find((p) => p.id === taker.you).goods !== total(b1)) throw new Error(`goods counts ${JSON.stringify(goods)}`);
        traded = `${tabs[i].name} gave 1 ${give} for 1 ${want} from ${tabs[j].name}`;
      };
    }
    return null;
  };

  // Five rolls. Each roll is followed by any discards, the wayfarer, and a pass.
  // #322: tab C asks for reduced motion, so its dice faces must not animate at all.
  await c.page.emulateMedia({ reducedMotion: "reduce" });
  // #440: every tab records the faces of each roll moment as it mounts, so a roll is shown once on every tab, even on a
  // tab that is too blocked to be polled inside the moment's second.
  for (const t of tabs) {
    await t.page.evaluate(() => {
      window.__moments = [];
      let cur = null;
      new MutationObserver(() => {
        const m = document.querySelector('[data-testid="roll-moment"]');
        if (m && m !== cur) window.__moments.push([...m.querySelectorAll('[data-testid="die"]')].map((e) => Number(e.dataset.value)));
        cur = m;
      }).observe(document.body, { subtree: true, childList: true });
    });
  }
  const dice = [];
  let diceMatch = 0;
  for (let r = 0; r < ROLLS; r++) {
    const cur = JSON.parse(vs[0].shared).current;
    const i = vs.findIndex((v) => v.you === cur);
    // #534: every tab keeps one canonical roll/goods event, without a second transient banner.
    for (const t of tabs) await t.page.evaluate(() => window.__emberisle.setState({ banner: null }));
    await act(tabs[i], "dispatch", [{ type: "roll" }]);
    const slow = r === 0 ? 90_000 : undefined;
    vs = await synced(tabs, seqOf(vs[0]), `roll ${r + 1}`, slow);
    const events = await Promise.all(tabs.map((t) => t.page.evaluate(() => {
      const s = window.__emberisle.getState();
      return { text: s.gameLog.at(-1)?.text, banner: s.banner, hud: document.querySelector('[data-testid="log-line"]')?.textContent };
    })));
    if (new Set(events.map((e) => e.text)).size !== 1 || events.some((e) => e.banner || e.hud !== e.text)) throw new Error(`roll event differs or repeats: ${JSON.stringify(events)}`);
    const d = JSON.parse(vs[0].shared).dice;
    dice.push(d);
    const roller = await tabs[i].page.evaluate((id) => window.__emberisle.getState().state.players.find((p) => p.id === id)?.name, cur);
    const line = events[0].text;
    if (!line?.includes(`— ${roller}'s roll`) || /\d\+\d/.test(line)) throw new Error(`roll event: ${line}`);
    if (r === 0) console.log(`persistent roll event on all tabs: "${line}"; no goods banner`);
    for (const t of tabs) {
      const seen = await until(() => t.page.evaluate((n) => (window.__moments.length >= n ? window.__moments : null), r + 1), `roll moment on ${t.name} after roll ${r + 1}`, slow);
      if (seen.length !== r + 1 || seen[r].join() !== d.join()) throw new Error(`${t.name} roll moments ${JSON.stringify(seen)} after roll ${r + 1} of ${d}`);
    }
    if (r === 0) console.log(`roll moment on all tabs: ${d.join("+")}`);
    // #322: every tab rests the roll as two pip faces that match the authoritative shared dice.
    const sum = d[0] + d[1];
    for (const t of tabs) {
      const faces = await until(
        () =>
          t.page.evaluate((want) => {
            const els = [...document.querySelectorAll('[data-testid="dice-row"] [data-testid="die"]')];
            const values = els.map((e) => Number(e.dataset.value));
            if (els.length !== 2 || values.join("+") !== want) return null;
            return {
              values,
              authoritative: window.__emberisle.getState().state.dice,
              pips: els.map((e) => e.querySelectorAll("[data-pip]").length),
              label: els[0].closest('[role="img"]')?.getAttribute("aria-label"),
              motion: getComputedStyle(els[0]).animationName,
            };
          }, d.join("+")),
        `dice faces on ${t.name} after roll ${r + 1}`,
      );
      const [x, y] = faces.values;
      if (x + y !== sum) throw new Error(`${t.name} dice ${x}+${y} vs shared sum ${sum}`);
      if (faces.authoritative.join() !== faces.values.join()) throw new Error(`${t.name} dice ${x}+${y} vs host ${faces.authoritative.join("+")}`);
      if (faces.pips.join() !== faces.values.join()) throw new Error(`${t.name} dice ${x}+${y} drew ${faces.pips.join("+")} pips`);
      if (faces.label !== `Rolled ${x} and ${y}, ${sum}`) throw new Error(`${t.name} dice label "${faces.label}"`);
      const want = t === c ? "none" : "die-settle";
      if (faces.motion !== want) throw new Error(`${t.name} die animation ${faces.motion}, want ${want}`);
    }
    diceMatch++;

    for (let guard = 0; guard < 10; guard++) {
      const phase = JSON.parse(vs[0].shared).phase;
      if (phase === "roll") break;
      if (phase === "discard") {
        const j = vs.findIndex((v) => v.legal?.discard > 0);
        let need = vs[j].legal.discard;
        const cards = {};
        for (const [res, n] of Object.entries(vs[j].mine)) {
          const k = Math.min(n, need);
          if (k) cards[res] = k;
          need -= k;
        }
        await act(tabs[j], "dispatch", [{ type: "discard", resources: cards }]);
      } else if (phase === "robber") {
        const hexId = vs[i].legal.wayfarer[0];
        await act(tabs[i], "pickHex", hexId);
        const targets = vs[i].legal.steal[hexId];
        if (targets && targets.length > 1) await act(tabs[i], "chooseSteal", targets[0]);
      }
      else if (phase === "main") await act(tabs[i], "dispatch", [{ type: "endTurn" }]);
      else throw new Error(`unexpected phase ${phase}`);
      vs = await synced(tabs, seqOf(vs[0]), `after roll ${r + 1} (${phase})`);
    }
  }
  console.log(`${ROLLS} rolls, same on all ${SEATS} tabs: ${dice.map((d) => d.join("+")).join(" ")}`);
  console.log(`dice faces: ${diceMatch}/${ROLLS} match the log (pips, aria-label, no settle on the reduced-motion tab)`);

  // #170: a tab's own hand flashes +N green on a gain and -N red on a loss, and each flash goes away again.
  // Keep playing until a roll has paid someone and a bank trade, a discard, or a steal has taken something.
  // Every count that moves on a tab between two synced states must have flashed with its sign. The label is
  // read from the page's own record (see tab()), from the act on, so it is caught however long a frame takes.
  const flashesSince = (t, mark) => t.page.evaluate((m) => window.__flashes.slice(m), mark);
  const FLASH_MS = 1200; // keep equal to FLASH_MS in Hud.tsx: a label removed sooner than this fails
  let longest = 0;
  const step = async (what, go) => {
    const before = vs;
    const marks = await Promise.all(tabs.map((t) => t.page.evaluate(() => window.__flashes.length)));
    await go();
    vs = await synced(tabs, seqOf(before[0]), what);
    const seen = [];
    for (const [k, t] of tabs.entries()) {
      const diff = (r) => vs[k].mine[r] - before[k].mine[r];
      const tags = Object.keys(vs[k].mine).filter((r) => diff(r)).map((r) => `${r}${diff(r) > 0 ? "+" : ""}${diff(r)}`);
      if (!tags.length) continue;
      // The label and the new count land in the same commit, so by now the record has it.
      const shown = await flashesSince(t, marks[k]);
      const missing = tags.filter((tag) => !shown.some((f) => f.sign === "+" && f.tag === tag));
      if (missing.length) throw new Error(`${what}: ${t.name} never flashed ${missing.join(" ")} (saw ${shown.map((f) => f.sign + f.tag).join(" ") || "nothing"})`);
      // It is removed by a 1.2 s timer, which waits for the frames in progress; software-GL frames on a loaded
      // machine have kept a label up for 8 s.
      const gone = await until(async () => {
        const log = await flashesSince(t, marks[k]);
        return tags.every((tag) => log.some((f) => f.sign === "-" && f.tag === tag)) ? log : null;
      }, `${t.name}'s flash fades (${what})`, 20_000);
      for (const tag of tags) {
        const on = gone.find((f) => f.sign === "+" && f.tag === tag).at;
        const off = gone.find((f) => f.sign === "-" && f.tag === tag).at;
        if (off - on < FLASH_MS - 50) throw new Error(`${what}: ${t.name}'s ${tag} label lived ${Math.round(off - on)} ms, under FLASH_MS (${FLASH_MS}) - 50`);
        longest = Math.max(longest, off - on);
      }
      seen.push(...tags.map((tag) => `${t.name} ${tag}`));
    }
    return seen;
  };
  // A label from the rolls above can still be up; the HUD swaps a repeat of the same tag in one commit, and the
  // record would then read the old label's removal as the new one's fade.
  await until(async () => ((await Promise.all(tabs.map((t) => t.page.evaluate(() => document.querySelectorAll('[data-testid="resource-flash"]').length)))).every((n) => n === 0) ? true : null), "earlier flash labels gone", 20_000);
  const proved = { gain: null, loss: null };
  for (let turn = 0; turn < 40 && !(proved.gain && proved.loss && traded); turn++) {
    const cur = JSON.parse(vs[0].shared).current;
    const i = vs.findIndex((v) => v.you === cur);
    const seen = [await step(`flash roll ${turn + 1}`, () => act(tabs[i], "dispatch", [{ type: "roll" }]))];
    for (let guard = 0; guard < 10; guard++) {
      const phase = JSON.parse(vs[0].shared).phase;
      if (phase === "roll") break;
      let go;
      if (phase === "discard") {
        const j = vs.findIndex((v) => v.legal?.discard > 0);
        let need = vs[j].legal.discard;
        const cards = {};
        for (const [res, n] of Object.entries(vs[j].mine)) {
          const k = Math.min(n, need);
          if (k) cards[res] = k;
          need -= k;
        }
        go = () => act(tabs[j], "dispatch", [{ type: "discard", resources: cards }]);
      } else if (phase === "robber") {
        const hexId = vs[i].legal.wayfarer[0];
        const targets = vs[i].legal.steal[hexId];
        go = async () => {
          await act(tabs[i], "pickHex", hexId);
          if (targets && targets.length > 1) await act(tabs[i], "chooseSteal", targets[0]);
        };
      } else if (phase === "main") {
        const trade = traded ? null : tableTrade(i);
        if (trade) seen.push(await step("flash table trade", trade));
        const give = Object.keys(vs[i].mine).find((r) => vs[i].mine[r] >= 4);
        if (give) {
          const want = Object.keys(vs[i].mine).find((r) => r !== give);
          seen.push(await step(`flash bank trade ${give} for ${want}`, () => act(tabs[i], "dispatch", [{ type: "bankTrade", give, want }])));
        }
        go = () => act(tabs[i], "dispatch", [{ type: "endTurn" }]);
      } else throw new Error(`unexpected phase ${phase}`);
      seen.push(await step(`flash after roll ${turn + 1} (${phase})`, go));
    }
    for (const tag of seen.flat()) {
      if (tag.includes("+")) proved.gain ??= tag;
      else proved.loss ??= tag;
    }
  }
  if (!proved.gain || !proved.loss) throw new Error(`resource flash: gain ${proved.gain}, loss ${proved.loss}`);
  console.log(`resource flash: green "${proved.gain}" and red "${proved.loss}" each showed and went away (longest label ${Math.round(longest)} ms)`);
  if (!traded) throw new Error("no two hands could make a table trade in 40 turns");
  console.log(`table trade: ${traded}; hands and goods counts agree on all ${SEATS} tabs`);

  // #308: at four seats every tab's rail shows one card per seat, each wholly inside the 1280x720 viewport.
  if (SEATS === 4) {
    const ids = JSON.parse(vs[0].shared).players.map((p) => p.id);
    for (const t of tabs) {
      for (const id of ids) {
        const box = await t.page.getByTestId(`rail-${id}`).boundingBox();
        if (!box) throw new Error(`${t.name}: rail card ${id} is not on screen`);
        if (box.x < 0 || box.y < 0 || box.x + box.width > VIEWPORT.width || box.y + box.height > VIEWPORT.height)
          throw new Error(`${t.name}: rail card ${id} clipped at ${JSON.stringify(box)}`);
      }
    }
    console.log(`rail: ${ids.length} cards inside ${VIEWPORT.width}x${VIEWPORT.height} on all ${SEATS} tabs`);
  }
  if (errors.length) throw new Error(`console errors:\n${errors.join("\n")}`);
  console.log(`boards match on ${SEATS} tabs`);
  console.log(SERVED ? `tabs prove ok (served by the host on :${hostPort}, no ?host=)` : "tabs prove ok");
} catch (e) {
  console.log("FAIL", e.message);
  if (errors.length) console.log(errors.join("\n"));
  code = 1;
} finally {
  await browser.close();
  await vite?.close();
  host.kill();
  if (host.exitCode === null && host.signalCode === null) await Promise.race([once(host, "exit"), new Promise((r) => setTimeout(r, 3000).unref())]);
}
process.exit(code);
