// Profiles on seats (#764, docs/design/profiles.md "Protocol and seat recovery", "Exactly-once recording").
// An optional credential on the initial host/join binds a verified profile to the seat; guests are unchanged; a seat secret,
// never a credential, recovers a seat; each game and rematch freezes its roster; table cards stay inside the asker's table.
// Every check runs through host.mjs's own sockets, with temporary room and profile stores that survive a real restart.
// Run from the repo root: node --import ./server/register.mjs server/profile-seat-prove.mjs
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// --- Explicit seat aliases and Origin refusal (#1047, #965 review item 3) ---------------------------------------------------
const aliasHost = await client(h, tunnel());
aliasHost.send({ type: "create", name: "Alias host", credential: A.credential });
const aliasWelcome = await aliasHost.reply();
check("explicit create binds the authenticated host", aliasWelcome.type === "welcome" && aliasWelcome.host === true, aliasWelcome);
await aliasHost.until(() => seatOf(aliasHost, aliasWelcome.you)?.profile, 3000, "create alias profile");
const aliasJoin = await client(h, tunnel());
aliasJoin.send({ type: "join", code: aliasWelcome.code, name: "Alias join", credential: B.credential });
const aliasJoined = await aliasJoin.reply();
check("explicit join binds a non-host seat", aliasJoined.type === "welcome" && aliasJoined.host === false && aliasJoined.code === aliasWelcome.code, aliasJoined);
await aliasHost.until(() => seatOf(aliasHost, aliasJoined.you)?.profile, 3000, "join alias profile");
for (const [label, id, profile, name] of [["create", aliasWelcome.you, A, "Ember"], ["join", aliasJoined.you, B, "Tide"]]) {
  const projected = seatOf(aliasHost, id).profile;
  check(`${label} alias uses the public profile allowlist`, Object.keys(projected).sort().join() === "displayName,profileId" && projected.profileId === profile.id && projected.displayName === name, projected);
}
const aliasSaved = await roomWhere(aliasWelcome.code, (r) => r.seats.length === 2, "alias bindings saved");
check("both explicit aliases persist their authenticated profile IDs", aliasSaved.seats.map((s) => s.profileId).join() === [A.id, B.id].join(), aliasSaved.seats);

for (const type of ["create", "join"]) {
  const headers = { ...tunnel(), origin: "https://another-origin.example" };
  const refused = await client(h, headers);
  const target = type === "join" ? { code: aliasWelcome.code } : {};
  const beforeSeats = JSON.stringify(aliasHost.seats.seats);
  let first;
  for (const credential of [A.credential, "A".repeat(43)]) {
    refused.send({ type, ...target, name: "Origin refusal", credential });
    const reply = await refused.reply();
    check(`${type} refuses a mismatched HTTPS Origin before credential validity`, isErr(reply, "origin") && refused.welcome === null, reply);
    if (first) check(`${type} origin refusal exposes no credential-validity distinction`, JSON.stringify(reply) === JSON.stringify(first), reply);
    first = reply;
  }
  check(`${type} origin refusal leaves existing seats unchanged`, JSON.stringify(aliasHost.seats.seats) === beforeSeats);
  refused.send({ type, ...target, name: "Origin guest" });
  const guest = await refused.reply();
  check(`${type} refused socket can retry as a guest`, guest.type === "welcome" && guest.host === (type === "create"), guest);
  await refused.until(() => seatOf(refused, guest.you), 3000, `${type} guest seat`);
  check(`${type} guest retry attaches no profile`, !("profile" in seatOf(refused, guest.you)), seatOf(refused, guest.you));
  const guestSaved = await roomWhere(guest.code, (r) => r.seats.some((s) => s.id === guest.you), `${type} guest saved`);
  check(`${type} guest retry persists no profile binding`, !("profileId" in guestSaved.seats.find((s) => s.id === guest.you)));
}
// #944: one live table per host player. The alias table is done with, so Ember's profile is free to host the next one.
await aliasJoin.close();
await aliasHost.close();

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

// --- Card buckets: seat and watcher isolation, chat independence and recovery (#978) --------------------------------------
// Recover the seat on a new socket so its card bucket starts unused. Credentials remain unnecessary.
await a2.close();
const rateSeat = await client(h);
rateSeat.send({ type: "hello", code: T1, secret: wa.secret });
const rateWelcome = await rateSeat.reply();
check("the rate-test socket recovers the existing seat", rateWelcome.you === wa.you, rateWelcome);
const rateWatch = async () => {
  const c = await client(h);
  c.send({ type: "hello", code: T1, watch: true });
  check("the rate-test watcher watches without taking a seat", (await c.reply()).spectator === true);
  return c;
};
const publicCard = (m) => m.type === "tableProfileCard" && m.card?.profileId === B.id &&
  Object.keys(m.card).sort().join() === "catchphrase,displayName,profileId";
const exhaustCards = async (c, role) => {
  const at = Date.now();
  const replies = await Promise.all(Array.from({ length: 32 }, () => c.req({ type: "tableProfileCard", profileId: B.id })));
  const elapsed = Date.now() - at;
  const cards = replies.filter(publicCard);
  const limited = replies.filter((m) => cardErr(m, "slowDown"));
  check(`${role}: a card burst gets throttled`, limited.length > 0, { cards: cards.length, limited: limited.length, elapsed });
  // Account for real time spent handling the burst, rather than imposing a runner-speed deadline.
  check(`${role}: successful cards obey the ten-token burst and two-per-second refill`,
    cards.length >= 10 && cards.length <= 10 + Math.ceil(elapsed * 2 / 1000), { cards: cards.length, elapsed });
  check(`${role}: every reply is a public card or a cardless slowDown`,
    cards.length + limited.length === replies.length && limited.every((m) => !("card" in m)));
};
await exhaustCards(rateSeat, "seat");
let recoveredSeat;
for (const until = Date.now() + 5000; Date.now() < until; await wait(50)) {
  const reply = await rateSeat.req({ type: "tableProfileCard", profileId: B.id });
  if (publicCard(reply)) { recoveredSeat = reply; break; }
  if (!cardErr(reply, "slowDown")) fail("unexpected seat card response while waiting for refill", reply);
}
check("the exhausted seat card bucket refills and returns only a public card", publicCard(recoveredSeat ?? {}));
const isolatedWatch = await rateWatch();
check("an exhausted seat cannot throttle a fresh watcher", publicCard(await isolatedWatch.req({ type: "tableProfileCard", profileId: B.id })));
// Card requests use neither the chat bucket nor the gameplay action bucket.
rateSeat.send({ type: "chat", text: "card bucket isolation" });
const rateChat = await b2.next((m) => m.type === "chat" && m.text === "card bucket isolation", 3000, "chat after card burst");
check("a seated card burst does not block chat to another seat", rateChat.seat === wa.you);
rateSeat.send({ type: "setVictoryTarget", value: 7 });
const rateAction = await rateSeat.next((m) => m.type === "error", 3000, "action validation after card burst");
check("a card burst does not spend the gameplay action bucket", [
  "Only the host can choose the target.", "The target is fixed for this game.",
].includes(rateAction.message), rateAction);
// Watchers first pass the stricter generic ingress bucket (five tokens, one/second).
// Excess frames are silently dropped there, before the card bucket can reply slowDown.
// A websocket ping follows our frames on the same TCP stream. Its pong is a processing
// barrier, so missing application replies are counted without waiting for dropped IDs.
let flood = 0;
const watcherBurst = async (c, count) => {
  const prefix = `card-flood-${++flood}-`;
  const ids = new Set(Array.from({ length: count }, (_, i) => `${prefix}${i}`));
  const at = Date.now();
  for (const id of ids) c.send({ type: "tableProfileCard", id, profileId: B.id });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { c.ws.off("pong", pong); reject(new Error("watcher flood barrier timed out")); }, 5000);
    const pong = (data) => {
      if (String(data) !== prefix) return;
      clearTimeout(timer);
      c.ws.off("pong", pong);
      resolve();
    };
    c.ws.on("pong", pong);
    c.ws.ping(prefix);
  });
  const replies = c.inbox.filter((m) => ids.has(m.id));
  c.inbox = c.inbox.filter((m) => !ids.has(m.id));
  return { replies, elapsed: Date.now() - at };
};
const burstWatch = await rateWatch();
const watcherFlood = await watcherBurst(burstWatch, 32);
check("a watcher burst is bounded by its stricter ingress bucket", watcherFlood.replies.length >= 4 &&
  watcherFlood.replies.length < 32 && watcherFlood.replies.length <= 5 + Math.ceil(watcherFlood.elapsed / 1000),
  { replies: watcherFlood.replies.length, elapsed: watcherFlood.elapsed });
check("admitted watcher replies remain public cards; excess frames are dropped before card handling", watcherFlood.replies.every(publicCard));
check("an exhausted watcher cannot throttle another seated socket", publicCard(await b2.req({ type: "tableProfileCard", profileId: B.id })));
let recoveredCard;
for (const until = Date.now() + 5000; Date.now() < until; await wait(50)) {
  const { replies } = await watcherBurst(burstWatch, 1);
  if (replies.length) {
    if (!replies.every(publicCard)) fail("unexpected watcher card response after ingress refill", replies);
    recoveredCard = replies[0];
    break;
  }
}
check("the exhausted watcher ingress bucket refills and returns only a public card", publicCard(recoveredCard ?? {}));
check("card bursts and chat leave the canonical game sequence unchanged", readRoom(T1).game.seq === game1.seq);

// --- Logout keeps live seat ownership and frozen attribution (#1054) --------------------------------------------------------
const logoutLogin = "bound-logout";
LOGINS.push(logoutLogin);
const logoutAuth = await client(h, tunnel(), false);
const logoutSession = await logoutAuth.req({
  type: "profileCreate", login: logoutLogin, displayName: "Reed", pin: "4821", pinConfirm: "4821",
  color: PLAYER_COLORS[0], backupColor: PLAYER_COLORS[1], catchphrase: "Still seated",
});
check("bound-logout fixture creates a real authenticated profile", logoutSession.type === "profileSession" && !!logoutSession.credential, logoutSession.type);
const logoutProfile = logoutSession.profile.profileId;
const logoutSeat = await client(h, tunnel());
logoutSeat.send({ type: "hello", name: "Reed", credential: logoutSession.credential });
const logoutWelcome = await logoutSeat.reply();
check("the logout fixture hosts a profile-bound seat", logoutWelcome.type === "welcome" && logoutWelcome.host === true);
const logoutGuests = await Promise.all([client(h), client(h)]);
for (const [i, guest] of logoutGuests.entries()) {
  guest.send({ type: "hello", code: logoutWelcome.code, name: `Logout guest ${i + 1}` });
  check("a guest joins the bound-logout fixture", (await guest.reply()).type === "welcome");
}
for (const c of [logoutSeat, ...logoutGuests]) c.send({ type: "ready", value: true });
await logoutSeat.until(() => logoutSeat.seats?.seats.length === 3 && logoutSeat.seats.seats.every((s) => s.ready), 3000, "logout fixture ready");
logoutSeat.send({ type: "start" });
await logoutSeat.next((m) => m.type === "state", 5000, "logout fixture started");
const logoutBefore = await roomWhere(logoutWelcome.code, (r) => r.roster?.players.some((p) => p.profileId === logoutProfile), "logout roster saved");
check("the started game freezes the authenticated profile", logoutBefore.roster.players.find((p) => p.seat === logoutWelcome.you)?.profileId === logoutProfile);
check("logout acknowledges the bound device", (await logoutAuth.req({ type: "profileLogout", credential: logoutSession.credential })).type === "profileLoggedOut");
check("the logged-out bound credential cannot resume", cardErr(await logoutAuth.req({ type: "profileResume", credential: logoutSession.credential }), "signedOut"));
const revokedSeat = await client(h, tunnel());
revokedSeat.send({ type: "hello", name: "Revoked device", credential: logoutSession.credential });
check("the logged-out bound credential cannot open another seat", isErr(await revokedSeat.reply(), "signedOut") && revokedSeat.welcome === null);
check("logout keeps the original live public binding", seatOf(logoutSeat, logoutWelcome.you)?.profile?.profileId === logoutProfile && !seatOf(logoutSeat, logoutWelcome.you).away);
check("the live bound socket still reads its profile card", (await logoutSeat.req({ type: "tableProfileCard", profileId: logoutProfile })).card?.profileId === logoutProfile);
check("another participant still reads the bound profile card", (await logoutGuests[0].req({ type: "tableProfileCard", profileId: logoutProfile })).card?.catchphrase === "Still seated");
check("logout leaves frozen attribution unchanged", JSON.stringify(readRoom(logoutWelcome.code).roster) === JSON.stringify(logoutBefore.roster));
await logoutSeat.close();
await logoutGuests[0].until(() => seatOf(logoutGuests[0], logoutWelcome.you)?.away, 3000, "logged-out seat held");
const logoutRejoin = await client(h);
logoutRejoin.send({ type: "hello", code: logoutWelcome.code, secret: logoutWelcome.secret });
const logoutRecovered = await logoutRejoin.reply();
check("the seat secret alone recovers the logged-out profile seat", logoutRecovered.type === "welcome" && logoutRecovered.you === logoutWelcome.you && logoutRecovered.code === logoutWelcome.code);
await logoutRejoin.until(() => seatOf(logoutRejoin, logoutWelcome.you)?.profile?.profileId === logoutProfile && !seatOf(logoutRejoin, logoutWelcome.you).away, 3000, "logged-out binding recovered");
check("recovery preserves the profile without adding a seat", logoutRejoin.seats.seats.length === 3 && logoutRejoin.seats.seats.filter((s) => s.profile?.profileId === logoutProfile).length === 1);
const logoutAfter = await roomWhere(logoutWelcome.code, (r) => r.savedAt > logoutBefore.savedAt && r.seats.some((s) => s.id === logoutWelcome.you && s.profileId === logoutProfile), "logout recovery saved");
check("recovery durably preserves the same frozen game attribution", JSON.stringify(logoutAfter.roster) === JSON.stringify(logoutBefore.roster));

// --- Nothing private reached a table socket ----------------------------------------------------------------------------------
const frames = tableFrames.join("\n");
check("no credential reached any table or watcher socket", ![...CREDENTIALS, A.credential, B.credential, C.credential, D.credential].some((x) => frames.includes(x)));
check("no login reached any table or watcher socket", !LOGINS.some((l) => frames.includes(l)));
check("no private profile field reached any table or watcher socket", !/backupColor|"guard"|"pin"|"devices"|mediaKey|expiresAt|winSongId/.test(frames));
check("no game state frame carries a profile", tableFrames.filter((f) => f.startsWith('{"type":"state"')).every((f) => !/profile/i.test(f)));

await h.stop();

// --- Independent saved-roster guards (#992) ---------------------------------------------------------------------------------
// BADR above has a wrong pid. Corrupt one other field at a time so that pid failure cannot mask a removed loader guard.
// Use a separate restart after the existing checks; extra fixtures cannot consume their four-second recovery holds.
const rosterCodes = Array.from("ABCDEFGHJKLMNPQRSTUVWXYZ", (letter) => `RST${letter}`)
  .filter((code) => !existsSync(path.join(ROOMS_DIR, `${code}.json`)));
const rosterCases = [
  ["valid control", () => {}, true],
  ["version", (r) => { r.v = 2; }],
  ["game UUID", (r) => { r.gameId = "not-a-uuid"; }],
  ["start time", (r) => { r.startedAt = 1.5; }],
  ["policy type", (r) => { r.policy = "1"; }],
  ["eligibility type", (r) => { r.eligible = "true"; }],
  ["player array", (r) => { r.players = null; }],
  ["player count", (r) => { r.players.pop(); }],
  ["player order", (r) => { [r.players[0], r.players[1]] = [r.players[1], r.players[0]]; }],
  ["seat type", (r) => { r.players[0].seat = null; }],
  ["profile UUID", (r) => { r.players[0].profileId = "not-a-uuid"; }],
  ["name type", (r) => { r.players[0].name = 42; }],
  ["colour type", (r) => { r.players[0].color = 42; }],
  ["player kind", (r) => { r.players[0].kind = "unknown"; }],
  ["duplicate profile", (r) => { r.players[1].profileId = r.players[0].profileId; }],
].map(([label, corrupt, valid], i) => {
  const fixture = structuredClone(saved);
  fixture.code = rosterCodes[i];
  fixture.game.phase = "over";
  fixture.game.winner = fixture.game.players[0].id;
  fixture.seats.forEach((s) => { s.secret = randomBytes(16).toString("hex"); });
  corrupt(fixture.roster);
  writeFileSync(path.join(ROOMS_DIR, `${fixture.code}.json`), JSON.stringify(fixture));
  return { label, valid, fixture };
});
h = await startHost();
// Recover all fixture seats promptly, then inspect resaved bytes. The production hold and save timers stay unchanged.
await Promise.all(rosterCases.map(async ({ label, valid, fixture }) => {
  const c = await client(h);
  c.send({ type: "hello", code: fixture.code, secret: fixture.seats[0].secret });
  const welcome = await c.reply();
  check(`roster ${label}: seat secret still recovers the room`, welcome.type === "welcome" && welcome.code === fixture.code && welcome.you === fixture.seats[0].id, welcome);
  const restored = await roomWhere(fixture.code, (r) => r.savedAt > fixture.savedAt, `${label} resaved`);
  check(`roster ${label}: game identity survives metadata validation`, restored.game.seed === fixture.game.seed && restored.game.winner === fixture.game.winner);
  check(`roster ${label}: ${valid ? "valid frozen record preserved exactly" : "invalid record resaved as null"}`,
    valid ? JSON.stringify(restored.roster) === JSON.stringify(fixture.roster) : restored.roster === null, restored.roster);
}));
await h.stop();
console.log(`profile-seat-prove: ${passed} checks passed`);
process.exit(0);
