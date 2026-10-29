// #944 on a real host: one live table per host player, not one open table per host server.
// Two players each open a table and both are listed; the same player's second create (open or private) is refused with
// "You're already hosting a table."; a handoff or a lobby Leave frees the old host and binds the new one; a finished game
// or a room with nobody connected never blocks. Identity is a verified profile, or for a guest the host-seat bearers its
// browser kept (`hostSeats`); a raw profile id, a guest seat's bearer and unknown or malformed bearers confer nothing.
// Run: cd server && node --import ./register.mjs host-player-prove.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createGame } from "../src/lib/game/board.ts";
import { chooseBotAction } from "../src/lib/game/ai.ts";
import { applyAction } from "../src/lib/game/rules.ts";
import { PLAYER_COLORS } from "../src/lib/game/types.ts";

const ALREADY = "You're already hosting a table.";
const dir = mkdtempSync(path.join(tmpdir(), "emberisle-host-player-"));
const ROOMS_DIR = path.join(dir, "rooms");
mkdirSync(ROOMS_DIR);
const sockets = [];
let host;
let checks = 0;
const watchdog = setTimeout(() => {
  console.error("FAIL host-player-prove exceeded 60s");
  process.exit(1);
}, 60_000);
process.on("exit", () => {
  host?.kill("SIGKILL");
  for (const c of sockets) c.ws.terminate();
  rmSync(dir, { recursive: true, force: true });
});
const check = (ok, why) => {
  assert.ok(ok, why);
  checks++;
  console.log("ok", why);
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// A finished game whose host seat is s1, with real bearers, so a reconnected host of an ended room can be tested.
const ended = (() => {
  let game = createGame({ humans: [{ name: "Ember" }, { name: "Tide" }], bots: 0, seed: 55 });
  for (let i = 0; i < 40 && game.phase !== "roll"; i++) {
    const r = applyAction(game, game.current, chooseBotAction(game, game.current));
    assert.ifError(r.error);
    game = r.state;
  }
  assert.equal(game.phase, "roll", "fixture completes real engine setup");
  game = { ...game, phase: "over", winner: "p1" };
  const seats = game.players.map((p, i) => ({ id: `s${i}`, name: p.name, color: p.color, ready: true, pid: p.id, secret: randomBytes(16).toString("hex") }));
  writeFileSync(path.join(ROOMS_DIR, "OVER.json"), JSON.stringify({ code: "OVER", host: "s1", next: 2, visibility: "open", recoveryPids: [], chat: [], chatSeq: 0, game, seats, shape: 2, savedAt: Date.now() }));
  return seats;
})();

host = spawn(process.execPath, ["--import", "./register.mjs", "host.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: { ...process.env, PORT: "0", ROOMS_DIR, PROFILES_DIR: path.join(dir, "profiles"), PROFILES_DEV: "1", OPEN_CAP: "100", OPEN_IP_CAP: "100", LOBBY_HOLD_MS: "30000", SAVE_MS: "9999999" },
});
const hostLog = [];
host.stderr.on("data", (d) => hostLog.push(String(d)));
try {
  const port = await new Promise((resolve, reject) => {
    host.stdout.on("data", (d) => {
      const m = String(d).match(/listening (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    host.once("error", reject);
    host.once("exit", (c) => reject(new Error(`host exited ${c}: ${hostLog.join("")}`)));
  });

  async function client() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "http://localhost" });
    const inbox = [];
    ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
    const c = {
      ws,
      inbox,
      send: (m) => ws.send(JSON.stringify(m)),
      async next(...types) {
        const end = Date.now() + 3000;
        while (Date.now() < end) {
          const i = inbox.findIndex((m) => types.includes(m.type));
          if (i >= 0) return inbox.splice(i, 1)[0];
          await settle(10);
        }
        throw new Error(`no ${types.join("/")}`);
      },
    };
    sockets.push(c);
    await once(ws, "open");
    return c;
  }
  // A create is a hello with no code: the welcome or the refusal comes back first.
  async function create(name, extra = {}) {
    const c = await client();
    c.send({ type: "hello", name, visibility: "open", ...extra });
    return { c, r: await c.next("welcome", "error") };
  }
  async function join(code, name) {
    const c = await client();
    c.send({ type: "hello", code, name });
    return { c, r: await c.next("welcome") };
  }
  // The WS list shares the host's discovery with GET /tables; one GET at the end proves they agree.
  async function listed() {
    const c = await client();
    c.send({ type: "list" });
    const { tables } = await c.next("openTables");
    c.ws.terminate();
    return tables.map((t) => t.code).sort();
  }
  const close = async (c) => {
    c.ws.close();
    await once(c.ws, "close");
    await settle(50);
  };
  const refused = (x) => x.r.type === "error" && x.r.message === ALREADY;

  // Two players, one open table each, both discoverable.
  const a = await create("Ember");
  check(a.r.type === "welcome" && a.r.host === true, "player A opens an open table");
  const b = await create("Tide");
  check(b.r.type === "welcome" && b.r.host === true, "player B opens a second open table on the same host");
  check(JSON.stringify(await listed()) === JSON.stringify([a.r.code, b.r.code].sort()), "both open tables are listed at once");

  // The same player's second create, open or private, is refused and lists nothing new.
  for (const visibility of ["open", "private"]) {
    const dupe = await create("Ember again", { visibility, hostSeats: [a.r.secret] });
    check(refused(dupe), `player A's second ${visibility} create says "${ALREADY}"`);
    dupe.c.ws.terminate();
  }
  check(JSON.stringify(await listed()) === JSON.stringify([a.r.code, b.r.code].sort()), "a refused create lists nothing new");

  // A private table counts as hosting too, and is never listed.
  const p = await create("Hidden", { visibility: "private" });
  check(p.r.type === "welcome", "player C opens a private table");
  check(refused(await create("Hidden again", { hostSeats: [p.r.secret] })), "the private host cannot open another table");
  check(!(await listed()).includes(p.r.code), "the private table is never listed");

  // A guest seat's bearer is not a host seat: sitting at someone's table does not block hosting your own.
  const g = await join(b.r.code, "Guest");
  const gOwn = await create("Guest own", { hostSeats: [g.r.secret] });
  check(gOwn.r.type === "welcome", "a seated guest of another table can still open their own");
  await close(gOwn.c);

  // Unknown, malformed and past-the-cap bearers confer nothing.
  const junk = await create("Unknown", { hostSeats: ["not-a-secret", "0".repeat(32), a.r.secret.toUpperCase(), 7, null] });
  check(junk.r.type === "welcome", "unknown or malformed bearers confer no host identity");
  await close(junk.c);
  const capped = await create("Capped", { hostSeats: [...Array.from({ length: 64 }, () => randomBytes(16).toString("hex")), a.r.secret] });
  check(capped.r.type === "welcome", "only the first 64 bearers are read");
  await close(capped.c);

  // Handoff: A's socket drops in the lobby, the host seat moves to the successor, A is free and the successor is bound.
  const s = await join(a.r.code, "Successor");
  await close(a.c);
  const end = Date.now() + 3000;
  while (Date.now() < end && !s.c.inbox.some((m) => m.type === "seats" && m.seats.some((x) => x.id === s.r.you && x.host))) await settle(10);
  check(s.c.inbox.some((m) => m.type === "seats" && m.seats.some((x) => x.id === s.r.you && x.host)), "a lobby drop hands the host seat to the connected successor");
  const aNew = await create("Ember new", { hostSeats: [a.r.secret] });
  check(aNew.r.type === "welcome", "after the handoff the old host opens a new table");
  check(refused(await create("Successor again", { hostSeats: [s.r.secret] })), "the new holder of the host seat cannot open another");
  check(JSON.stringify(await listed()) === JSON.stringify([a.r.code, aNew.r.code, b.r.code].sort()), "the handed-off table, the new one and B's are all listed");

  // Leave on purpose in the lobby: the leaver is no longer hosting, and the guest seated at B's table inherits the role.
  b.c.send({ type: "leave" });
  const until = Date.now() + 3000;
  while (Date.now() < until && !g.c.inbox.some((m) => m.type === "seats" && m.seats.some((x) => x.id === g.r.you && x.host))) await settle(10);
  check(g.c.inbox.some((m) => m.type === "seats" && m.seats.some((x) => x.id === g.r.you && x.host)), "B's Leave hands the host seat to the guest");
  const bNew = await create("Tide new", { hostSeats: [b.r.secret] });
  check(bNew.r.type === "welcome", "a host who leaves their table can open a new one");
  check(refused(await create("Guest again", { hostSeats: [g.r.secret] })), "the guest who inherited the host seat cannot open another");

  // A room with nobody connected never blocks.
  await close(s.c);
  const sFree = await create("Successor freed", { hostSeats: [s.r.secret] });
  check(sFree.r.type === "welcome", "a room with nobody connected does not block its host seat");
  await close(sFree.c);

  // An ended game never blocks, even with its host connected.
  const over = await client();
  over.send({ type: "hello", code: "OVER", secret: ended[1].secret });
  const back = await over.next("welcome");
  check(back.host === true && (await over.next("state")).game.phase === "over", "the host of a finished game is reconnected");
  const afterOver = await create("Winner", { hostSeats: [ended[1].secret] });
  check(afterOver.r.type === "welcome", "a finished game does not block its connected host");
  await close(afterOver.c);

  // Profiles: a verified profile is the identity; a raw profile id is nothing.
  const login = async (name) => {
    const c = await client();
    c.send({ type: "profileCreate", login: name, displayName: name, color: PLAYER_COLORS[0], backupColor: PLAYER_COLORS[1], pin: "2468", pinConfirm: "2468" });
    const session = await c.next("profileSession");
    c.ws.terminate();
    return session;
  };
  const one = await login("owner944");
  check(typeof one.credential === "string" && one.profile?.profileId, "profile one is created and signed in on the real host");
  const pOne = await create("Profile one", { visibility: "private", credential: one.credential });
  check(pOne.r.type === "welcome", "profile one hosts its first table");
  check(refused(await create("Profile one again", { credential: one.credential })), "profile one's second create from a fresh socket, with no bearers, is refused");
  const raw = await create("Raw id", { profileId: one.profile.profileId });
  check(raw.r.type === "welcome", "an unauthenticated raw profile id grants no identity");
  await close(raw.c);
  const two = await login("other944");
  const pTwo = await create("Profile two", { credential: two.credential, hostSeats: [pOne.r.secret] });
  check(pTwo.r.type === "welcome", "profile two is not blocked by profile one's bearer remembered in the same browser");
  check(refused(await create("Signed out", { hostSeats: [pOne.r.secret] })), "signed out, the browser's own remembered host-seat bearer still counts");

  // GET /tables still answers, with the same listing as the WS list.
  const http = await fetch(`http://127.0.0.1:${port}/tables`);
  check(http.status === 200, "GET /tables answers 200");
  check(JSON.stringify((await http.json()).map((t) => t.code).sort()) === JSON.stringify(await listed()), "GET /tables and the WS list agree");

  console.log(`host-player-prove: ${checks} checks passed`);
} catch (e) {
  if (hostLog.length) console.error("host log:\n" + hostLog.join(""));
  throw e;
} finally {
  clearTimeout(watchdog);
  for (const c of sockets) c.ws.terminate();
  host.kill();
  if (host.exitCode === null && host.signalCode === null) await once(host, "exit");
  rmSync(dir, { recursive: true, force: true });
}
