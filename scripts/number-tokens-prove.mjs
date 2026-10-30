// #1156: the Number tokens setting in the browser, against the real host. At 320x568, 390x844, 844x390 and 1280x720 the
// lobby host opens Rules and finds "Number tokens" with Official spiral chosen and a plain sentence under it; the two
// choices are 44 px targets on screen; choosing Random reaches a guest's page, whose Rules show the value with no
// controls. In play, every seat's table menu How to play shows the table's setting, and both pages see one board. After a
// host restart with the game over, the host's rematch from the win screen keeps Random. Pictures: docs/proofs/1156/.
// Run: npm run number-tokens-prove
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const out = "docs/proofs/1156";
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), "emberisle-number-tokens-ui-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OFFICIAL = "Numbers run in the official spiral from an outer corner, skipping the wastes.";
const RANDOM = "Numbers are shuffled, and no 6 or 8 touches another 6 or 8.";
let host, hostPort;
async function start() {
  let stderr = "";
  host = spawn(process.execPath, ["--import", "./register.mjs", "host.mjs"], { cwd: new URL("../server/", import.meta.url), env: { ...process.env, PORT: "0", ROOMS_DIR: dir, SAVE_MS: "20", GRACE_MS: "600000", HOLD_MS: "600000", LOBBY_HOLD_MS: "600000", TURN_MS: "600000", ACT_CAP: "1000", ACT_RATE: "1000" }, stdio: ["ignore", "pipe", "pipe"] });
  host.stderr.on("data", (d) => (stderr += d));
  hostPort = await new Promise((resolve, reject) => {
    host.stdout.on("data", (d) => {
      const m = String(d).match(/listening (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    host.on("exit", (c) => reject(Error(`host ${c}: ${stderr}`)));
  });
}
async function stop() {
  host.kill("SIGKILL");
  await new Promise((r) => host.once("exit", r));
}
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await vite.listen();
const url = () => `http://127.0.0.1:${vite.httpServer.address().port}/?host=${encodeURIComponent(`ws://127.0.0.1:${hostPort}`)}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const errors = [];
async function client(name, viewport, seat) {
  const touch = viewport.width < 1000;
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1, reducedMotion: "reduce" });
  await context.addInitScript(([n, s]) => {
    localStorage.setItem("emberisle-name", n);
    localStorage.setItem("emberisle-jelly", "lite");
    localStorage.setItem("emberisle-water", "simple");
    if (s) {
      localStorage.setItem("emberisle-seat", JSON.stringify(s));
      localStorage.setItem("emberisle-seat-live", s.code);
    }
  }, [name, seat ?? null]);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name} ${viewport.width}: ${e}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name} ${viewport.width}: ${m.text()}`); });
  await page.goto(url());
  await page.waitForFunction(() => !!window.__emberisle);
  return page;
}
const tokens = (page) => page.evaluate(() => window.__emberisle.getState().tableNumberTokens);
// Opens the help from the lobby's Rules button or the table menu, and reads the setting block.
async function openHelp(page, from) {
  if (from === "lobby") await page.getByRole("button", { name: "Rules", exact: true }).click();
  else {
    await page.getByRole("button", { name: "Table menu" }).click();
    await page.getByRole("dialog", { name: "Table menu" }).getByRole("button", { name: "How to play" }).click();
  }
  const dialog = page.getByRole("dialog", { name: "How to play" });
  await dialog.waitFor();
  await page.getByTestId("number-tokens").waitFor();
  return dialog;
}
async function closeHelp(page) {
  await page.getByRole("dialog", { name: "How to play" }).getByRole("button", { name: "Close" }).click();
  await page.getByRole("dialog", { name: "How to play" }).waitFor({ state: "detached" });
}
async function readBlock(page) {
  return page.getByTestId("number-tokens").evaluate((el) => ({
    value: el.dataset.value,
    text: el.innerText.replace(/\s+/g, " ").trim(),
    buttons: [...el.querySelectorAll("button")].map((b) => {
      const r = b.getBoundingClientRect();
      return { label: b.textContent.trim(), pressed: b.getAttribute("aria-pressed"), x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }),
    help: document.getElementById("number-tokens-help")?.textContent,
    describedBy: el.querySelector('[role="group"]')?.getAttribute("aria-describedby") ?? null,
    groupLabel: el.querySelector('[role="group"]')?.getAttribute("aria-label") ?? null,
    sideways: [document.documentElement.scrollWidth - innerWidth, el.closest('[role="region"]').scrollWidth - el.closest('[role="region"]').clientWidth],
    vw: innerWidth,
    vh: innerHeight,
  }));
}
function hostControls(block, label, chosen) {
  assert.equal(block.groupLabel, "Number tokens", `${label}: the choices are a labelled group`);
  assert.equal(block.describedBy, "number-tokens-help", `${label}: the sentence describes the group`);
  assert.deepEqual(block.buttons.map((b) => [b.label, b.pressed]), [["Official spiral", String(chosen === "official")], ["Random", String(chosen === "random")]], `${label}: two choices, ${chosen} pressed`);
  for (const b of block.buttons) {
    assert.ok(b.width >= 44 && b.height >= 44, `${label}: ${b.label} is a 44 px target (${b.width}x${b.height})`);
    assert.ok(b.x >= 0 && b.y >= 0 && b.right <= block.vw && b.bottom <= block.vh, `${label}: ${b.label} is on screen`);
  }
  const [a, b] = block.buttons;
  assert.ok(Math.max(b.x - a.right, a.x - b.right, b.y - a.bottom, a.y - b.bottom) >= 7.99, `${label}: 8 px between the choices`);
  assert.deepEqual(block.sideways, [0, 0], `${label}: nothing overflows sideways`);
}

try {
  await start();
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1280, 720]]) {
    const label = `${width}x${height}`;
    const lead = await client("Jarrod", { width, height });
    await lead.evaluate(() => window.__emberisle.getState().hostTable());
    await lead.getByTestId("lobby-card").waitFor();
    const code = (await lead.getByTestId("table-code").textContent()).trim();
    const guest = await client("Josh", { width: 390, height: 844 });
    await guest.evaluate((c) => window.__emberisle.getState().joinTable(c), code);
    await guest.getByTestId("lobby-card").waitFor();
    await lead.waitForFunction(() => window.__emberisle.getState().seats.length === 2);
    assert.equal(await tokens(lead), "official", `${label}: a new table starts on the spiral`);
    assert.equal(await tokens(guest), "official", `${label}: the guest starts on the spiral`);
    await lead.evaluate(() => document.fonts.ready);

    // The host's lobby Rules: the setting, its sentence, two on-screen 44 px choices.
    await openHelp(lead, "lobby");
    let block = await readBlock(lead);
    assert.equal(block.value, "official");
    assert.equal(block.help, OFFICIAL, `${label}: the spiral's sentence sits under the setting`);
    hostControls(block, label, "official");
    await lead.getByTestId("number-tokens").scrollIntoViewIfNeeded();
    await lead.screenshot({ path: `${out}/${label}-official.png` });
    await lead.getByTestId("number-tokens").getByRole("button", { name: "Random", exact: true }).click();
    await lead.waitForFunction(() => document.querySelector('[data-testid="number-tokens"]')?.dataset.value === "random");
    block = await readBlock(lead);
    assert.equal(block.help, RANDOM, `${label}: Random's sentence replaces the spiral's`);
    hostControls(block, label, "random");
    await lead.screenshot({ path: `${out}/${label}.png` });
    await guest.waitForFunction(() => window.__emberisle.getState().tableNumberTokens === "random");

    // The guest's Rules: the same value and sentence, no controls.
    await openHelp(guest, "lobby");
    const seen = await readBlock(guest);
    assert.equal(seen.value, "random");
    assert.equal(seen.buttons.length, 0, `${label}: a guest has no controls`);
    assert.equal(seen.groupLabel, null);
    assert.equal(seen.text, `Number tokens: Random. ${RANDOM}`, `${label}: the guest reads the setting and its sentence`);
    if (width === 390) await guest.screenshot({ path: `${out}/guest-390x844.png` });
    await closeHelp(guest);
    await closeHelp(lead);
    // A guest's forged message is refused and changes nothing.
    await guest.evaluate(() => window.__emberisle.getState().net.setNumberTokens("official"));
    await guest.waitForFunction(() => window.__emberisle.getState().error === "Only the host can choose the number tokens.");
    assert.equal(await tokens(lead), "random");
    console.log(`ok ${label}: host Rules show Official spiral with its sentence, 44 px on-screen choices; Random reaches the guest, who reads it without controls; guest change refused`);

    if (width !== 390) {
      await lead.context().close();
      await guest.context().close();
      continue;
    }
    // In play: both seats' table menu help says Random, and both see one board.
    await lead.evaluate(() => window.__emberisle.getState().addBot());
    await lead.waitForFunction(() => window.__emberisle.getState().seats.length === 3);
    await guest.getByRole("button", { name: "Ready", exact: true }).click();
    await lead.getByRole("button", { name: "Ready", exact: true }).click();
    await lead.getByRole("button", { name: "Start", exact: true }).click();
    for (const p of [lead, guest]) await p.waitForFunction(() => window.__emberisle.getState().screen === "play" && !!window.__emberisle.getState().state);
    const boards = await Promise.all([lead, guest].map((p) => p.evaluate(() => window.__emberisle.getState().state.hexes.map((h) => [h.id, h.terrain, h.pip]))));
    assert.deepEqual(boards[0], boards[1], "both seats see one board");
    const file = path.join(dir, `${code}.json`);
    for (let i = 0; i < 200 && JSON.parse(readFileSync(file)).game === null; i++) await wait(20);
    const firstSeed = JSON.parse(readFileSync(file)).game.seed;
    const { createGame } = await vite.ssrLoadModule("/src/lib/game/board.ts");
    const deal = (seed, numberTokens) => createGame({ seed, humans: [{ name: "a" }, { name: "b" }, { name: "c" }], bots: 0, numberTokens }).hexes.map((h) => [h.id, h.terrain, h.pip]);
    assert.deepEqual(boards[0], deal(firstSeed, "random"), "the board on screen is the Random deal for the game's seed");
    for (const p of [lead, guest]) {
      await openHelp(p, "menu");
      const b = await readBlock(p);
      assert.equal(b.text, `Number tokens: Random. ${RANDOM}`, "in play every seat reads Random, without controls");
      if (p === lead) await lead.screenshot({ path: `${out}/play-390x844.png` });
      await closeHelp(p);
    }
    console.log("ok 390x844 in play: both seats' table menu help reads Random; one board, the Random deal for its seed");

    // End the game in the room file, restart the host, and rematch from the host's win screen: Random again.
    const hostSeat = await lead.evaluate(() => JSON.parse(localStorage.getItem("emberisle-seat")));
    await lead.context().close();
    await guest.context().close();
    await wait(100);
    await stop();
    const s = JSON.parse(readFileSync(file));
    s.game.phase = "over";
    s.game.winner = "p0";
    s.game.seq++;
    s.savedAt = Date.now();
    writeFileSync(file, JSON.stringify(s));
    await start();
    const end = await client("Jarrod", { width, height }, hostSeat);
    await end.getByTestId("win-screen").waitFor();
    assert.equal(await tokens(end), "random", "the restored table is still Random");
    // The guest's seat is let go on a rematch unless it is connected, so bring it back too; the bot stays.
    const guestSeat = { code, secret: s.seats.find((x) => x.name === "Josh").secret };
    const back = await client("Josh", { width: 390, height: 844 }, guestSeat);
    await back.getByTestId("win-screen").waitFor();
    await end.getByTestId("win-again").click();
    for (const p of [end, back]) await p.waitForFunction(() => window.__emberisle.getState().state?.phase === "rollOff");
    for (let i = 0; i < 200 && JSON.parse(readFileSync(file)).game.seed === firstSeed; i++) await wait(20);
    const rematch = JSON.parse(readFileSync(file)).game;
    assert.notEqual(rematch.seed, firstSeed, "the rematch is a new deal");
    assert.deepEqual(await end.evaluate(() => window.__emberisle.getState().state.hexes.map((h) => [h.id, h.terrain, h.pip])), deal(rematch.seed, "random"), "the rematch board is the Random deal for its seed");
    for (const p of [end, back]) {
      assert.equal(await tokens(p), "random");
      await openHelp(p, "menu");
      assert.equal((await readBlock(p)).text, `Number tokens: Random. ${RANDOM}`, "the rematch help reads Random");
      await closeHelp(p);
    }
    console.log("ok rematch: after a host restart, the host's Play again keeps Random for both seats and deals Random");
    await end.context().close();
    await back.context().close();
  }
  // Local games always deal the spiral, and their help says so without controls.
  const local = await client("Jarrod", { width: 1280, height: 720 });
  await local.evaluate(() => window.__emberisle.getState().startHotseat(3));
  await openHelp(local, "menu");
  const own = await readBlock(local);
  assert.equal(own.text, `Number tokens: Official spiral. ${OFFICIAL}`);
  assert.equal(own.buttons.length, 0);
  await local.context().close();
  console.log("ok local: a hotseat game's help reads Official spiral, without controls");
  assert.deepEqual(errors, [], "zero browser errors");
  console.log("number-tokens-prove: all passed; pictures in docs/proofs/1156/");
} finally {
  await browser.close();
  await vite.close();
  host?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
