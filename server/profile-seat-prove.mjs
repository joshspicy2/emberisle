// Profiles on seats (#764, docs/design/profiles.md "Protocol and seat recovery", "Exactly-once recording").
// An optional credential on the initial host/join binds a verified profile to the seat; guests are unchanged; a seat secret,
// never a credential, recovers a seat; each game and rematch freezes its roster; table cards stay inside the asker's table.
// Every check runs through host.mjs's own sockets, with temporary room and profile stores that survive a real restart.
// Run from the repo root: node --import ./server/register.mjs server/profile-seat-prove.mjs
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { PLAYER_COLORS } from "../src/lib/game/types.ts";

const ROOMS_DIR = mkdtempSync(path.join(tmpdir(), "emberisle-rooms-"));
const PROFILES_DIR = mkdtempSync(path.join(tmpdir(), "emberisle-profiles-"));
const STORE = path.join(PROFILES_DIR, "profiles.json");
const GRACE = 400;
const HOLD = 4000;
const hosts = new Set();
process.on("exit", () => {
  for (const h of hosts) h.proc.kill("SIGKILL");
  rmSync(ROOMS_DIR, { recursive: true, force: true });
  rmSync(PROFILES_DIR, { recursive: true, force: true });
});
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(130));
setTimeout(() => fail("the proof ran past 240 s"), 240_000).unref();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREDENTIALS = new Set();
const LOGINS = ["emberlogin", "tidelogin", "pinelogin", "mosslogin"];
const sockets = new Set();
const tableFrames = [];
let passed = 0;

function fail(why, extra) {
  console.log("FAIL", why, extra === undefined ? "" : JSON.stringify(extra));
  process.exit(1);
}
function check(why, ok, extra) {
  if (!ok) fail(why, extra);
  passed++;
  console.log("ok", why);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startHost() {
  const proc = spawn(process.execPath, ["--import", "./register.mjs", "host.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, PORT: "0", ROOMS_DIR, PROFILES_DIR, PROFILES_DEV: "", GRACE_MS: String(GRACE), HOLD_MS: String(HOLD), LOBBY_HOLD_MS: "30000", TURN_MS: "600000", SAVE_MS: "50", ACT_CAP: "1000", ACT_RATE: "1000", RENAME_MS: "0" },
  });
  const h = { proc, log: "" };
  hosts.add(h);
  proc.stderr.on("data", (d) => (h.log += d));
  h.port = await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => {
      const m = String(d).match(/listening (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    proc.on("exit", (c) => reject(new Error(`host exited ${c}: ${h.log}`)));
  });
  h.stop = () =>
    new Promise((res) => {
      for (const ws of sockets) ws.terminate();
      sockets.clear();
      proc.removeAllListeners("exit");
      proc.once("exit", () => (hosts.delete(h), res()));
      proc.kill("SIGTERM");
    });
  return h;
}

// cloudflared's loopback hop for one visitor address: the transport a credential may use.
let nextIp = 10;
const TUNNEL = "isle-demo.trycloudflare.com";
const tunnel = (ip = `10.9.${nextIp++}.1`) => ({ origin: `https://${TUNNEL}`, host: TUNNEL, "cf-connecting-ip": ip, "x-forwarded-proto": "https" });

// A socket to the host. `table` sockets keep every frame for the private-field scan at the end.
async function client(h, headers = {}, table = true) {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}`, { headers });
  sockets.add(ws);
  const c = { ws, inbox: [], waiters: [], seats: null, state: null, welcome: null };
  ws.on("message", (raw) => {
    const text = String(raw);
    if (table) tableFrames.push(text);
    const msg = JSON.parse(text);
    if (msg.type === "seats") c.seats = msg;
    if (msg.type === "state") c.state = msg;
    if (msg.type === "welcome") c.welcome = msg;
    if (msg.credential) CREDENTIALS.add(msg.credential);
    c.inbox.push(msg);
    for (const w of c.waiters.splice(0)) w();
  });
  ws.on("error", () => {});
  c.send = (msg) => ws.send(JSON.stringify(msg));
  // The first queued message passing `ok`, or the moment `ok()` holds when it takes no argument.
  c.next = async (ok, ms = 8000, why = "a reply") => {
    const until = Date.now() + ms;
    for (;;) {
      const i = c.inbox.findIndex(ok);
      if (i >= 0) return c.inbox.splice(i, 1)[0];
      const left = until - Date.now();
      if (left <= 0) fail(`waited for ${why}`);
      await new Promise((res) => (c.waiters.push(res), setTimeout(res, left)));
    }
  };
  c.until = async (cond, ms = 8000, why = "a condition") => {
    const until = Date.now() + ms;
    while (!cond()) {
      const left = until - Date.now();
      if (left <= 0) fail(`waited for ${why}`);
      await new Promise((res) => (c.waiters.push(res), setTimeout(res, Math.min(left, 100))));
    }
  };
  let n = 0;
  c.req = async (msg) => {
    const id = `r${++n}`;
    c.send({ ...msg, id });
    return c.next((m) => m.id === id, 60000, `${msg.type} ${id}`);
  };
  c.reply = (ms = 8000) => c.next((m) => m.type === "welcome" || m.type === "error", ms, "welcome or error");
  c.close = () => new Promise((res) => (ws.readyState === ws.CLOSED ? res() : (ws.once("close", res), ws.close())));
  await new Promise((res, rej) => (ws.once("open", res), ws.once("unexpected-response", (_q, r) => rej(new Error(`upgrade ${r.statusCode}`)))));
  return c;
}

const readRoom = (code) => JSON.parse(readFileSync(path.join(ROOMS_DIR, `${code}.json`), "utf8"));
async function roomWhere(code, ok, why) {
  for (const until = Date.now() + 5000; Date.now() < until; await wait(30)) {
    try {
      const r = readRoom(code);
      if (ok(r)) return r;
    } catch {
      /* mid-write */
    }
  }
  fail(`room file ${code}: ${why}`);
}
const seatOf = (c, id) => c.seats?.seats.find((s) => s.id === id);
const isErr = (m, code) => m.type === "error" && m.code === code;
const cardErr = (m, code) => m.type === "profileError" && m.code === code;

// Profiles and remembered devices are written into the private store while no host runs, in the store's own schema (#762's
// documented proof method). Creation and sign-in have their own proof (profile-auth-prove); this one starts from signed-in
// devices, and every check below reads the store only through host.mjs's validate().
const store = () => JSON.parse(readFileSync(STORE, "utf8"));
function device(doc, profileId, now = Date.now()) {
  const token = randomBytes(32).toString("base64url");
  CREDENTIALS.add(token);
  doc.devices[createHash("sha256").update(token).digest("hex")] = { profileId, createdAt: now, expiresAt: now + 90 * 24 * 60 * 60 * 1000 };
  return token;
}
function seedProfile(doc, login, displayName, pin, catchphrase = "") {
  const id = randomUUID();
  const salt = randomBytes(16);
  const now = Date.now();
  doc.profiles[id] = {
    id, displayName, login, color: PLAYER_COLORS[1], backupColor: PLAYER_COLORS[0], catchphrase, winSongId: null, mediaKey: null, createdAt: now, updatedAt: now,
    pin: { alg: "scrypt", N: 16384, r: 8, p: 1, salt: salt.toString("base64"), hash: scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 }).toString("base64") },
    guard: { times: [], pending: {}, lifetime: 0 },
  };
  doc.logins[login] = id;
  return { id, credential: device(doc, id) };
}
const seed = { schemaVersion: 1, profiles: {}, logins: {}, reservedLogins: {}, tombstones: {}, devices: {}, unknownLogins: {} };
const A = seedProfile(seed, LOGINS[0], "Ember", "4821", "Burns bright");
const B = seedProfile(seed, LOGINS[1], "Tide", "1357");
const C = seedProfile(seed, LOGINS[2], "Pine", "2468");
const D = seedProfile(seed, LOGINS[3], "Moss", "9753");
// Ember's second device, used once her first is revoked.
const fresh = device(seed, A.id);
writeFileSync(STORE, JSON.stringify(seed));
console.log(`four profiles in the store: ${[A, B, C, D].map((p) => p.id.slice(0, 8)).join(" ")}`);

let h = await startHost();
const hello = await client(h, tunnel(), false);
check("the host opened the seeded store", (await hello.req({ type: "profileHello" })).available === true);
await hello.close();

// --- Guest compatibility ---------------------------------------------------------------------------------------------------
const g1 = await client(h);
g1.send({ type: "hello", name: "Guest" });
const gw = await g1.reply();
check("a guest host hello without a credential still opens a table", gw.type === "welcome" && gw.host === true, gw);
await g1.until(() => g1.seats, 3000, "guest seats");
check("a guest seat carries no profile field", g1.seats.seats.every((s) => !("profile" in s)), g1.seats);
const g2 = await client(h);
g2.send({ type: "hello", code: gw.code, name: "Guest two", credential: null });
check("credential: null is a guest join", (await g2.reply()).type === "welcome");
const plainCred = await client(h, { origin: `http://127.0.0.1:${h.port}` });
plainCred.send({ type: "hello", code: gw.code, name: "Sneak", credential: A.credential });
const pc = await plainCred.reply();
check("a credential over plain ws:// is refused before it is looked at; no seat", isErr(pc, "https") && !/profile/i.test(JSON.stringify(g1.seats)), pc);
plainCred.send({ type: "hello", code: gw.code, name: "Sneak" });
check("the refused socket can still sit down as a guest", (await plainCred.reply()).type === "welcome");
await g1.until(() => g1.seats.seats.length === 3, 3000, "three guest seats");
for (const c of [g1, g2, plainCred]) c.send({ type: "ready", value: true });
await wait(150);
g1.send({ type: "start" });
await g1.next((m) => m.type === "state", 5000, "guest game state");
const guestRoster = (await roomWhere(gw.code, (r) => r.roster, "guest roster")).roster;
check("a guest game freezes a roster with no profiles, all human and eligible", guestRoster.players.every((p) => p.profileId === null && p.kind === "human") && guestRoster.eligible === true && UUID.test(guestRoster.gameId), guestRoster);
check("guest room files carry no profile binding", readRoom(gw.code).seats.every((s) => !("profileId" in s)));
const guestFrames = [...tableFrames];
check("guest table frames carry no profile fields", !guestFrames.some((f) => /profile/i.test(f) && !f.includes('"code":"https"')));

// A one-human bot game is frozen as not eligible.
const solo = await client(h);
solo.send({ type: "hello", name: "Solo" });
const sw = await solo.reply();
solo.send({ type: "addBot" });
solo.send({ type: "addBot" });
solo.send({ type: "ready", value: true });
await solo.until(() => solo.seats?.seats.length === 3 && solo.seats.seats.every((s) => s.ready), 3000, "solo seats ready");
solo.send({ type: "start" });
await solo.next((m) => m.type === "state", 5000, "solo game state");
const soloRoster = (await roomWhere(sw.code, (r) => r.roster, "solo roster")).roster;
check("one human with two bots is frozen as not eligible, bots classed as bots", soloRoster.eligible === false && soloRoster.players.map((p) => p.kind).join() === "human,bot,bot", soloRoster);

// --- Attaching profiles on host and join -----------------------------------------------------------------------------------
const a = await client(h, tunnel());
a.send({ type: "hello", name: "Ember", credential: A.credential });
const wa = await a.reply();
check("a host hello with a valid credential opens a table", wa.type === "welcome" && wa.host, wa);
const T1 = wa.code;
await a.until(() => seatOf(a, wa.you)?.profile, 3000, "bound host seat");
check("the bound seat projects only profileId and displayName", Object.keys(seatOf(a, wa.you).profile).sort().join() === "displayName,profileId" && seatOf(a, wa.you).profile.profileId === A.id && seatOf(a, wa.you).profile.displayName === "Ember", seatOf(a, wa.you));
const bad = await client(h, tunnel());
bad.send({ type: "hello", code: T1, name: "Forger", credential: "A".repeat(43) });
check("an unknown credential is refused", isErr(await bad.reply(), "signedOut"));
bad.send({ type: "hello", code: T1, name: "Forger", credential: 12345 });
check("a malformed credential is refused", isErr(await bad.reply(), "signedOut"));
const b = await client(h, tunnel());
b.send({ type: "hello", code: T1, name: "Tide", credential: B.credential });
const wb = await b.reply();
check("a join with a valid credential sits down bound", wb.type === "welcome");
const twin = await client(h, tunnel());
twin.send({ type: "hello", code: T1, name: "Ember again", credential: A.credential });
check("the same profile cannot take a second seat", isErr(await twin.reply(), "profileSeated"));
// Two devices race to bind one profile: exactly one seat.
const [r1, r2] = await Promise.all([client(h, tunnel()), client(h, tunnel())]);
r1.send({ type: "hello", code: T1, name: "Pine", credential: C.credential });
r2.send({ type: "hello", code: T1, name: "Pine", credential: C.credential });
const race = await Promise.all([r1.reply(), r2.reply()]);
check("a duplicate-binding race seats one and refuses the other", race.filter((m) => m.type === "welcome").length === 1 && race.filter((m) => isErr(m, "profileSeated")).length === 1, race);
let c = race[0].type === "welcome" ? r1 : r2;
const wc = c.welcome;

// A held lobby seat is not recovered, or doubled, by its profile's credential.
await a.until(() => a.seats.seats.length === 3, 3000, "three seats");
await c.close();
await a.until(() => seatOf(a, wc.you)?.away, 3000, "Pine away");
const thief = await client(h, tunnel());
thief.send({ type: "hello", code: T1, name: "Pine", credential: C.credential });
const stolen = await thief.reply();
check("a credential alone cannot recover a held lobby seat", isErr(stolen, "profileSeated") && seatOf(a, wc.you)?.away === true, stolen);
c = await client(h);
c.send({ type: "hello", code: T1, secret: wc.secret });
const cBack = await c.reply();
check("the seat secret recovers the held lobby seat and its binding", cBack.type === "welcome" && cBack.you === wc.you);
await a.until(() => !seatOf(a, wc.you)?.away && seatOf(a, wc.you)?.profile?.profileId === C.id, 3000, "Pine back bound");
a.send({ type: "addBot" });
await a.until(() => a.seats.seats.length === 4, 3000, "four seats");
const botSeat = a.seats.seats.find((s) => s.bot);
check("a bot seat carries no profile", !("profile" in botSeat));
check("each profile is bound to exactly one seat", a.seats.seats.filter((s) => s.profile).map((s) => s.profile.profileId).sort().join() === [A.id, B.id, C.id].sort().join());
const lobbyFile = await roomWhere(T1, (r) => r.seats.length === 4, "four seats on disk");
check("the room file stores the opaque binding on each bound seat", lobbyFile.seats.filter((s) => s.profileId).map((s) => s.profileId).sort().join() === [A.id, B.id, C.id].sort().join() && lobbyFile.roster === null, lobbyFile.seats);
const lobbyText = readFileSync(path.join(ROOMS_DIR, `${T1}.json`), "utf8");
check("the room file holds no credential, login or profile record", ![...CREDENTIALS].some((x) => lobbyText.includes(x)) && !LOGINS.some((l) => lobbyText.includes(l)) && !/backupColor|guard|catchphrase|"pin"/.test(lobbyText));

// A rename in the lobby changes the starting name; the binding stays.
a.send({ type: "rename", name: "Ash" });
await a.until(() => seatOf(a, wa.you)?.name === "Ash", 3000, "rename");
check("a lobby rename keeps the profile binding", seatOf(a, wa.you).profile.profileId === A.id);

// A second table, for the cross-table checks.
const d = await client(h, tunnel());
d.send({ type: "hello", name: "Moss", credential: D.credential });
const wd = await d.reply();
const T2 = wd.code;
const dTwin = await client(h, tunnel());
dTwin.send({ type: "hello", code: T2, name: "Moss", credential: D.credential });
check("the refused second device ...", isErr(await dTwin.reply(), "profileSeated"));
dTwin.send({ type: "hello", code: T2, name: "Guesty" });
const dg = await dTwin.reply();
check("... stays at the join screen and can sit down as a guest", dg.type === "welcome");
await d.until(() => d.seats?.seats.length === 2, 3000, "T2 seats");
check("that guest seat has no profile", !("profile" in seatOf(d, dg.you)));

// --- Start: the frozen roster ----------------------------------------------------------------------------------------------
for (const x of [a, b, c]) x.send({ type: "ready", value: true });
await a.until(() => a.seats.seats.every((s) => s.ready), 3000, "all ready");
a.send({ type: "start" });
await a.next((m) => m.type === "state", 5000, "T1 state");
const r0 = (await roomWhere(T1, (r) => r.roster, "T1 roster")).roster;
const game0 = readRoom(T1).game;
check("the roster has a game UUID, start time, policy and eligibility", UUID.test(r0.gameId) && Number.isSafeInteger(r0.startedAt) && r0.v === 1 && r0.policy === 1 && r0.eligible === true, r0);
check("the roster freezes seats, profiles, starting names and classes in player order",
  r0.players.map((p) => `${p.seat}:${p.profileId}:${p.name}:${p.kind}`).join() === [`${wa.you}:${A.id}:Ash:human`, `${wb.you}:${B.id}:Tide:human`, `${wc.you}:${C.id}:Pine:human`, `${botSeat.id}:null:${botSeat.name}:bot`].join() &&
    r0.players.every((p, i) => p.pid === game0.players[i].id && p.color === game0.players[i].color), r0);
check("game state carries no profile, credential or login", !JSON.stringify(a.state).match(/profile|credential|login/i));
a.send({ type: "rename", name: "Ashen" });
const fixed = await a.next((m) => m.type === "error", 3000, "rename refusal");
check("a rename mid-game is refused and the roster is unchanged", fixed.message === "Names are fixed once the game starts." && JSON.stringify(readRoom(T1).roster) === JSON.stringify(r0));

// --- Watchers --------------------------------------------------------------------------------------------------------------
const wq = await client(h, tunnel());
wq.send({ type: "hello", code: T1, watch: true, credential: D.credential });
check("a watcher cannot attach a profile", isErr(await wq.reply(), "watcher"));
const w = await client(h);
w.send({ type: "hello", code: T1, watch: true });
check("a watcher without a credential watches", (await w.reply()).spectator === true);
w.send({ type: "hello", code: T1, name: "Moss", credential: D.credential });
check("a watcher's later hello with a credential is refused", (await w.next((m) => m.type === "error", 3000)).message === "Watching only.");
check("the watcher took no seat", (await a.until(() => a.seats.watching === 1, 3000, "watching count"), a.seats.seats.length === 4));

// --- Table cards -----------------------------------------------------------------------------------------------------------
const card = await b.req({ type: "tableProfileCard", profileId: A.id });
check("a seat reads a card of a profile at its table", card.type === "tableProfileCard" && card.card.displayName === "Ember" && card.card.catchphrase === "Burns bright", card);
check("the card is the public allowlist only", Object.keys(card.card).sort().join() === "catchphrase,displayName,profileId", card.card);
check("a watcher reads a card at the table it watches", (await w.req({ type: "tableProfileCard", profileId: B.id })).card?.profileId === B.id);
check("a seat cannot read a profile from another table", cardErr(await b.req({ type: "tableProfileCard", profileId: D.id }), "notFound"));
check("naming another room's code changes nothing", cardErr(await b.req({ type: "tableProfileCard", code: T2, profileId: D.id }), "notFound"));
check("a watcher cannot read a profile from another table", cardErr(await w.req({ type: "tableProfileCard", code: T2, profileId: D.id }), "notFound"));
check("the other table cannot read this one's profiles", cardErr(await d.req({ type: "tableProfileCard", profileId: A.id }), "notFound"));
check("a guest id or junk is not found", cardErr(await b.req({ type: "tableProfileCard", profileId: "s0" }), "notFound") && cardErr(await b.req({ type: "tableProfileCard" }), "notFound"));
const lone = await client(h);
check("a socket at no table reads no card", cardErr(await lone.req({ type: "tableProfileCard", code: T1, profileId: A.id }), "notAtTable"));

// --- Token-only recovery: a valid credential never recovers a held seat ------------------------------------------------------
await a.close();
await b.until(() => seatOf(b, wa.you)?.away, 3000, "Ash away");
const tokenOnly = await client(h, tunnel());
tokenOnly.send({ type: "hello", code: T1, name: "Ash", credential: A.credential });
const to = await tokenOnly.reply();
check("a valid credential alone cannot recover the held game seat", to.type === "error" && to.message === "Game already started." && seatOf(b, wa.you).away, to);
tokenOnly.send({ type: "hello", code: T1, secret: "0".repeat(32), credential: fresh });
check("a credential beside a wrong secret recovers nothing", (await tokenOnly.reply()).message === "Seat is gone.");
check("Ash's seat is still held, not handed to the credential", seatOf(b, wa.you).away && b.seats.seats.length === 4);

// --- Takeover --------------------------------------------------------------------------------------------------------------
await b.until(() => b.state?.game.players.find((p) => p.id === r0.players[0].pid)?.kind === "bot", GRACE + 4000, "bot takeover");
check("past the grace the bot plays Ash's seat", true);
check("the takeover keeps the frozen roster", JSON.stringify((await roomWhere(T1, (r) => r.game.players[0].kind === "bot", "takeover saved")).roster) === JSON.stringify(r0));
check("the seat keeps its public binding under the bot", seatOf(b, wa.you)?.profile?.profileId === A.id);
let a2 = await client(h);
a2.send({ type: "hello", code: T1, secret: wa.secret });
const back = await a2.reply();
check("Ash's seat secret recovers the seat after the takeover", back.type === "welcome" && back.you === wa.you);
await b.until(() => !seatOf(b, wa.you)?.away && seatOf(b, wa.you)?.profile?.profileId === A.id, 3000, "Ash back bound");
check("the rejoin restores the binding without a profile session", true);

// --- Seat expiry -----------------------------------------------------------------------------------------------------------
await c.close();
await b.until(() => b.seats.seats.length === 3, HOLD + 4000, "Pine let go");
check("Pine's seat is let go after the hold", !seatOf(b, wc.you));
const expired = await roomWhere(T1, (r) => r.seats.length === 3, "Pine's seat gone on disk");
check("seat expiry keeps Pine in the frozen roster", !expired.seats.some((s) => s.id === wc.you) && JSON.stringify(expired.roster) === JSON.stringify(r0));
check("a frozen participant's card is still readable after the seat expires", (await b.req({ type: "tableProfileCard", profileId: C.id })).card?.profileId === C.id);
check("and by the watcher", (await w.req({ type: "tableProfileCard", profileId: C.id })).card?.displayName === "Pine");

// --- Restart: expired credential, legacy and damaged rooms -----------------------------------------------------------------
await h.stop();
const saved = readRoom(T1);
check("the stopped host saved the roster", JSON.stringify(saved.roster) === JSON.stringify(r0) && saved.seats.length === 3);
// The finished game for the rematch below: B (Tide) won.
writeFileSync(path.join(ROOMS_DIR, `${T1}.json`), JSON.stringify({ ...saved, game: { ...saved.game, phase: "over", winner: r0.players[1].pid } }));
// A legacy room from before #764: no roster and no bindings.
const legacy = structuredClone(saved);
legacy.code = "LGCY";
delete legacy.roster;
legacy.seats = legacy.seats.map((s, i) => {
  const { profileId, ...rest } = s;
  return { ...rest, secret: `${"1".repeat(31)}${i}` };
});
writeFileSync(path.join(ROOMS_DIR, "LGCY.json"), JSON.stringify(legacy));
// A damaged room: a duplicate binding, a bound bot seat and a roster that no longer matches its game.
const damaged = structuredClone(saved);
damaged.code = "BADR";
damaged.seats = damaged.seats.map((s, i) => ({ ...s, secret: `${"2".repeat(31)}${i}` }));
damaged.seats[0].profileId = B.id;
damaged.seats[1].profileId = B.id;
damaged.seats.find((s) => s.bot).profileId = D.id;
damaged.roster = { ...damaged.roster, players: damaged.roster.players.map((p, i) => (i ? p : { ...p, pid: "zz" })) };
writeFileSync(path.join(ROOMS_DIR, "BADR.json"), JSON.stringify(damaged));
// A guest room whose seat binding is not a UUID.
const guestSaved = readRoom(gw.code);
guestSaved.seats[0].profileId = "not-a-uuid";
writeFileSync(path.join(ROOMS_DIR, `${gw.code}.json`), JSON.stringify(guestSaved));
// While the host is down Tide's remembered credential expires and Ember's first device is revoked (signed out).
const doc = store();
for (const dev of Object.values(doc.devices)) if (dev.profileId === B.id) dev.expiresAt = Date.now() - 1;
delete doc.devices[createHash("sha256").update(A.credential).digest("hex")];
writeFileSync(STORE, JSON.stringify(doc));
h = await startHost();

const probe = await client(h, tunnel(), false);
check("Tide's credential has expired", (await probe.req({ type: "profileResume", credential: B.credential })).code === "signedOut");
check("Ember's first device is signed out", (await probe.req({ type: "profileResume", credential: A.credential })).code === "signedOut");
const bExpired = await client(h, tunnel());
bExpired.send({ type: "hello", code: T2, name: "Tide", credential: B.credential });
check("the expired credential cannot attach anywhere", isErr(await bExpired.reply(), "signedOut"));
bExpired.send({ type: "hello", code: T2, name: "Ash", credential: A.credential });
check("nor can the signed-out one", isErr(await bExpired.reply(), "signedOut"));
const b2 = await client(h);
b2.send({ type: "hello", code: T1, secret: wb.secret });
check("Tide's seat secret recovers her seat after expiry and restart", (await b2.reply()).you === wb.you);
a2 = await client(h);
a2.send({ type: "hello", code: T1, secret: wa.secret });
check("Ash's seat secret recovers his seat after sign-out and restart", (await a2.reply()).you === wa.you);
// Every rejoin below lands inside the hold that started at boot.
const g1b = await client(h);
g1b.send({ type: "hello", code: gw.code, secret: gw.secret });
check("a guest seat with a non-UUID binding still rejoins", (await g1b.reply()).you === gw.you);
const lg = await client(h);
lg.send({ type: "hello", code: "LGCY", secret: legacy.seats[0].secret });
check("a legacy room still loads and rejoins", (await lg.reply()).type === "welcome");
const br = await client(h);
br.send({ type: "hello", code: "BADR", secret: damaged.seats[1].secret });
check("a damaged room still loads", (await br.reply()).type === "welcome");
await g1b.until(() => g1b.seats, 3000, "guest seats after restart");
check("the non-UUID binding is dropped", g1b.seats.seats.every((s) => !("profile" in s)));
await b2.until(() => seatOf(b2, wb.you)?.profile?.profileId === B.id && seatOf(b2, wa.you)?.profile?.profileId === A.id && !seatOf(b2, wa.you).away, 3000, "bindings after restart");
check("both bindings come back from the room file", true);
check("the restart keeps the frozen roster and game UUID", JSON.stringify((await roomWhere(T1, (r) => r.savedAt > saved.savedAt, "resaved")).roster) === JSON.stringify(r0));
const tokenAfter = await client(h, tunnel());
tokenAfter.send({ type: "hello", code: T1, name: "Ash", credential: fresh });
check("after a restart a credential alone still recovers nothing", (await tokenAfter.reply()).message === "Game already started.");

await lg.until(() => lg.seats, 3000, "legacy seats");
check("a legacy room has no bindings and no roster", lg.seats.seats.every((s) => !("profile" in s)) && (await roomWhere("LGCY", (r) => r.savedAt > legacy.savedAt, "legacy resaved")).roster === null);
await br.until(() => br.seats, 3000, "damaged seats");
check("duplicate and bot bindings are dropped; the first good one stays", br.seats.seats.map((s) => s.profile?.profileId ?? "-").join() === [B.id, "-", "-"].join(), br.seats.seats);
check("a roster that does not match its game is dropped, not trusted", (await roomWhere("BADR", (r) => r.savedAt > damaged.savedAt, "damaged resaved")).roster === null && /bad roster/.test(h.log) && /bad profile binding/.test(h.log));

// --- Rematch: new UUID, reordered seats, new roster --------------------------------------------------------------------------
a2.send({ type: "again" });
await a2.next((m) => m.type === "state" && m.game.phase !== "over", 5000, "rematch state");
const r1x = (await roomWhere(T1, (r) => r.roster?.gameId !== r0.gameId, "rematch roster")).roster;
const game1 = readRoom(T1).game;
check("the rematch freezes a new game UUID", UUID.test(r1x.gameId) && r1x.gameId !== r0.gameId);
check("the winner's seat goes first and the roster follows the new order",
  r1x.players.map((p) => `${p.seat}:${p.profileId}:${p.kind}`).join() === [`${wb.you}:${B.id}:human`, `${wa.you}:${A.id}:human`, `${botSeat.id}:null:bot`].join() &&
    r1x.players.every((p, i) => p.pid === game1.players[i].id), r1x);
check("the starting names carry into the rematch roster", r1x.players[1].name === "Ash" && r1x.players[0].name === "Tide");
check("seats keep their bindings across the rematch", seatOf(a2, wb.you)?.profile?.profileId === B.id && seatOf(a2, wa.you)?.profile?.profileId === A.id);
check("a player from the last game but not this one has no card here", cardErr(await a2.req({ type: "tableProfileCard", profileId: C.id }), "notFound"));
check("this game's players still do", (await a2.req({ type: "tableProfileCard", profileId: B.id })).card?.displayName === "Tide");

// --- Nothing private reached a table socket ----------------------------------------------------------------------------------
const frames = tableFrames.join("\n");
check("no credential reached any table or watcher socket", ![...CREDENTIALS, A.credential, B.credential, C.credential, D.credential].some((x) => frames.includes(x)));
check("no login reached any table or watcher socket", !LOGINS.some((l) => frames.includes(l)));
check("no private profile field reached any table or watcher socket", !/backupColor|"guard"|"pin"|"devices"|mediaKey|expiresAt|winSongId/.test(frames));
check("no game state frame carries a profile", tableFrames.filter((f) => f.startsWith('{"type":"state"')).every((f) => !/profile/i.test(f)));

await h.stop();
console.log(`profile-seat-prove: ${passed} checks passed`);
process.exit(0);
