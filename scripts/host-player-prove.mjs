// #944 in real browsers against real hosts: one live table per host player, and the browser identity behind it.
// Two players (separate browser profiles) each host an Open table and both are listed. A second tab of the same player
// is refused with "You're already hosting a table.". After the lobby handoff the old host opens again and the successor,
// whose kept seat bearer now names the host seat, is refused. Seat bearers are kept per host address: a second host is
// never sent the first host's bearers or the saved seat in a create. Storage that throws only costs the hint, never the
// create. Run with: node --import ./server/register.mjs scripts/host-player-prove.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const PORT = Number(process.env.VITE_PORT) || 8944;
const ALREADY = "You're already hosting a table.";
const KEY = "emberisle-host-seats:";
const dirs = [];
const hosts = [];
process.on("exit", () => {
  for (const h of hosts) h.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(130));
const hostLog = [];
function startHost(label) {
  const ROOMS_DIR = mkdtempSync(path.join(tmpdir(), `emberisle-host-player-ui-${label}-`));
  dirs.push(ROOMS_DIR);
  const h = spawn(process.execPath, ["--import", "./register.mjs", "host.mjs"], {
    cwd: new URL("../server/", import.meta.url),
    env: { ...process.env, PORT: "0", ROOMS_DIR, PROFILES_DIR: path.join(ROOMS_DIR, "profiles"), LOBBY_HOLD_MS: "30000", SAVE_MS: "9999999" },
  });
  hosts.push(h);
  h.stderr.on("data", (d) => hostLog.push(`${label}: ${String(d).trimEnd()}`));
  return new Promise((resolve) =>
    h.stdout.on("data", (d) => {
      hostLog.push(`${label}: ${String(d).trimEnd()}`);
      const m = String(d).match(/listening (\d+)/);
      if (m) resolve(Number(m[1]));
    }),
  );
}
const hostPort = await startHost("one");
const otherPort = await startHost("two");

const vite = await createServer({ server: { host: "127.0.0.1", port: PORT, strictPort: true }, logLevel: "error" });
for (let tries = 0; ; tries++) {
  try {
    await vite.listen();
    break;
  } catch (e) {
    if (e.code !== "EADDRINUSE" || tries >= 240) throw e;
    if (tries === 0) console.log(`port ${PORT} busy, waiting`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
});

const T0 = Date.now();
const errors = [];
const elapsed = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const check = (ok, what) => {
  if (!ok) {
    console.error(`FAIL ${what}`);
    if (hostLog.length) console.error("host log:\n" + hostLog.join("\n"));
    process.exit(1);
  }
  console.log(`ok ${what}`, elapsed());
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(100);
  }
  check(false, `timed out: ${what}`);
};
const urlFor = (port) => `http://127.0.0.1:${PORT}/?host=ws://127.0.0.1:${port}`;
const endpoint = (port) => `${KEY}ws://127.0.0.1:${port}`;

// One browser profile is one player: its tabs share localStorage. `blockHint` makes only the #944 key throw.
async function player(name, { blockHint = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(({ blockHint, KEY }) => {
    for (const fn of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]) {
      WebGL2RenderingContext.prototype[fn] = function () {};
    }
    if (!blockHint) return;
    for (const fn of ["getItem", "setItem"]) {
      const real = Storage.prototype[fn];
      Storage.prototype[fn] = function (key, ...rest) {
        if (String(key).startsWith(KEY)) throw new DOMException("blocked", "SecurityError");
        return real.call(this, key, ...rest);
      };
    }
  }, { blockHint, KEY });
  return { name, ctx };
}
// A tab with every hello it sends recorded, per socket URL.
async function tab(p, port = hostPort) {
  const page = await p.ctx.newPage();
  const hellos = [];
  page.on("console", (m) => m.type() === "error" && errors.push(`${p.name}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${p.name}: ${e}`));
  page.on("websocket", (ws) =>
    ws.on("framesent", (f) => {
      try {
        const msg = JSON.parse(String(f.payload));
        if (msg.type === "hello") hellos.push({ url: ws.url(), msg });
      } catch {}
    }),
  );
  await page.goto(urlFor(port));
  await page.getByTestId("title-card").waitFor();
  return { page, hellos };
}
async function host(t, name, open = true) {
  await t.page.locator("details.seat-settings summary").click();
  const input = t.page.locator('input[placeholder="Your name"]');
  await input.fill(name);
  await input.press("Escape");
  if (open) {
    const toggle = t.page.getByTestId("open-mode-toggle");
    await until(() => toggle.isVisible(), `${name}: open-mode toggle`);
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  }
  await t.page.getByRole("button", { name: "Host a table" }).click();
}
const inLobby = (t) => t.page.getByTestId("lobby-card").isVisible().catch(() => false);
const alertText = (t) => t.page.locator('p[role="alert"]').innerText().catch(() => "");
const state = (t) => t.page.evaluate(() => {
  const s = window.__emberisle.getState();
  // The lobby's seats broadcast says who holds the host seat now (isHost is only the welcome's answer).
  return { code: s.code, host: Boolean(s.seats.find((x) => x.id === s.seatId)?.host) };
});
const stored = (t) => t.page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
const listed = async () => (await (await fetch(`http://127.0.0.1:${hostPort}/tables`)).json()).map((t) => t.name).sort();

// --- Two players, one Open table each ---
const ember = await player("Ember");
const e1 = await tab(ember);
await host(e1, "Ember");
await until(() => inLobby(e1), "Ember's lobby");
const emberTable = await state(e1);
check(emberTable.code?.length === 4, `Ember hosts an Open table (${emberTable.code})`);
const tide = await player("Tide");
const t1 = await tab(tide);
await host(t1, "Tide");
await until(() => inLobby(t1), "Tide's lobby");
check(true, "a second player hosts a second Open table on the same host");
check(JSON.stringify(await listed()) === JSON.stringify(["Ember's table", "Tide's table"]), "both Open tables are listed at once");

// --- The bearer Ember's browser keeps, and only for this host ---
const emberSeat = JSON.parse((await stored(e1))["emberisle-seat"]);
const emberStore = await stored(e1);
check(emberStore[endpoint(hostPort)] === JSON.stringify([emberSeat.secret]), "the seat bearer is kept under this host's address");
check(Object.keys(emberStore).filter((k) => k.startsWith(KEY)).length === 1, "no other host address holds a bearer");
check(e1.hellos.every((h) => Array.isArray(h.msg.hostSeats) && h.msg.hostSeats.length === 0), "the first create sends no bearer");

// --- Same player, second tab: refused, nothing new listed ---
const e2 = await tab(ember);
await host(e2, "Ember");
await until(async () => (await alertText(e2)) === ALREADY, "Ember's second tab is refused");
check(!(await inLobby(e2)), `Ember's second tab shows "${ALREADY}" and stays on the title`);
const create2 = e2.hellos.filter((h) => !h.msg.code && !h.msg.secret);
check(create2.length === 1 && JSON.stringify(create2[0].msg.hostSeats) === JSON.stringify([emberSeat.secret]), "the refused create carried only this host's bearer");
check(JSON.stringify(await listed()) === JSON.stringify(["Ember's table", "Tide's table"]), "the refusal lists nothing new");
await e2.page.close();

// --- A different host is never sent this host's bearer or the saved seat ---
const away = await tab(ember, otherPort);
await host(away, "Ember");
await until(() => inLobby(away), "Ember's lobby on the other host");
const toOther = away.hellos.filter((h) => h.url.includes(`:${otherPort}`));
// The page-load rejoin of the saved seat (store.ts, #196) is older than #944 and out of its scope; only creates are checked.
const otherCreates = toOther.filter((h) => !h.msg.code && !h.msg.secret);
check(otherCreates.length === 1 && !JSON.stringify(otherCreates).includes(emberSeat.secret), "the create sent to the other host carries neither the first host's bearer nor the saved seat");
check(JSON.stringify(otherCreates[0].msg.hostSeats) === "[]", "the other host's create sends an empty bearer list");
const twoKeys = Object.keys(await stored(away)).filter((k) => k.startsWith(KEY)).sort();
check(JSON.stringify(twoKeys) === JSON.stringify([endpoint(hostPort), endpoint(otherPort)].sort()), "each host's bearer is kept under its own address");
await away.page.close();

// --- Handoff: Rowan joins Ember's table, Ember's tabs drop, Rowan becomes host ---
const rowan = await player("Rowan");
const r1 = await tab(rowan);
await r1.page.locator("details.seat-settings summary").click();
await r1.page.locator('input[placeholder="Your name"]').fill("Rowan");
await r1.page.locator('input[placeholder="Your name"]').press("Escape");
await until(() => r1.page.getByTestId("open-table-join").first().isVisible().catch(() => false), "Rowan sees the open tables");
await r1.page.getByRole("button", { name: "Join Ember's table" }).click();
await until(() => inLobby(r1), "Rowan's lobby");
for (const pg of ember.ctx.pages()) await pg.close();
await until(async () => (await state(r1)).host === true, "the host seat moves to Rowan");
check(true, "Ember's drop hands the host seat to Rowan");
const rowanSeat = JSON.parse((await stored(r1))["emberisle-seat"]);
check((await stored(r1))[endpoint(hostPort)] === JSON.stringify([rowanSeat.secret]), "Rowan's browser kept the bearer of the seat that now holds the host role");
check((await listed()).includes("Rowan's table"), "the listing follows the host seat to Rowan");

const e3 = await tab(ember);
await until(async () => (await e3.page.getByRole("button", { name: "Host a table" }).isVisible().catch(() => false)), "Ember's title after the drop");
await host(e3, "Ember");
await until(() => inLobby(e3), "Ember's new lobby");
const e3Create = e3.hellos.filter((h) => !h.msg.code && !h.msg.secret);
check(e3Create.length === 1 && e3Create[0].msg.hostSeats.includes(emberSeat.secret), "after the handoff Ember opens a new table, still sending the old bearer");
const emberNew = JSON.parse((await stored(e3))["emberisle-seat"]);
check(emberNew.secret !== emberSeat.secret && (await stored(e3))[endpoint(hostPort)] === JSON.stringify([emberSeat.secret, emberNew.secret]), "Ember's browser now keeps both of its seat bearers");

const r2 = await tab(rowan);
await host(r2, "Rowan");
await until(async () => (await alertText(r2)) === ALREADY, "Rowan's second tab is refused");
check(!(await inLobby(r2)), "the player who inherited the host seat cannot open another");
check(JSON.stringify(await listed()) === JSON.stringify(["Ember's table", "Rowan's table", "Tide's table"]), "Rowan's, Ember's new and Tide's tables are all listed");

// --- Blocked storage costs only the hint ---
const sage = await player("Sage", { blockHint: true });
const s1 = await tab(sage);
await host(s1, "Sage", false);
await until(() => inLobby(s1), "Sage's private lobby with blocked hint storage");
const sCreate = s1.hellos.filter((h) => !h.msg.code && !h.msg.secret);
check(sCreate.length === 1 && sCreate[0].msg.hostSeats.length === 0, "storage that throws sends no bearer and still creates a private table");
check(!(await listed()).includes("Sage's table"), "the private table is never listed");

check(errors.length === 0, `no console errors (found: ${errors.join(", ")})`);
console.log("host-player-prove ok: two Open tables, same-player refusal, per-host bearers, handoff frees and binds, blocked storage");
await browser.close();
await vite.close();
process.exit(0);
