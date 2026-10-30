// #1156: the Number tokens match setting through the real host. A new table starts on the official spiral; only the host may
// change it, only in the lobby or after a finished game, and only to "official" or "random". Every seat and a watcher get
// the same value; the dealt board is the generator's for that seed and setting; the value is saved and restored; an old
// room file without it loads as Random; a rematch keeps it (and takes a change made after the game ended).
// Run: npm run number-tokens-host-prove (also in server/package.json's test)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createGame } from "../src/lib/game/board.ts";

// The generator: same seed and setting, same board; no setting is the spiral; the two settings deal differently.
const deal = (seed, numberTokens) => createGame({ seed, humans: [{ name: "Ember" }, { name: "Tide" }, { name: "Pine" }], bots: 0, ...(numberTokens ? { numberTokens } : {}) }).hexes;
for (const seed of [1, 42, 1156, 987654321]) {
  for (const mode of ["official", "random"]) assert.deepEqual(deal(seed, mode), deal(seed, mode), `seed ${seed} ${mode}: same seed and setting, same board`);
  assert.deepEqual(deal(seed), deal(seed, "official"), `seed ${seed}: no setting deals the official spiral`);
  assert.notDeepEqual(deal(seed, "random").map((h) => h.pip), deal(seed, "official").map((h) => h.pip), `seed ${seed}: Random and the spiral deal different numbers`);
}
console.log("ok generator: same seed and setting give the same board; no setting is the spiral; Random differs, 4 seeds");

const dir = mkdtempSync(path.join(tmpdir(), "emberisle-number-tokens-"));
const sockets = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let host, port;
async function start() {
  let err = "";
  host = spawn(process.execPath, ["--import", "./register.mjs", "host.mjs"], { cwd: new URL(".", import.meta.url), env: { ...process.env, PORT: "0", ROOMS_DIR: dir, SAVE_MS: "20", GRACE_MS: "600000", HOLD_MS: "600000", LOBBY_HOLD_MS: "600000", TURN_MS: "600000", ACT_CAP: "1000", ACT_RATE: "1000" } });
  host.stderr.on("data", (d) => (err += d));
  port = await new Promise((resolve, reject) => {
    host.stdout.on("data", (d) => {
      const m = String(d).match(/listening (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    host.once("exit", (c) => reject(Error(`host ${c}: ${err}`)));
  });
}
async function stop() {
  for (const ws of sockets) ws.terminate();
  sockets.length = 0;
  if (host?.exitCode === null) {
    host.kill("SIGKILL");
    await new Promise((r) => host.once("exit", r));
  }
}
async function client(hello) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  let state;
  sockets.push(ws);
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    inbox.push(m);
    if (m.type === "state") state = m;
  });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "hello", ...hello }));
  const next = async (type, test = () => true) => {
    for (let n = 0; n < 500; n++) {
      const i = inbox.findIndex((m) => m.type === type && test(m));
      if (i >= 0) return inbox.splice(i, 1)[0];
      await wait(10);
    }
    throw Error(`timeout ${type}: ${JSON.stringify(inbox.slice(-2))}`);
  };
  const welcome = await next("welcome");
  return { ws, welcome, next, send: (m) => ws.send(JSON.stringify({ ...state?.actionStamp, cid: crypto.randomUUID(), ...m })) };
}
const file = (code) => path.join(dir, `${code}.json`);
async function saved(code, test) {
  for (let i = 0; i < 200; i++) {
    try {
      const s = JSON.parse(readFileSync(file(code)));
      if (test(s)) return s;
    } catch {}
    await wait(20);
  }
  throw Error(`save timeout ${code}`);
}
async function table() {
  const p = [await client({ name: "Ember" })];
  const code = p[0].welcome.code;
  for (const name of ["Tide", "Pine"]) p.push(await client({ code, name }));
  return { code, p };
}
// Every seat's latest seats broadcast carries `value`.
async function everySeat(t, value) {
  for (const peer of t.p) await peer.next("seats", (m) => m.numberTokens === value && m.seats.length === 3);
}
async function begin(t) {
  for (const a of t.p) a.send({ type: "ready", value: true });
  await t.p[0].next("seats", (m) => m.seats.length === 3 && m.seats.every((s) => s.ready));
  t.p[0].send({ type: "start" });
  return Promise.all(t.p.map((a) => a.next("state")));
}
// The board the host dealt is the generator's board for that game's seed and the table's setting, and not the other one's.
// A seat's view leaves the seed out, so it comes from the room file once that holds the board every seat was shown.
async function dealtWith(code, view, mode, label) {
  const game = (await saved(code, (s) => JSON.stringify(s.game?.hexes) === JSON.stringify(view.hexes))).game;
  assert.ok(Number.isSafeInteger(game.seed), `${label}: the room file holds the seed`);
  const other = mode === "official" ? "random" : "official";
  const make = (numberTokens) => createGame({ seed: game.seed, humans: game.players.map((p) => ({ name: p.name })), bots: 0, wayfarerMode: game.wayfarerMode, victoryTarget: game.victoryTarget, numberTokens }).hexes;
  assert.deepEqual(game.hexes.map((h) => [h.id, h.terrain, h.pip]), make(mode).map((h) => [h.id, h.terrain, h.pip]), `${label}: the board is the ${mode} deal for seed ${game.seed}`);
  assert.notDeepEqual(game.hexes.map((h) => h.pip), make(other).map((h) => h.pip), `${label}: the board is not the ${other} deal`);
  return game.seed;
}
const rejoin = async (t) => {
  const old = t.p.map((a) => a.welcome);
  t.p = [];
  for (const w of old) t.p.push(await client({ code: w.code, secret: w.secret }));
};

try {
  await start();
  // Default: the official spiral, in every welcome and seats message.
  const spiral = await table();
  const shuffled = await table();
  for (const t of [spiral, shuffled]) {
    for (const a of t.p) assert.equal(a.welcome.numberTokens, "official", "a new table's welcome says Official spiral");
    await everySeat(t, "official");
  }
  console.log("ok default: a new table is Official spiral in every seat's welcome and seats message");

  // Validation: a guest is refused; any value but the two is refused and changes nothing.
  shuffled.p[1].send({ type: "setNumberTokens", value: "random" });
  assert.equal((await shuffled.p[1].next("error")).message, "Only the host can choose the number tokens.");
  for (const value of ["spiral", "Random", "OFFICIAL", "", 7, true, null, ["random"], { value: "random" }, undefined]) {
    shuffled.p[0].send({ type: "setNumberTokens", value });
    assert.equal((await shuffled.p[0].next("error")).message, "Choose Official spiral or Random.", `refused ${JSON.stringify(value)}`);
  }
  assert.equal((await saved(shuffled.code, () => true)).numberTokens, "official", "refused values leave the saved setting alone");
  console.log("ok validation: a guest is refused; 10 other values refused with one message; nothing changed");

  // The host's choice reaches every seat and the room file.
  shuffled.p[0].send({ type: "setNumberTokens", value: "random" });
  await everySeat(shuffled, "random");
  await saved(shuffled.code, (s) => s.numberTokens === "random" && s.game === null);
  shuffled.p[0].send({ type: "setNumberTokens", value: "official" });
  await everySeat(shuffled, "official");
  shuffled.p[0].send({ type: "setNumberTokens", value: "random" });
  await everySeat(shuffled, "random");
  console.log("ok broadcast: Random, back to the spiral and Random again reach all 3 seats and the room file");

  // A lobby restart keeps the value, before any game is dealt.
  await saved(shuffled.code, (s) => s.numberTokens === "random");
  await saved(spiral.code, (s) => s.numberTokens === "official");
  await stop();
  await start();
  for (const t of [spiral, shuffled]) {
    await rejoin(t);
    const want = t === shuffled ? "random" : "official";
    for (const a of t.p) assert.equal(a.welcome.numberTokens, want, "a restored lobby's welcome keeps the setting");
    await everySeat(t, want);
  }
  console.log("ok lobby restore: both lobbies come back with their setting in every welcome");

  // The deal uses the setting; every seat and a watcher see the same board and value; the setting is fixed in play.
  for (const t of [spiral, shuffled]) {
    const mode = t === shuffled ? "random" : "official";
    const views = await begin(t);
    for (const v of views) assert.deepEqual(v.game.hexes, views[0].game.hexes, "every seat sees the same board");
    t.seed = await dealtWith(t.code, views[0].game, mode, `${t.code} first game`);
    t.hexes = views[0].game.hexes;
    t.p[0].send({ type: "setNumberTokens", value: mode === "random" ? "official" : "random" });
    assert.equal((await t.p[0].next("error", (m) => m.message.includes("fixed"))).message, "The number tokens are fixed for this game.");
    const w = await client({ code: t.code, watch: true });
    assert.equal(w.welcome.numberTokens, mode, "a watcher's welcome carries the setting");
    await saved(t.code, (s) => s.game?.seed === t.seed && s.numberTokens === mode);
  }
  console.log("ok deal: each board is the generator's for its seed and setting; seats and a watcher agree; live change refused");

  // Restart mid-game: same setting, same board.
  await wait(100);
  await stop();
  await start();
  for (const t of [spiral, shuffled]) {
    const mode = t === shuffled ? "random" : "official";
    await rejoin(t);
    for (const a of t.p) {
      assert.equal(a.welcome.numberTokens, mode, "a restored game's welcome keeps the setting");
      const v = await a.next("state");
      assert.deepEqual(v.game.hexes, t.hexes, "a restored game keeps its board");
    }
  }
  console.log("ok game restore: both games come back with the same setting and the same board");

  // An old room file (no numberTokens) loads as Random, in the lobby and in play, and its next deal is Random.
  const oldLobby = await table();
  const oldGame = await table();
  await begin(oldGame);
  await wait(100);
  await stop();
  for (const t of [oldLobby, oldGame]) {
    const s = JSON.parse(readFileSync(file(t.code)));
    assert.equal(s.numberTokens, "official");
    delete s.numberTokens;
    s.savedAt = Date.now();
    writeFileSync(file(t.code), JSON.stringify(s));
  }
  await start();
  for (const t of [oldLobby, oldGame]) {
    await rejoin(t);
    for (const a of t.p) assert.equal(a.welcome.numberTokens, "random", "an old room loads as Random");
  }
  await everySeat(oldLobby, "random");
  const oldViews = await begin(oldLobby);
  await dealtWith(oldLobby.code, oldViews[0].game, "random", "old lobby's first game");
  await saved(oldLobby.code, (s) => s.numberTokens === "random" && s.game);
  console.log("ok old rooms: a lobby and a game saved without the setting load as Random; the old lobby deals Random");

  // Rematch: end each game in its room file, restart, and start again. Unchanged tables keep their setting; a host who
  // changes it after the game ended gets the new one.
  const ended = [spiral, shuffled, oldGame];
  await wait(100);
  await stop();
  for (const t of ended) {
    const s = JSON.parse(readFileSync(file(t.code)));
    s.game.phase = "over";
    s.game.winner = "p0";
    s.game.seq++;
    s.savedAt = Date.now();
    writeFileSync(file(t.code), JSON.stringify(s));
  }
  await start();
  for (const t of ended) await rejoin(t);
  // The spiral table switches to Random once its game is over; the others keep theirs.
  spiral.p[0].send({ type: "setNumberTokens", value: "random" });
  await everySeat(spiral, "random");
  for (const [t, mode] of [[spiral, "random"], [shuffled, "random"], [oldGame, "random"]]) {
    const before = await t.p[0].next("state", (m) => m.game.phase === "over");
    t.p[0].send({ type: "again" });
    const views = await Promise.all(t.p.map((a) => a.next("state", (m) => m.game.seq === 0)));
    for (const v of views) assert.deepEqual(v.game.hexes, views[0].game.hexes, "every seat sees the rematch board");
    await dealtWith(t.code, views[0].game, mode, `${t.code} rematch`);
    await saved(t.code, (s) => s.numberTokens === mode);
    t.p[0].send({ type: "setNumberTokens", value: "official" });
    assert.equal((await t.p[0].next("error", (m) => m.message.includes("fixed"))).message, "The number tokens are fixed for this game.");
  }
  // And back: Random to the spiral after a rematch ends, then the next rematch deals the spiral.
  await wait(100);
  await stop();
  {
    const s = JSON.parse(readFileSync(file(shuffled.code)));
    s.game.phase = "over";
    s.game.winner = "p0";
    s.game.seq++;
    s.savedAt = Date.now();
    writeFileSync(file(shuffled.code), JSON.stringify(s));
  }
  await start();
  await rejoin(shuffled);
  const over = await shuffled.p[0].next("state", (m) => m.game.phase === "over");
  shuffled.p[0].send({ type: "setNumberTokens", value: "official" });
  await everySeat(shuffled, "official");
  shuffled.p[0].send({ type: "again" });
  const back = await Promise.all(shuffled.p.map((a) => a.next("state", (m) => m.game.seq === 0)));
  await dealtWith(shuffled.code, back[0].game, "official", "Random table switched to the spiral");
  // Unchanged after that: the spiral table's next rematch deals the spiral again.
  await wait(100);
  await stop();
  {
    const s = JSON.parse(readFileSync(file(shuffled.code)));
    s.game.phase = "over";
    s.game.winner = "p0";
    s.game.seq++;
    s.savedAt = Date.now();
    writeFileSync(file(shuffled.code), JSON.stringify(s));
  }
  await start();
  await rejoin(shuffled);
  for (const a of shuffled.p) assert.equal(a.welcome.numberTokens, "official");
  const again = await shuffled.p[0].next("state", (m) => m.game.phase === "over");
  shuffled.p[0].send({ type: "again" });
  const kept = await Promise.all(shuffled.p.map((a) => a.next("state", (m) => m.game.seq === 0)));
  await dealtWith(shuffled.code, kept[0].game, "official", "unchanged spiral rematch");
  console.log("ok rematch: unchanged Random, old-room and spiral tables keep their setting; a change after the game ends is used, both ways");
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
console.log("number-tokens-prove: hosted checks passed");
