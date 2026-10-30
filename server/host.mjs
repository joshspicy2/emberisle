import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { chooseBotAction, chooseRecoveryAction, chooseTradeAsk, logBotAction, shouldAcceptTrade } from "../src/lib/game/ai.ts";
import { createGame } from "../src/lib/game/board.ts";
import { applyAction, bankShort, legalCities, legalRoads, legalSettle, playable, stealTargets, validBag } from "../src/lib/game/rules.ts";
import { COST, PLAYER_COLORS, RESOURCES } from "../src/lib/game/types.ts";
import { PROTO } from "../src/lib/net/proto.ts";
import { allow, cleanText, loadEmotes, remember, SOUNDBOARD } from "./chat.mjs";
import { cue } from "./cue.mjs";
import { PROFILE_TYPES, profileGate, profileHandler, seatCredential, seatProfile, tableCard, watchRefusal } from "./profile-protocol.mjs";
import { openProfiles, UUID } from "./profiles.mjs";
import { getOpenTables, maybeReleaseOpenSlot, registerOpenTable, unregisterOpenTable } from "./open-table.mjs";
import { extensionBudget, turnExtensions } from "./turn-extension.mjs";

// The running host's checkout, regardless of the shell's cwd. Archives and hosts without git report dev (#913).
const SERVER_SHA = (() => {
  try {
    if (!existsSync(new URL("../.git", import.meta.url))) return "dev";
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch { return "dev"; }
})();

function hear(name) {
  try {
    cue(name);
  } catch {
    /* a missing sound must not take down the table */
  }
}

const PORT = Number(process.env.PORT ?? 8787);
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rooms = new Map();
const avatars = new Map(); // avatarId -> { body }
const AVATAR_BYTES = 256 * 1024;
// An env limit, or its default when the variable is unset or not a number.
// A pace in ms from the environment: a finite number >= 0, else the default.
function envMs(name, fallback) {
  const raw = process.env[name];
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}
// Every picture belongs to one seat and a seat holds one picture, so a table carries at most 4 x 256 KB (#369).
// These two cap the whole host: a full store refuses (503) rather than evict a seated player's picture.
const AVATAR_MAX = envNum("AVATAR_MAX", 128);
const AVATAR_STORE_BYTES = envNum("AVATAR_STORE_BYTES", 16 * 1024 * 1024);
const ROOM_MAX = envNum("ROOM_MAX", 64);
// Opening a table is metered host-wide: a burst of OPEN_CAP, one more every OPEN_REFILL_MS (G10). A game night opens a
// handful of tables; a loop of fresh sockets, each opening one, hits this long before it fills ROOM_MAX. Per-socket
// counting cannot catch it (the flood is many sockets) and per-address cannot either (the tunnel gives every player one).
const OPEN_CAP = envNum("OPEN_CAP", 8);
const OPEN_REFILL_MS = Math.max(1, envNum("OPEN_REFILL_MS", 30 * 1000));
// In front of that, a client that reaches the host directly (not from loopback, where the tunnel and a local proxy sit and
// every player shares one address) gets its own small bucket by address, so one address cannot hold the shared one at zero (#581).
const OPEN_IP_CAP = envNum("OPEN_IP_CAP", 3);
const OPEN_IP_MS = Math.max(1, envNum("OPEN_IP_MS", 60 * 1000));
const openIps = new Map();
// One key per client: ::ffff:a.b.c.d is a.b.c.d, and an IPv6 address is its /64 (first four hextets).
function normIp(raw) {
  const a = String(raw).toLowerCase().replace(/^::ffff:/, "");
  if (!a.includes(":")) return a;
  const [head, tail = ""] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = a.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":");
}
// Direct clients are keyed on their socket address. Loopback is the tunnel (or local dev): there the address says nothing, so a
// cf-connecting-ip header is trusted (only a process on this machine can set it) and loopback without one is not metered.
function ipKey(remote, header) {
  const r = String(remote ?? "127.0.0.1").toLowerCase().replace(/^::ffff:/, "");
  if (r !== "127.0.0.1" && r !== "::1") return normIp(r);
  return typeof header === "string" && header ? normIp(header.slice(0, 64)) : null;
}
function ipBucket(key, now) {
  if (openIps.size > 1024) for (const [k, b] of openIps) if (now - b.at > OPEN_IP_CAP * OPEN_IP_MS) openIps.delete(k);
  let b = openIps.get(key);
  if (!b) openIps.set(key, (b = { tokens: OPEN_IP_CAP, at: now }));
  return b;
}
const opens = { tokens: OPEN_CAP, at: Date.now() };
// Per-address throttle for GET /tables (same allow() shape as peek/list: burst then refill).
// Slightly above the WS peek burst so two title tabs can poll without 429 noise in the console.
const httpListBuckets = new Map();
const TABLES_CAP = 10;
const TABLES_RATE = 2;
// Watchers per room (docs/design/spectator.md). A watcher has no seat and is never saved; 0 turns watching off.
const SPECTATOR_MAX = envNum("SPECTATOR_MAX", 8);
// A watcher coming or going is logged to the table at most this often per room, so a watch-and-close loop cannot
// flood the log; the `watching` count on `seats` is always exact.
const WATCH_LOG_MS = 5000;
// A seat's non-chat messages (ready, start, intents, trades): a burst of 20, refilled 4 a second. A person or a bot
// client stays far under this; a flood does not. Chat keeps its own 5-per-5s bucket. The proofs raise it through env.
const ACT_CAP = Number(process.env.ACT_CAP ?? 20);
const ACT_RATE = Number(process.env.ACT_RATE ?? 4);
// A dropped player keeps the seat: the bot takes over after the grace, the seat is let go after the hold
// (docs/research/rejoin.md). The proofs shorten both through env.
const GRACE_MS = Number(process.env.GRACE_MS ?? 90 * 1000);
const HOLD_MS = Number(process.env.HOLD_MS ?? 10 * 60 * 1000);
const LOBBY_HOLD_MS = Number(process.env.LOBBY_HOLD_MS ?? 90 * 1000);
// Both ride on a seat's welcome so the client's redials stop before the hold runs out, never after it (G7, #528).
const HOLD_INFO = { holdMs: HOLD_MS, lobbyHoldMs: LOBBY_HOLD_MS };
// A connected player who stops taking their turn: after this long the host's bot makes that one move for the
// seat and the seat stays human (#344, Jarrod's call on #324). A dropped seat follows GRACE_MS instead, never this.
const TURN_MS = Number(process.env.TURN_MS ?? 120 * 1000);
const TURN_TOTAL_MS = Number(process.env.TURN_TOTAL_MS ?? 6 * TURN_MS);
const TURN_EXTENSION_MS = envMs("TURN_EXTENSION_MS", 60_000);
// A bot seat answers a table ask after BOT_ANSWER_MS to twice that, so its Yes or No lands like a person's (#363).
const BOT_ANSWER_MS = Number(process.env.BOT_ANSWER_MS ?? 1000);
// People first (#850): a bot's Yes waits this long, or until every person asked has said No. A bot's No does not wait.
const PEOPLE_FIRST_MS = Number(process.env.PEOPLE_FIRST_MS ?? 8000);
// Every socket is pinged this often; one that has not answered the last ping is cut, so a phone that
// locked or changed Wi-Fi frees its seat for the rejoin instead of holding it half-open (#202, #113).
const PING_MS = Number(process.env.PING_MS ?? 30 * 1000);
// Every room is saved to ROOMS/<code>.json after each change and reloaded on boot, so a host PC
// that sleeps or a Node crash does not end the game. Rooms saved more than a day ago are dropped.
const ROOMS = path.resolve(process.env.ROOMS_DIR ?? fileURLToPath(new URL("./rooms/", import.meta.url)));
// A change marks its room dirty and one write goes out SAVE_MS after the first change of a burst, so 50 quick
// actions are a handful of writes, not 50 (G5). SIGTERM, SIGINT and a normal exit flush every dirty room at once;
// kill -9 or a power cut can lose at most the last SAVE_MS of changes. The proofs shorten it through env.
const SAVE_MS = Number(process.env.SAVE_MS ?? 250);
const ROOM_TTL = 24 * 60 * 60 * 1000;
// Stamped on every saved room. Bump it whenever GameState, the seat record or the chat record changes
// shape: load() drops files with any other stamp (including none), so a bump ends the saved rooms on the next restart.
const ROOM_SHAPE = 2;
// A seat's soundboard taps are at least this far apart (the host's word; the client greys the buttons for the same time).
const SOUND_MS = envMs("SOUND_MS", 3000);
// A seat's accepted renames are at least this far apart, on top of the ordinary action limit.
const RENAME_MS = envMs("RENAME_MS", 2000);
// Profiles (#762) live beside the rooms, in a private store only this host writes. PROFILES_DEV=1 lets a loopback page sign in
// over plain ws:// for local development; every other plaintext link stays guest-only (docs/design/profiles.md).
const PROFILES = path.resolve(process.env.PROFILES_DIR ?? fileURLToPath(new URL("./profiles/", import.meta.url)));
const PROFILES_DEV = process.env.PROFILES_DEV === "1";
// The built client (npm run build). DIST lets a proof point the host at a small temp folder.
const DIST = path.resolve(process.env.DIST ?? fileURLToPath(new URL("../dist/", import.meta.url)));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
};
const EMOTES_DIR = fileURLToPath(new URL("../src/assets/emotes/", import.meta.url));
const EMOTES = loadEmotes(EMOTES_DIR);

function code() {
  let out = "";
  for (let i = 0; i < 4; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return rooms.has(out) ? code() : out;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const raw = JSON.stringify(msg);
  for (const seat of room.seats) if (seat.ws && seat.ws.readyState === seat.ws.OPEN) seat.ws.send(raw);
  for (const ws of room.watchers) if (ws.readyState === ws.OPEN) ws.send(raw);
}

function say(room, text) {
  broadcast(room, { type: "log", text });
}

// The engine keeps only the last 200 log lines (rules.ts `log`), so once the log is full its length never grows and
// `after.slice(before.length)` is empty (#319: the winner line never reached a seat). The new lines are what follows
// the longest tail of the old log that the new one still starts with.
function newLog(before, after) {
  for (let k = Math.min(before.length, after.length); k > 0; k--) {
    if (before.slice(-k).every((line, i) => line === after[i])) return after.slice(k);
  }
  return after;
}

function seatsOf(room) {
  return room.seats.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    avatarId: s.avatarId,
    ready: s.ready,
    host: s.id === room.host,
    away: !s.bot && !s.ws,
    bot: Boolean(s.bot),
    url: s.avatarId ? `/avatars/${s.avatarId}.jpg` : null,
    // A guest seat carries no profile field at all (#764).
    ...(s.profileId ? { profile: seatProfile(profiles, s.profileId) } : {}),
  }));
}

// The frozen roster of one game (#764, profiles.md "Exactly-once recording"): a fresh game UUID, the start time and, per
// starting player, its seat, bound profile, starting name and colour and human/bot class, in game player order. Set at start
// and at each rematch, and saved with the room; durable result recording reads this, never the live seats. Nothing is counted.
const ROSTER_V = 1;
const COUNT_POLICY = 1;
function freezeRoster(room, order) {
  const players = order.map((s) => ({ pid: s.pid, seat: s.id, profileId: (!s.bot && s.profileId) || null, name: s.name, color: s.color, kind: s.bot ? "bot" : "human" }));
  // Guests count as humans toward eligibility; a game needs two humans at its start to count.
  room.roster = { v: ROSTER_V, gameId: randomUUID(), startedAt: Date.now(), policy: COUNT_POLICY, eligible: players.filter((p) => p.kind === "human").length >= 2, players };
}

// A saved roster that does not match its game is dropped, leaving that game untracked; a legacy room has none (#764).
function loadRoster(r, game) {
  if (!game || r === undefined || r === null) return null;
  const row = (p, i) => p && typeof p === "object" && p.pid === game.players[i].id && typeof p.seat === "string" && (p.profileId === null || (typeof p.profileId === "string" && UUID.test(p.profileId))) && typeof p.name === "string" && typeof p.color === "string" && (p.kind === "human" || p.kind === "bot");
  const ok = typeof r === "object" && r.v === ROSTER_V && typeof r.gameId === "string" && UUID.test(r.gameId) && Number.isSafeInteger(r.startedAt) && Number.isSafeInteger(r.policy) && typeof r.eligible === "boolean" && Array.isArray(r.players) && r.players.length === game.players.length && r.players.every(row);
  const ids = ok ? r.players.map((p) => p.profileId).filter(Boolean) : [];
  if (ok && new Set(ids).size === ids.length) return r;
  console.error("bad roster in room file; this game is not tracked");
  return null;
}

// The profile ids a table socket can see: the bound seats of its current room and that game's frozen roster.
function visibleProfiles(room) {
  return new Set([...room.seats.map((s) => s.profileId), ...(room.roster?.players ?? []).map((p) => p.profileId)].filter(Boolean));
}

// #1156: how the number tokens are dealt. A new table starts on the official spiral; a room saved before the setting
// existed loads as Random, the way its board was dealt.
function numberTokensOf(room) {
  return room.numberTokens === "random" ? "random" : "official";
}

function seatsMsg(room) {
  return { type: "seats", code: room.code, seats: seatsOf(room), watching: room.watchers.size, victoryTarget: room.victoryTarget ?? room.game?.victoryTarget ?? 10, wayfarerMode: room.wayfarerMode ?? room.game?.wayfarerMode ?? "on", numberTokens: numberTokensOf(room) };
}

function publish(room) {
  if (room.game) extensions(room).sync();
  broadcast(room, seatsMsg(room));
  save(room);
}

// A watcher came or went: the count goes out, nothing is saved (a watcher is never on disk), and the log line is coalesced.
function watchersChanged(room, text) {
  const now = Date.now();
  if (!(now - (room.watchSaid ?? 0) < WATCH_LOG_MS)) {
    room.watchSaid = now;
    say(room, text);
  }
  broadcast(room, seatsMsg(room));
}

// Sockets, timers and the open trade offer stay in memory; everything else goes to disk.
function save(room) {
  if (!rooms.has(room.code)) return;
  room.dirty = true;
  if (!room.saveTimer && !room.saving) room.saveTimer = setTimeout(() => flush(room), SAVE_MS);
}

function snapshot(room) {
  return JSON.stringify({
    code: room.code,
    visibility: room.visibility ?? "private",
    host: room.host,
    next: room.next,
    botDeclined: room.botDeclined ?? {},
    recoveryPids: [...new Set(room.recoveryPids ?? [])].slice(-4),
    chat: room.chat,
    chatSeq: room.chatSeq,
    game: room.game,
    victoryTarget: room.victoryTarget ?? room.game?.victoryTarget ?? 10,
    wayfarerMode: room.wayfarerMode ?? room.game?.wayfarerMode ?? "on",
    numberTokens: numberTokensOf(room),
    seats: room.seats.map(({ id, name, color, ready, pid, secret, bot, turnDeadline, turnStartedAt, extension, profileId }) => ({ id, name, color, ready, pid, secret, ...(bot ? { bot: true } : {}), turnDeadline: turnDeadline ?? null, turnStartedAt: turnStartedAt ?? null, extension, ...(profileId ? { profileId } : {}) })),
    // Optional versioned metadata (#764): no ROOM_SHAPE bump, so a legacy room loads with no roster and is not tracked.
    roster: room.roster ?? null,
    shape: ROOM_SHAPE,
    savedAt: Date.now(),
  });
}

// One write at a time per room: changes that land mid-write set `dirty` again and the next write follows.
// Write then rename, so a crash mid-write never leaves half a room behind.
async function flush(room) {
  room.saveTimer = null;
  if (!room.dirty || !rooms.has(room.code)) return;
  room.dirty = false;
  room.saving = true;
  const file = path.join(ROOMS, `${room.code}.json`);
  try {
    const json = snapshot(room);
    await mkdir(ROOMS, { recursive: true });
    await writeFile(`${file}.tmp`, json);
    await rename(`${file}.tmp`, file);
  } catch (err) {
    console.error("save failed:", err);
  }
  room.saving = false;
  // The table closed while the write was in flight: the rename may have landed after unsave(), so remove it again.
  if (room.dropped) unsave(room);
  else if (room.dirty) room.saveTimer = setTimeout(() => flush(room), SAVE_MS);
}

// Synchronous, for the end of the process: every room with a change not yet on disk (or a write in flight) is written now.
function flushAll() {
  for (const room of rooms.values()) {
    if (!room.dirty && !room.saving) continue;
    clearTimeout(room.saveTimer);
    room.saveTimer = null;
    room.dirty = false;
    try {
      const file = path.join(ROOMS, `${room.code}.json`);
      mkdirSync(ROOMS, { recursive: true });
      writeFileSync(`${file}.tmp`, snapshot(room));
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      console.error("save failed:", err);
    }
  }
}
process.on("exit", flushAll);
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.on(sig, () => process.exit(code));

function unsave(room) {
  room.dropped = true;
  clearTimeout(room.saveTimer);
  room.saveTimer = null;
  rmSync(path.join(ROOMS, `${room.code}.json`), { force: true });
  rmSync(path.join(ROOMS, `${room.code}.json.tmp`), { force: true });
}

// Rebuild every saved room. Nobody is connected yet, so each seat is held as if it had just dropped.
function load() {
  let names;
  try {
    names = readdirSync(ROOMS).filter((n) => n.endsWith(".json"));
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(ROOMS, name);
    let saved;
    try {
      saved = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      console.error("unreadable room file:", name);
      continue;
    }
    if (typeof saved?.code !== "string" || !Array.isArray(saved.seats) || !(Date.now() - saved.savedAt < ROOM_TTL) || saved.seats.length === 0) {
      rmSync(file, { force: true });
      continue;
    }
    if (saved.shape !== ROOM_SHAPE) {
      console.error(`stale room file: ${name} (shape ${saved.shape}, want ${ROOM_SHAPE})`);
      rmSync(file, { force: true });
      continue;
    }
    const g = saved.game;
    if (g !== null && (typeof g !== "object" || !["players", "vertices", "edges", "seq", "phase"].every((k) => k in g))) {
      console.error(`bad game in room file: ${name}`);
      rmSync(file, { force: true });
      continue;
    }
    // A file that parses but does not rebuild (a null seat, say) is skipped like one that does not parse.
    let room;
    try {
      // A lobby bot seat is a full practice bot, not a held human seat, so it is never a recovery pid.
      const seatPids = new Set(saved.seats.filter((seat) => !seat?.bot).map((seat) => seat?.pid).filter((pid) => typeof pid === "string"));
      const legacyRecovery = (saved.game?.players ?? []).filter((p) => p.kind === "bot" && seatPids.has(p.id)).map((p) => p.id);
      room = {
        ...saved,
        offer: null,
        offerTimer: null,
        botDeclined: saved.botDeclined ?? {},
        visibility: saved.visibility === "open" ? "open" : "private",
        wayfarerMode: saved.wayfarerMode === "off" ? "off" : "on",
        // #1156: a file from before the setting has no value; its board was dealt at random, so it stays Random.
        numberTokens: saved.numberTokens === "official" ? "official" : "random",
        // Legacy hosted snapshots had no practice-bot seats, so a bot linked to a held seat means takeover.
        recoveryPids: [...new Set([...(Array.isArray(saved.recoveryPids) ? saved.recoveryPids : []), ...legacyRecovery])].slice(-4),
        roster: loadRoster(saved.roster, saved.game),
        seats: [],
        watchers: new Set(),
      };
      delete room.savedAt;
      for (const s of saved.seats) {
        if (typeof s?.id !== "string" || typeof s.secret !== "string") throw new Error(`bad seat ${JSON.stringify(s)}`);
        // Avatars live in memory only, so a restored seat has none.
        // G9: the saved window rides in `resume` until the seat is back and waited on; older files have none.
        const at = (n) => (Number.isFinite(n) ? n : null);
        room.seats.push({ ...s, turnDeadline: null, turnStartedAt: at(s.turnStartedAt), resume: at(s.turnDeadline), avatarId: null, ws: null, bucket: { tokens: 5, at: Date.now() }, act: { tokens: ACT_CAP, at: Date.now() } });
      }
      // A profile binding must be a UUID on a human seat, once per room; anything else leaves that seat a guest (#764).
      const bound = new Set();
      for (const seat of room.seats) {
        if (seat.profileId === undefined) continue;
        if (typeof seat.profileId !== "string" || !UUID.test(seat.profileId) || seat.bot || bound.has(seat.profileId)) {
          console.error(`bad profile binding in room file: ${name}`);
          delete seat.profileId;
        } else bound.add(seat.profileId);
      }
    } catch (err) {
      console.error("unreadable room file:", name, err.message);
      continue;
    }
    // Every seat comes back held, and a held seat is not ready (#280).
    if (!room.game) for (const seat of room.seats) seat.ready = Boolean(seat.bot);
    for (const seat of room.seats) if (!seat.bot) hold(room, seat);
    if (!room.seats.some((s) => !s.bot)) {
      rmSync(file, { force: true });
      continue;
    }
    rooms.set(room.code, room);
  }
  if (rooms.size) console.log(`restored ${rooms.size} room(s): ${[...rooms.keys()].join(" ")}`);
}

function affords(player, cost) {
  return Object.entries(cost).every(([r, n]) => player.resources[r] >= n);
}

// What `you` may do right now. Empty lists mean hide the button (build bible 4.2).
export function legalFor(game, you) {
  const me = game.players.find((p) => p.id === you);
  const out = { outpost: [], path: [], stronghold: [], wayfarer: [], steal: {}, discard: 0, actions: [] };
  if (!me || game.phase === "over") return out;
  if (game.phase === "discard") {
    out.discard = game.discardNeeded[you] ?? 0;
    if (out.discard > 0) out.actions.push("discard");
    return out;
  }
  if (game.current !== you) return out;
  if (game.phase === "setupSettle") out.outpost = legalSettle(game, you, true);
  if (game.phase === "setupRoad") out.path = legalRoads(game, you, true);
  if (game.phase === "roll" || game.phase === "rollOff") out.actions.push("roll");
  if (game.phase === "robber") out.wayfarer = game.hexes.filter((h) => h.id !== game.robberHex).map((h) => h.id);
  if (game.phase === "main") {
    if (me.pathsLeft > 0 && affords(me, COST.path)) out.path = legalRoads(game, you, false);
    if (me.outpostsLeft > 0 && affords(me, COST.outpost)) out.outpost = legalSettle(game, you, false);
    if (me.strongholdsLeft > 0 && affords(me, COST.stronghold)) out.stronghold = legalCities(game, you);
    if (affords(me, COST.card) && game.deck.length > 0) out.actions.push("buy");
    out.actions.push("trade", "pass");
  }
  if ((game.phase === "roll" || game.phase === "main") && !game.playedCard) {
    for (const card of ["knight", "road", "plenty", "monopoly"]) {
      if (playable(me, card) > 0 && (card === "knight" || game.phase === "main")) out.actions.push(`play:${card}`);
    }
  }
  // Moving the wayfarer and playing a knight both need to know whom each hex can rob.
  if (game.phase === "robber" || out.actions.includes("play:knight")) {
    for (const h of game.hexes) {
      if (h.id === game.robberHex) continue;
      const targets = stealTargets(game, h.id, you);
      if (targets.length) out.steal[h.id] = targets;
    }
  }
  return out;
}

// Hidden fortunes and the deck order stay on the host until the game ends.
export function viewFor(game, you) {
  if (game.phase === "over") return { ...game, deckLeft: game.deck.length, players: game.players.map(revealLoss) };
  return closedView(game, you);
}

// Goods lost to successful steals (#550) stay on the host until the win: no view carries them, not even the seat's own.
// At the win every seat and watcher gets the count with the final state, a 0 for a seat that lost nothing.
function withoutLoss({ goodsLost, ...rest }) {
  return rest;
}

function revealLoss(p) {
  return { ...p, goodsLost: p.goodsLost ?? 0 };
}

// A watcher gets the opponent view, and at the win the same reveal as the seats minus the seed and rng (#347).
function watchView(game) {
  if (game.phase !== "over") return closedView(game, null);
  const { seed, rng, ...open } = game;
  return { ...open, deckLeft: game.deck.length, players: game.players.map(revealLoss) };
}

function closedView(game, you) {
  // The seed rebuilds the whole fortune deck, and rng predicts which card a steal takes (#111).
  // Other players' hands go out as a count only, like cards held face down (#186).
  const { seed, rng, winReason, ...open } = game;
  return {
    ...open,
    deck: [],
    deckLeft: game.deck.length,
    players: game.players.map((p) =>
      p.id === you
        ? withoutLoss(p)
        : {
            ...withoutHand(withoutLoss(p)),
            goods: RESOURCES.reduce((n, r) => n + p.resources[r], 0),
            hidden: { knight: 0, road: 0, plenty: 0, monopoly: 0, vp: 0 },
            boughtThisTurn: { knight: 0, road: 0, plenty: 0, monopoly: 0, vp: 0 },
            fortunes: Object.values(p.hidden).reduce((a, b) => a + b, 0),
          },
    ),
  };
}

function withoutHand({ resources, ...rest }) {
  return rest;
}

// A player who leaves mid-game is played by the practice bot so the table never hangs.
function runBots(room) {
  for (let i = 0; i < 500 && room.game.phase !== "over"; i++) {
    const g = room.game;
    const waiting =
      g.phase === "discard"
        ? g.players.find((p) => p.kind === "bot" && (g.discardNeeded[p.id] ?? 0) > 0)
        : g.players.find((p) => p.kind === "bot" && p.id === g.current);
    if (!waiting) return;
    // A bot's own ask is open: its turn waits for the answers, and the offer's close plays on (botsOn).
    if (room.offer?.from === waiting.id) return;
    // Once per bot turn, before its other moves, the bot may ask the table (#363).
    const recovery = (room.recoveryPids ?? []).includes(waiting.id);
    if (!recovery && g.phase === "main" && !room.offer && room.botAsked !== `${g.turn}:${waiting.id}`) {
      room.botAsked = `${g.turn}:${waiting.id}`;
      const ask = chooseTradeAsk(g, waiting.id, room.botDeclined?.[waiting.id]);
      if (ask) return openOffer(room, waiting.id, ask.give, ask.want);
    }
    const action = recovery ? chooseRecoveryAction(g, waiting.id) : chooseBotAction(g, waiting.id);
    if (recovery && !action) return;
    const next = action && applyAction(g, waiting.id, action);
    if (!next || next.error) {
      if (recovery) return;
      const pass = applyAction(g, waiting.id, { type: "endTurn" });
      if (pass.error) return;
      room.game = logBotAction(g, pass.state, { type: "endTurn" }, waiting.id, room.seats.find((s) => s.pid === waiting.id)?.name ?? waiting.name.replace(/ \(bot\)$/i, ""));
    } else {
      const seatName = room.seats.find((s) => s.pid === waiting.id)?.name ?? waiting.name.replace(/ \(bot\)$/i, "");
      room.game = logBotAction(g, next.state, action, waiting.id, seatName);
    }
  }
}

// The game waits on `pid` when legalFor gives it anything to do: the current seat in setup, roll, main or robber,
// and every seat that owes a discard. Any phase that waits on one seat (a roll-off, say) is covered the same way.
function waitedOn(game, pid) {
  const l = legalFor(game, pid);
  return l.actions.length > 0 || l.outpost.length > 0 || l.path.length > 0 || l.stronghold.length > 0 || l.wayfarer.length > 0;
}

function disarmTurn(seat) {
  clearTimeout(seat.turnTimer);
  seat.turnTimer = null;
  seat.turnDeadline = null;
}

// Every connected human seat the game waits on gets TURN_MS from the moment it became waited on. An accepted action
// from the seat disarms it first (play), so its window restarts, but never past TURN_TOTAL_MS from `turnStartedAt`
// (G3: acting forever can't hold the table); a dropped seat is disarmed (hold) and left to GRACE_MS. The budget
// outlives a drop and rejoin within the turn (only a turn that moves on clears it), and a window saved before a host
// restart (`resume`, G9) is kept: the remainder is armed, and one that ran out while the host was down, or has under
// RESUME_MIN_MS left, is spent at once so a timeout never lands mid-rejoin.
const RESUME_MIN_MS = Math.min(5000, TURN_MS / 10);
function armTurns(room) {
  for (const seat of room.seats) {
    const bonus = extensionBudget(seat, room.game, TURN_EXTENSION_MS).extra;
    const human = room.game?.players.find((p) => p.id === seat.pid)?.kind === "human";
    const waited = human && waitedOn(room.game, seat.pid);
    if (!waited) {
      seat.turnStartedAt = null;
      seat.resume = null;
    }
    if (!seat.ws || !waited) disarmTurn(seat);
    else if (!seat.turnTimer) {
      const now = Date.now();
      const resume = seat.resume ?? null;
      seat.resume = null;
      seat.turnStartedAt ??= now;
      // A window that ran out while the host was down is spent on a 0 ms timer, not inline, so the other seats in this
      // loop are still armed and turnOut's own move does not re-enter armTurns mid-loop.
      const spent = resume !== null && resume - now < RESUME_MIN_MS;
      const ms = spent ? 0 : resume !== null ? resume - now : Math.max(0, Math.min(TURN_MS, seat.turnStartedAt + TURN_TOTAL_MS + bonus - now));
      seat.turnDeadline = now + ms;
      seat.turnTimer = setTimeout(() => turnOut(room, seat), ms);
    }
  }
}

// A bot action as the client would have sent it, so the timer's move runs through play() like any other.
function toIntent(action) {
  switch (action?.type) {
    case "roll":
      return { type: "roll" };
    case "setupSettle":
      return { type: "place", kind: "outpost", id: action.vertexId };
    case "setupRoad":
      return { type: "place", kind: "path", id: action.edgeId };
    case "moveRobber":
      return { type: "rob", hexId: action.hexId, stealFrom: action.stealFrom };
    case "discard":
      return { type: "discard", cards: action.resources };
    default:
      return null;
  }
}

// The window ran out: the host's bot makes one move for the seat (a roll, a halved discard, a wayfarer move, a setup
// placement; in main it passes and spends nothing). The seat stays human, and its next move is its own.
function turnOut(room, seat) {
  seat.turnTimer = null;
  seat.turnDeadline = null;
  if (!seat.ws || !waitedOn(room.game, seat.pid)) return;
  const intent = room.game.phase === "main" ? { type: "pass" } : toIntent(chooseBotAction(room.game, seat.pid));
  // A phase the bot has no move for yet: wait another window rather than send a move play() would refuse.
  if (!intent) return armTurns(room);
  say(room, `${seat.name} took too long; the table moved on.`);
  play(seat.ws, room, intent, true);
}

// Timer votes share the existing host clock and never dispatch a gameplay action.
function extensions(room) {
  return room.extensions ??= turnExtensions(room, {
    extensionMs: TURN_EXTENSION_MS,
    voteMs: envMs("TURN_VOTE_MS", 15_000),
    changed: () => {
      broadcast(room, { type: "turnExtension", ...extensions(room).state() });
      save(room);
      queueMicrotask(() => { if (rooms.has(room.code) && room.game) pushState(room); });
    },
    extend: (seat, ms) => {
      clearTimeout(seat.turnTimer);
      seat.turnDeadline += ms;
      seat.turnTimer = setTimeout(() => turnOut(room, seat), Math.max(0, seat.turnDeadline - Date.now()));
    },
  });
}

// The soonest armed window at the table, or null.
function deadlineOf(room) {
  return room.seats.reduce((d, s) => (s.turnDeadline && (!d || s.turnDeadline < d) ? s.turnDeadline : d), null);
}

function pushState(room) {
  // Recovery during rejoin or takeover can finish a game too. Release before publishing it.
  maybeReleaseOpenSlot(room);
  armTurns(room);
  extensions(room).sync();
  // The soonest armed window, and whose it is, so every HUD can count it down (#345). `serverNow` lets a client
  // whose clock is off still land on the host's moment.
  const soonest = room.seats.reduce((d, s) => (s.turnDeadline && (!d || s.turnDeadline < d.turnDeadline) ? s : d), null);
  const turnDeadline = soonest?.turnDeadline ?? null;
  save(room);
  for (const seat of room.seats) {
    if (!seat.ws) continue;
    send(seat.ws, {
      type: "state",
      you: seat.pid,
      game: viewFor(room.game, seat.pid),
      legal: legalFor(room.game, seat.pid),
      actionStamp: actionStamp(room, seat.ws),
      turnExtension: extensions(room).state(),
      turnDeadline,
      turnPlayer: soonest?.pid ?? null,
      serverNow: Date.now(),
    });
  }
  if (!room.watchers.size) return;
  const raw = JSON.stringify({ type: "state", you: null, game: watchView(room.game), legal: legalFor(room.game, null), turnExtension: extensions(room).state(), turnDeadline, turnPlayer: soonest?.pid ?? null, serverNow: Date.now() });
  for (const ws of room.watchers) if (ws.readyState === ws.OPEN) ws.send(raw);
}

// A connection-bound baseline for gameplay intents. Rejoin/restart gets a new connection id even when
// the game has not advanced; a rematch rotates it too, since turn/seq start over on the new island.
function actionStamp(room, ws) {
  ws.actionConnection ??= randomBytes(16).toString("hex");
  return { turn: room.game.turn, baseSeq: room.game.seq, connection: ws.actionConnection };
}

function freshAction(ws, room, msg) {
  const stamp = actionStamp(room, ws);
  const seen = (ws.seat.actionCids ??= []);
  // Discards and offer replies from other seats can race with progress in the same turn.
  // Their rules still validate the outstanding discard/offer; connection and cid prevent replays.
  const parallel = ws.seat.pid !== room.game.current && ["discard", "tradeAnswer", "turnExtensionAsk", "turnExtensionAnswer"].includes(msg.type);
  if (
    ws.seat.ws !== ws ||
    typeof msg.cid !== "string" || msg.cid.length === 0 || msg.cid.length > 64 ||
    !Number.isSafeInteger(msg.turn) || msg.turn !== stamp.turn ||
    !Number.isSafeInteger(msg.baseSeq) || msg.baseSeq < 0 || msg.baseSeq > stamp.baseSeq ||
    (!parallel && msg.baseSeq !== stamp.baseSeq) ||
    msg.connection !== stamp.connection || seen.includes(msg.cid)
  ) {
    send(ws, { type: "error", message: "The table has updated. Please try again." });
    // Resync this seat only. Refusing an intent must not rearm any clock, run bots, or write a room.
    const soonest = room.seats.reduce((d, s) => (s.turnDeadline && (!d || s.turnDeadline < d.turnDeadline) ? s : d), null);
    send(ws, {
      type: "state", you: ws.seat.pid, game: viewFor(room.game, ws.seat.pid),
      legal: legalFor(room.game, ws.seat.pid), actionStamp: stamp,
      turnExtension: extensions(room).state(), turnDeadline: soonest?.turnDeadline ?? null, turnPlayer: soonest?.pid ?? null, serverNow: Date.now(),
    });
    return false;
  }
  // Consume once before dispatch, including a rules refusal: retrying is a new intent with a new cid.
  // The bounded seat ledger also covers asks/declines, which do not advance game.seq.
  seen.push(msg.cid);
  if (seen.length > 32) seen.shift();
  return true;
}

function gains(before, after) {
  const out = [];
  for (const p of after.players) {
    const was = before.players.find((x) => x.id === p.id);
    for (const r of RESOURCES) {
      const d = p.resources[r] - was.resources[r];
      if (d > 0) out.push({ player: p.id, name: p.name, resource: r, amount: d });
    }
  }
  return out;
}

// The seat whose welcome carried this secret, in whichever room.
function seatOf(secret) {
  if (typeof secret !== "string" || !secret) return null;
  const given = Buffer.from(secret);
  const same = (s) => {
    const own = Buffer.from(s.secret);
    return own.length === given.length && timingSafeEqual(own, given);
  };
  for (const room of rooms.values()) {
    const seat = room.seats.find(same);
    if (seat) return { room, seat };
  }
  return null;
}

function storeBytes() {
  let n = 0;
  for (const a of avatars.values()) n += a.body.length;
  return n;
}

function forgetAvatar(seat) {
  if (seat.avatarId) avatars.delete(seat.avatarId);
  seat.avatarId = null;
}

function route(req, res) {
  // #368: a target like "//" or "//[" makes new URL throw, which used to take the whole host down.
  const url = URL.parse(req.url, "http://127.0.0.1");
  if (!url) {
    res.writeHead(400);
    res.end();
    return;
  }
  if (req.method === "POST" && url.pathname === "/avatars") {
    // #369: only a seated player uploads, keyed by the secret from their welcome, and the picture becomes that
    // seat's own: it goes when the seat goes, and nobody else's hello can claim it. The host picks the id.
    const found = seatOf(req.headers["x-seat-secret"]);
    // Cut the socket once the answer is out, so a body still coming in is not read and the client still sees the status.
    const refuse = (status) => {
      res.writeHead(status, { connection: "close" });
      res.end(() => req.destroy());
    };
    if (!found) return refuse(403);
    const { room, seat } = found;
    if (!allow(seat.act, Date.now(), ACT_CAP, ACT_RATE)) return refuse(429);
    // Bytes this seat's current picture holds; its replacement frees them. Read again at the end, since the body
    // arrives over time and another upload may have landed meanwhile.
    const held = () => (seat.avatarId ? avatars.get(seat.avatarId).body.length : 0);
    if (avatars.size - (held() ? 1 : 0) >= AVATAR_MAX) return refuse(503);
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > AVATAR_BYTES) {
        res.writeHead(413, { connection: "close" });
        res.end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.headersSent) return;
      // The seat was let go, or its room dropped, while the body was still coming: nothing would ever free it.
      if (rooms.get(room.code) !== room || !room.seats.includes(seat)) return res.writeHead(410).end();
      const body = Buffer.concat(chunks);
      // Served as image/jpeg, so only JPEG bytes (SOI marker) are kept.
      if (size < 3 || body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) return res.writeHead(400).end();
      if (storeBytes() - held() + size > AVATAR_STORE_BYTES) return res.writeHead(503).end();
      forgetAvatar(seat);
      const id = randomBytes(8).toString("hex");
      avatars.set(id, { body });
      seat.avatarId = id;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ avatarId: id, url: `/avatars/${id}.jpg` }));
      publish(room);
    });
    req.on("error", () => {});
    return;
  }
  const got = url.pathname.match(/^\/avatars\/(.+)\.jpg$/);
  if (req.method === "GET" && got && avatars.has(got[1])) {
    res.writeHead(200, { "content-type": "image/jpeg", "x-content-type-options": "nosniff" });
    res.end(avatars.get(got[1]).body);
    return;
  }
  if (req.method === "GET" && url.pathname === "/tables") {
    // Same allow() throttle shape as the WS peek/list bucket (#833 review).
    const key = ipKey(req.socket.remoteAddress, req.headers["cf-connecting-ip"]) ?? "loopback";
    const now = Date.now();
    let bucket = httpListBuckets.get(key);
    if (!bucket) httpListBuckets.set(key, (bucket = { tokens: TABLES_CAP, at: now }));
    if (httpListBuckets.size > 1024) for (const [k, b] of httpListBuckets) if (now - b.at > 60_000) httpListBuckets.delete(k);
    if (!allow(bucket, now, TABLES_CAP, TABLES_RATE)) {
      res.writeHead(429, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "cache-control": "no-cache",
        "retry-after": "1",
      });
      res.end("[]");
      return;
    }
    const body = JSON.stringify(getOpenTables());
    res.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-cache",
    });
    res.end(body);
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }
  res.writeHead(404);
  res.end();
}

// No single request may crash the host and drop every table.
const server = http.createServer((req, res) => {
  try {
    route(req, res);
  } catch (e) {
    console.error("http request failed:", e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// One address carries the page, the socket and the avatars, so a single tunnel reaches all three.
async function serveStatic(req, res) {
  const raw = req.url.split("?")[0];
  let file;
  try {
    const rel = decodeURIComponent(raw);
    if (rel.includes("\0")) throw new Error("nul");
    file = path.resolve(DIST, "." + (rel === "/" ? "/index.html" : rel));
  } catch {
    file = null;
  }
  if (!file || !file.startsWith(DIST + path.sep)) {
    res.writeHead(404);
    res.end();
    return;
  }
  let body;
  try {
    body = await readFile(file);
  } catch {
    if (raw === "/") {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("Run npm run build first.");
    } else {
      res.writeHead(404);
      res.end();
    }
    return;
  }
  // Automatic discovery is native-host-only; static copies of the build carry no marker.
  if (file === path.join(DIST, "index.html")) body = Buffer.from(body.toString().replace("</head>", '<meta name="emberisle-host" content="1"></head>'));
  const hashed = raw.startsWith("/assets/");
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const profiles = openProfiles(PROFILES, { colors: PLAYER_COLORS });
const onProfile = profileHandler(profiles, send);

// A name is the join key for the away marker, chat mentions and the log, so it is cleaned and made unique.
function seatName(room, raw, fallback, except = null) {
  const base = typeof raw === "string" ? Array.from(raw.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/ {2,}/g, " ").trim()).slice(0, 16).join("").trimEnd() : "";
  const name = base || fallback;
  const taken = (n) => room.seats.some((s) => s !== except && s.name.toLowerCase() === n.toLowerCase());
  if (!taken(name)) return name;
  for (let i = 2; ; i++) {
    const tag = ` ${i}`;
    const next = Array.from(name).slice(0, 16 - tag.length).join("").trimEnd() + tag;
    if (!taken(next)) return next;
  }
}

// Only a palette swatch is accepted, since the colour reaches inline styles; anything else gets the first free one.
function seatColor(room, raw) {
  if (PLAYER_COLORS.includes(raw)) return raw;
  return PLAYER_COLORS.find((c) => !room.seats.some((s) => s.color === c));
}

function openTable(ws, msg) {
  if (msg.wayfarerMode !== undefined && !["on", "off"].includes(msg.wayfarerMode)) return send(ws, { type: "error", message: "Choose Wayfarer On or Off." });
  if (rooms.size >= ROOM_MAX) return send(ws, { type: "error", message: "The host is full." });
  // An optional profile, verified before the table opens; a refusal opens nothing (#764).
  const profile = seatCredential(profiles, ws, msg, () => false);
  if (profile?.code) return send(ws, { type: "error", ...profile });
  const now = Date.now();
  const mine = ws.ipKey ? ipBucket(ws.ipKey, now) : null;
  if (mine && !allow(mine, now, OPEN_IP_CAP, 1000 / OPEN_IP_MS)) return send(ws, { type: "error", message: "You have opened several tables lately. Try again in a minute." });
  if (!allow(opens, now, OPEN_CAP, 1000 / OPEN_REFILL_MS)) {
    if (mine) mine.tokens += 1;
    return send(ws, { type: "error", message: "Too many new tables right now. Try again in a minute." });
  }
  const visibility = msg.visibility === "open" ? "open" : "private";
  const room = { victoryTarget: 10, wayfarerMode: msg.wayfarerMode ?? "on", numberTokens: "official", visibility, code: code(), seats: [], game: null, host: null, next: 0, offer: null, offerTimer: null, botDeclined: {}, chat: [], chatSeq: 0, watchers: new Set() };
  rooms.set(room.code, room);
  const seat = {
    id: `s${room.next++}`,
    name: seatName(room, msg.name, "Ember"),
    color: seatColor(room, msg.color),
    // A picture is set by POST /avatars with this seat's secret, never by hello (#369).
    avatarId: null,
    ready: false,
    ws,
    bucket: { tokens: 5, at: Date.now() },
    act: { tokens: ACT_CAP, at: Date.now() },
    secret: randomBytes(16).toString("hex"),
    ...(profile ? { profileId: profile.profileId } : {}),
  };
  room.seats.push(seat);
  room.host = seat.id;
  if (visibility === "open" && !registerOpenTable(room)) {
    rooms.delete(room.code);
    return send(ws, { type: "error", message: "An open table is already listed." });
  }
  ws.room = room;
  ws.seat = seat;
  send(ws, { type: "welcome", proto: PROTO, serverSha: SERVER_SHA, code: room.code, you: seat.id, host: true, chat: room.chat, secret: seat.secret, ...HOLD_INFO, victoryTarget: room.victoryTarget ?? room.game?.victoryTarget ?? 10, wayfarerMode: room.wayfarerMode ?? room.game?.wayfarerMode ?? "on", numberTokens: numberTokensOf(room) });
  say(room, `${seat.name} sat down.`);
  publish(room);
}

function sitDown(ws, msg) {
  const room = rooms.get(String(msg.code || "").toUpperCase());
  if (!room) return send(ws, { type: "error", message: "No table with that code" });
  if (room.game) return send(ws, { type: "error", message: "Game already started." });
  if (room.seats.length >= 4) return send(ws, { type: "error", message: "Table full." });
  const color = seatColor(room, msg.color);
  if (!color || room.seats.some((s) => s.color === color)) return send(ws, { type: "error", message: "Color taken." });
  // One profile, one seat: a seat it holds, live or held, is never recovered or doubled by the credential (#764).
  const profile = seatCredential(profiles, ws, msg, (id) => room.seats.some((s) => s.profileId === id));
  if (profile?.code) return send(ws, { type: "error", ...profile });
  const seat = {
    id: `s${room.next++}`,
    name: seatName(room, msg.name, "Tide"),
    color,
    avatarId: null,
    ready: false,
    ws,
    bucket: { tokens: 5, at: Date.now() },
    act: { tokens: ACT_CAP, at: Date.now() },
    secret: randomBytes(16).toString("hex"),
    ...(profile ? { profileId: profile.profileId } : {}),
  };
  room.seats.push(seat);
  ws.room = room;
  ws.seat = seat;
  send(ws, { type: "welcome", proto: PROTO, serverSha: SERVER_SHA, code: room.code, you: seat.id, host: false, chat: room.chat, secret: seat.secret, ...HOLD_INFO, victoryTarget: room.victoryTarget ?? room.game?.victoryTarget ?? 10, wayfarerMode: room.wayfarerMode ?? room.game?.wayfarerMode ?? "on", numberTokens: numberTokensOf(room) });
  say(room, `${seat.name} sat down.`);
  publish(room);
}

// hello {code, watch:true} on a started table: no seat, no secret, read-only (docs/design/spectator.md, #347).
function watch(ws, msg) {
  const room = rooms.get(String(msg.code || "").toUpperCase());
  if (!room) return send(ws, { type: "error", message: "No table with that code" });
  if (!room.game) return send(ws, { type: "error", message: "Not started yet." });
  // A watcher never attaches a profile (#764); its credential is refused, not looked at.
  if (msg.credential !== undefined && msg.credential !== null) return send(ws, { type: "error", ...watchRefusal() });
  if (room.watchers.size >= SPECTATOR_MAX) return send(ws, { type: "error", message: "Table is full to watch." });
  room.watchers.add(ws);
  ws.watch = room;
  send(ws, { type: "welcome", proto: PROTO, serverSha: SERVER_SHA, code: room.code, spectator: true, chat: room.chat, victoryTarget: room.victoryTarget ?? room.game?.victoryTarget ?? 10, wayfarerMode: room.wayfarerMode ?? room.game?.wayfarerMode ?? "on", numberTokens: numberTokensOf(room) });
  watchersChanged(room, "Someone is watching.");
  const soonest = room.seats.reduce((d, s) => (s.turnDeadline && (!d || s.turnDeadline < d.turnDeadline) ? s : d), null);
  send(ws, { type: "state", you: null, game: watchView(room.game), legal: legalFor(room.game, null), turnExtension: extensions(room).state(), turnDeadline: deadlineOf(room), turnPlayer: soonest?.pid ?? null, serverNow: Date.now() });
}

function startGame(ws, room) {
  const n = room.seats.length;
  if (ws.seat.id !== room.host) return send(ws, { type: "error", message: "Only the host can start." });
  if (n < 3 || n > 4) return send(ws, { type: "error", message: "Need 3 or 4 at the table." });
  if (room.seats.some((s) => !s.ready)) return send(ws, { type: "error", message: "Not everyone is ready." });
  const game = createGame({ humans: room.seats.map((s) => ({ name: s.name })), bots: 0, victoryTarget: room.victoryTarget ?? 10, wayfarerMode: room.wayfarerMode ?? "on", numberTokens: numberTokensOf(room) });
  room.seats.forEach((s, i) => {
    s.pid = game.players[i].id;
    game.players[i].color = s.color;
    if (s.bot) game.players[i].kind = "bot";
  });
  room.game = game;
  freezeRoster(room, room.seats);
  room.botDeclined = {};
  room.recoveryPids = [];
  for (const seat of room.seats) if (seat.ws) seat.ws.actionConnection = randomBytes(16).toString("hex");
  hear("ui_confirm");
  say(room, "Roll for first place.");
  const seen = room.game.log;
  runBots(room);
  for (const line of newLog(seen, room.game.log)) say(room, line);
  pushState(room);
}

// Lobby only. The host seats a practice bot (the same one that plays a dropped seat in a game) in the next free seat; it is
// ready, has no socket and no hold timers, and a secret nobody is ever told.
function addBot(ws, room) {
  if (ws.seat.id !== room.host) return send(ws, { type: "error", message: "Only the host can add a bot." });
  if (room.game) return send(ws, { type: "error", message: "Game already started." });
  if (room.seats.length >= 4) return send(ws, { type: "error", message: "Table full." });
  const seat = {
    id: `s${room.next++}`,
    name: seatName(room, "Bot", "Bot"),
    color: seatColor(room),
    avatarId: null,
    ready: true,
    bot: true,
    ws: null,
    bucket: { tokens: 5, at: Date.now() },
    act: { tokens: ACT_CAP, at: Date.now() },
    secret: randomBytes(16).toString("hex"),
  };
  room.seats.push(seat);
  say(room, `${seat.name} sat down.`);
  publish(room);
}

function removeBot(ws, room, msg) {
  if (ws.seat.id !== room.host) return send(ws, { type: "error", message: "Only the host can remove a bot." });
  if (room.game) return send(ws, { type: "error", message: "Game already started." });
  const seat = room.seats.find((s) => s.bot && s.id === msg.id);
  if (!seat) return send(ws, { type: "error", message: "No such bot." });
  room.seats = room.seats.filter((s) => s !== seat);
  say(room, `${seat.name} left.`);
  publish(room);
}

// Lobby only: the game copies the names when it starts. The same cleaning as hello; a name already taken at the table gets a number.
function renameSeat(ws, room, msg) {
  if (room.game) return send(ws, { type: "error", message: "Names are fixed once the game starts." });
  const now = Date.now();
  if (now - (ws.seat.renamedAt ?? 0) < RENAME_MS) return send(ws, { type: "error", message: "Slow down." });
  const before = ws.seat.name;
  const name = seatName(room, msg.name, "", ws.seat);
  if (!name) return send(ws, { type: "error", message: "Pick a name." });
  if (name === before) return publish(room);
  ws.seat.name = name;
  ws.seat.renamedAt = now;
  say(room, `${before} is now ${name}.`);
  publish(room);
}

// `again` (#266, docs/design/rematch.md): a new island at the same table. The last winner places first and the rest
// roll off behind it (Jarrod, 2026-10-03). Seats with no socket are let go; watchers stay and get the new game.
function rematch(ws, room) {
  if (ws.seat.id !== room.host) return send(ws, { type: "error", message: "Only the host can start." });
  if (room.game?.phase !== "over") return send(ws, { type: "error", message: "Game is not over." });
  const live = room.seats.filter((s) => s.bot || (s.ws && s.ws.readyState === s.ws.OPEN));
  if (live.length < 3) return send(ws, { type: "error", message: "Need 3 or 4 at the table." });
  for (const seat of room.seats) {
    if (live.includes(seat)) continue;
    clearTimeout(seat.graceTimer);
    clearTimeout(seat.holdTimer);
    disarmTurn(seat);
    forgetAvatar(seat);
    seat.ws = null;
  }
  room.seats = live;
  // Seats get new pids below, so no offer (or a bot's answer timer on it) may outlive the old game.
  if (room.offer) broadcast(room, { type: "tradeClosed", tradeId: room.offer.tradeId });
  closeOffer(room);
  room.botDeclined = {};
  room.recoveryPids = [];
  const winner = live.find((s) => s.pid === room.game.winner);
  const order = winner ? [winner, ...live.filter((s) => s !== winner)] : live;
  const game = createGame({ humans: order.map((s) => ({ name: s.name })), bots: 0, winnerFirst: Boolean(winner), victoryTarget: room.victoryTarget ?? room.game.victoryTarget ?? 10, wayfarerMode: room.wayfarerMode ?? room.game.wayfarerMode ?? "on", numberTokens: numberTokensOf(room) });
  order.forEach((s, i) => {
    s.pid = game.players[i].id;
    game.players[i].color = s.color;
    if (s.bot) game.players[i].kind = "bot";
  });
  room.game = game;
  // New pids in the new order: the rematch gets its own game UUID and roster (#764).
  freezeRoster(room, order);
  // Reclaim a finished open room's slot only if no successor has taken it (#986).
  if (room.visibility === "open") registerOpenTable(room);
  for (const seat of room.seats) if (seat.ws) seat.ws.actionConnection = randomBytes(16).toString("hex");
  hear("ui_confirm");
  say(room, winner ? `${winner.name} won last time and places first. The rest roll for their order.` : "Roll for first place.");
  const seen = room.game.log;
  runBots(room);
  for (const line of newLog(seen, room.game.log)) say(room, line);
  publish(room);
  pushState(room);
}

// Build bible section 10 intents -> rules.ts actions.
function toAction(game, msg) {
  switch (msg.type) {
    case "roll":
      return { type: "roll" };
    case "place":
      if (msg.kind === "outpost") {
        return { type: game.phase === "setupSettle" ? "setupSettle" : "buildOutpost", vertexId: msg.id };
      }
      if (msg.kind === "path") return { type: game.phase === "setupRoad" ? "setupRoad" : "buildPath", edgeId: msg.id };
      if (msg.kind === "stronghold") return { type: "buildStronghold", vertexId: msg.id };
      return null;
    case "buy":
      return { type: "buyCard" };
    case "play":
      if (msg.card === "knight") return { type: "playKnight", hexId: msg.hexId, stealFrom: msg.stealFrom ?? null };
      if (msg.card === "road") return { type: "playRoad", edgeIds: msg.ids ?? [] };
      if (msg.card === "plenty") return { type: "playPlenty", resources: msg.resources ?? [] };
      if (msg.card === "monopoly") return { type: "playMonopoly", resource: msg.resource };
      return null;
    case "rob":
      return { type: "moveRobber", hexId: msg.hexId, stealFrom: msg.stealFrom ?? null };
    case "discard":
      return { type: "discard", resources: msg.cards ?? msg.resources ?? {} };
    case "tradeBank":
      return { type: "bankTrade", give: msg.give, want: msg.take ?? msg.want };
    case "pass":
      return { type: "endTurn" };
    default:
      return null;
  }
}

const SOUND = {
  roll: "dice_land",
  buy: "card_buy",
  play: "card_play",
  rob: "ui_confirm",
  discard: "chip_gain",
  tradeBank: "trade_yes",
  pass: "ui_click",
};

function closeOffer(room) {
  if (room.offerTimer) clearTimeout(room.offerTimer);
  for (const t of room.offer?.botTimers ?? []) clearTimeout(t);
  room.offerTimer = null;
  room.offer = null;
}

// A bot's ask paused its turn in runBots; once that offer is gone the bots play on. With nobody connected they wait,
// as in takeOver, and a rejoin runs them. True when it pushed the state.
function botsOn(room, offer) {
  if (room.game.players.find((p) => p.id === offer.from)?.kind !== "bot" || !room.seats.some((s) => s.ws)) return false;
  const seen = room.game.log;
  const phase = room.game.phase;
  runBots(room);
  for (const line of newLog(seen, room.game.log)) say(room, line);
  if (room.game.phase === "over" && phase !== "over") {
    hear("win");
    maybeReleaseOpenSlot(room);
  }
  pushState(room);
  return true;
}

// Opens the table offer for `from`, closing any earlier one. Every other bot seat answers it after a short delay.
function openOffer(room, from, give, want) {
  if (room.offer) broadcast(room, { type: "tradeClosed", tradeId: room.offer.tradeId });
  closeOffer(room);
  const tradeId = `t${room.game.seq}-${(room.offerSeq = (room.offerSeq ?? 0) + 1)}`;
  const offer = (room.offer = { tradeId, from, give, want, declined: new Set(), botTimers: [], until: Date.now() + 20000 });
  room.offerTimer = setTimeout(() => {
    closeOffer(room);
    broadcast(room, { type: "tradeClosed", tradeId });
    botsOn(room, offer);
  }, 20000);
  broadcast(room, { type: "tradeOffer", tradeId, from, give, want, seconds: 20 });
  offer.peopleUntil = Date.now() + PEOPLE_FIRST_MS;
  offer.heldYes = [];
  offer.botTimers.push(setTimeout(() => releaseHeld(room, offer), PEOPLE_FIRST_MS));
  for (const p of room.game.players) {
    if (p.kind !== "bot" || p.id === from) continue;
    offer.botTimers.push(setTimeout(() => botAnswer(room, offer, p.id), BOT_ANSWER_MS + randomInt(BOT_ANSWER_MS + 1)));
  }
}

// The seat may have been taken back by its player, or the offer closed, while the bot was "thinking".
function botAnswer(room, offer, pid) {
  if (room.offer !== offer || room.game.players.find((p) => p.id === pid)?.kind !== "bot") return;
  const recovery = (room.recoveryPids ?? []).includes(pid);
  const yes = !recovery && shouldAcceptTrade(room.game, pid, offer);
  if (yes && peopleWaiting(room, offer)) return void offer.heldYes.push(pid);
  respond(room, pid, yes);
}

function peopleWaiting(room, offer) {
  if (Date.now() >= offer.peopleUntil) return false;
  return room.game.players.some((p) => p.kind !== "bot" && p.id !== offer.from && !offer.declined.has(p.id));
}

// Held Yeses go in the order the bots gave them, so the first bot to say Yes still takes it.
function releaseHeld(room, offer) {
  for (const pid of offer.heldYes.splice(0)) {
    if (room.offer !== offer) return;
    if (room.game.players.find((p) => p.id === pid)?.kind === "bot") respond(room, pid, true);
  }
}

function ask(ws, room, msg) {
  const actor = ws.seat.pid;
  if (room.game.phase !== "main" || room.game.current !== actor) {
    return send(ws, { type: "error", message: "Cannot trade now." });
  }
  if (!validBag(msg.give) || !validBag(msg.want)) return send(ws, { type: "error", message: "Bad trade." });
  const asker = room.game.players.find((p) => p.id === actor);
  if (RESOURCES.some((r) => (msg.give[r] ?? 0) > asker.resources[r])) return send(ws, { type: "error", message: "You lack those goods." });
  if (RESOURCES.every((r) => !msg.give[r] && !msg.want[r])) return send(ws, { type: "error", message: "Offer something." });
  openOffer(room, actor, msg.give, msg.want);
}

function answer(ws, room, msg) {
  const actor = ws.seat.pid;
  const offer = room.offer;
  if (!offer || actor === offer.from || (msg.tradeId && msg.tradeId !== offer.tradeId)) {
    return send(ws, { type: "error", message: "Offer is gone." });
  }
  const error = respond(room, actor, Boolean(msg.yes ?? msg.accept));
  if (error) send(ws, { type: "error", message: error });
}

// `actor`'s Yes or No to the open offer, from a person or a bot seat. Returns an error for that seat, if any.
function respond(room, actor, yes) {
  const offer = room.offer;
  if (!yes) {
    // A "No" is told to the whole table. The offer stays open for seats that have not answered and
    // closes once every other seat, person or bot, has declined.
    if (offer.declined.has(actor)) return;
    offer.declined.add(actor);
    hear("trade_no");
    const player = room.game.players.find((p) => p.id === actor);
    const name = player.name;
    broadcast(room, { type: "tradeDeclined", tradeId: offer.tradeId, by: actor, name });
    const recovery = (room.recoveryPids ?? []).includes(actor);
    const line = recovery ? `Bot declined a trade for ${room.seats.find((s) => s.pid === actor)?.name ?? name.replace(/ \(bot\)$/i, "")}.` : `${name} declines.`;
    if (recovery) {
      room.game = { ...room.game, log: [...room.game.log.slice(-199), line] };
      save(room);
    }
    say(room, line);
    const askees = room.game.players.filter((p) => p.id !== offer.from);
    if (askees.every((p) => offer.declined.has(p.id))) {
      if (room.game.players.find((p) => p.id === offer.from)?.kind === "bot") {
        (room.botDeclined ??= {})[offer.from] = { give: offer.give, want: offer.want };
      }
      closeOffer(room);
      broadcast(room, { type: "tradeClosed", tradeId: offer.tradeId });
      botsOn(room, offer);
    } else if (!peopleWaiting(room, offer)) releaseHeld(room, offer);
    return;
  }
  const offered = applyAction(room.game, offer.from, { type: "offerTrade", to: actor, give: offer.give, want: offer.want });
  // Every offerTrade refusal is the asker's (wrong phase, short of the goods), so the offer is dead for the whole table.
  if (offered.error) {
    closeOffer(room);
    broadcast(room, { type: "tradeClosed", tradeId: offer.tradeId });
    botsOn(room, offer);
    return "Offer is gone.";
  }
  const accepted = applyAction(offered.state, actor, { type: "respondTrade", accept: true });
  if (accepted.error) return accepted.error;
  closeOffer(room);
  const tradeLines = newLog(room.game.log, accepted.state.log).filter((line) => !line.includes(" offers a trade to "));
  room.game = { ...accepted.state, log: [...room.game.log, ...tradeLines].slice(-200) };
  for (const line of tradeLines) say(room, line);
  // The asker's trade went through: that is their action, so their window restarts (pushState re-arms it).
  const asker = room.seats.find((s) => s.pid === offer.from);
  if (asker) disarmTurn(asker);
  hear("trade_yes");
  broadcast(room, { type: "tradeClosed", tradeId: offer.tradeId, taker: actor });
  if (!botsOn(room, offer)) pushState(room);
}

function talk(ws, room, msg) {
  const seat = ws.seat;
  if (!allow(seat.bucket, Date.now())) return send(ws, { type: "error", message: "Slow down." });
  if (msg.type === "sound") {
    // One tap per seat every SOUND_MS, on top of the chat bucket, so a clip cannot be spammed at the table.
    if (typeof msg.id !== "string" || !SOUNDBOARD.has(msg.id)) return send(ws, { type: "error", message: "Unknown sound." });
    const now = Date.now();
    if (now - (seat.soundAt ?? 0) < SOUND_MS) return send(ws, { type: "error", message: "Slow down." });
    seat.soundAt = now;
    const line = { id: room.chatSeq++, seat: seat.id, player: seat.pid ?? null, name: seat.name, color: seat.color, text: `🔊 ${SOUNDBOARD.get(msg.id)}`, sound: msg.id, at: now };
    remember(room.chat, line, 30);
    broadcast(room, { type: "chat", ...line });
    save(room);
    return;
  }
  if (msg.type === "chat") {
    const text = cleanText(msg.text);
    if (text === null) return;
    const line = { id: room.chatSeq++, seat: seat.id, player: seat.pid ?? null, name: seat.name, color: seat.color, text, at: Date.now() };
    remember(room.chat, line, 30);
    broadcast(room, { type: "chat", ...line });
    save(room);
    return;
  }
  // Keep the six exact emoji in sync with emotes.ts; chat-prove exercises every picker entry.
  const emoji = new Set(["😠", "😊", "👏", "😂", "🔥", "🐑"]);
  if (!EMOTES.has(msg.emote) && !emoji.has(msg.emote)) return;
  let to = typeof msg.to === "string" ? msg.to : null;
  if (to && !room.seats.some((s) => s.id === to || s.pid === to)) to = null;
  broadcast(room, { type: "react", seat: seat.id, player: seat.pid ?? null, emote: msg.emote, to, at: Date.now() });
}

function play(ws, room, msg, automated = false) {
  const before = room.game;
  const action = toAction(before, msg);
  if (!action) return send(ws, { type: "error", message: "not ready" });
  const next = applyAction(before, ws.seat.pid, action);
  if (next.error) {
    hear("ui_error");
    return send(ws, { type: "error", message: next.error });
  }
  room.game = automated
    ? logBotAction(before, next.state, action, ws.seat.pid, room.seats.find((s) => s.pid === ws.seat.pid)?.name ?? ws.seat.name)
    : next.state;
  disarmTurn(ws.seat);
  hear(msg.type === "place" ? `${msg.kind}_place` : SOUND[msg.type]);
  // A roll-off die is not a production roll: its lines reach every seat through the log below.
  if (msg.type === "roll" && before.phase === "roll") {
    const [a, b] = room.game.dice;
    const paid = gains(before, room.game);
    const short = bankShort(room.game);
    broadcast(room, { type: "rolled", dice: [a, b], sum: a + b, gains: paid, short });
    // No summary line here (#687): the log loop below says the roll's own lines, "<name> rolled <sum>!" then the goods line.
  }
  // An offer lives only while its asker still has the turn in `main` and still holds the offered goods. Checked before
  // the bots play, so a bot never sees the stale offer of a seat that just passed.
  const open = room.offer;
  let withdrawn = null;
  if (open) {
    const asker = room.game.players.find((p) => p.id === open.from);
    const turnOver = room.game.current !== open.from || room.game.phase !== "main";
    const spent = RESOURCES.some((r) => (open.give[r] ?? 0) > asker.resources[r]);
    if (turnOver || spent) {
      closeOffer(room);
      broadcast(room, { type: "tradeClosed", tradeId: open.tradeId });
      if (!turnOver) withdrawn = `${asker.name} spent the offered goods; the offer is withdrawn.`;
    }
  }
  runBots(room);
  for (const line of newLog(before.log, room.game.log)) say(room, line);
  if (withdrawn) say(room, withdrawn);
  if (room.game.phase === "over" && before.phase !== "over") {
    hear("win");
    maybeReleaseOpenSlot(room);
  }
  pushState(room);
}

wss.on("connection", (ws, req) => {
  ws.ipKey = ipKey(req.socket.remoteAddress, req.headers["cf-connecting-ip"]);
  ws.profileGate = profileGate(req, PROFILES_DEV);
  // An over-limit frame (maxPayload) raises 'error' on this one socket; with no listener here,
  // Node's default behavior is to throw and take down the whole host. One bad frame must only
  // close that socket (ws already sends close code 1009) and never the other tables.
  ws.on("error", () => {});
  ws.alive = true;
  ws.bucket = { tokens: 5, at: Date.now() };
  ws.on("pong", () => (ws.alive = true));
  ws.on("message", (raw) => {
    try {
      handle(ws, raw);
    } catch (err) {
      // One bad message must never take down every table on this host.
      console.error("message failed:", err);
      send(ws, { type: "error", message: "not ready" });
    }
  });
  ws.on("close", () => {
    try {
      leave(ws);
    } catch (err) {
      console.error("leave failed:", err);
    }
  });
});

// A watcher's frame, read only far enough to see whether it is a tableProfileCard request (#764).
function cardRequest(raw) {
  try {
    const msg = JSON.parse(String(raw));
    return msg && typeof msg === "object" && msg.type === "tableProfileCard" ? msg : null;
  } catch {
    return null;
  }
}

// Card reads have their own per-socket bucket: a burst of 10, two a second.
function cardAllowed(ws) {
  const now = Date.now();
  return allow((ws.cardBucket ??= { tokens: 10, at: now }), now, 10, 2);
}

function handle(ws, raw) {
  // Watchers retain their pre-parse budget, including malformed frames and health probes.
  if (ws.watch && !allow(ws.bucket, Date.now())) return;
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return send(ws, { type: "error", message: ws.watch ? "Watching only." : "not ready" });
  }
  if (!msg || typeof msg !== "object") return send(ws, { type: "error", message: ws.watch ? "Watching only." : "not ready" });
  // Health has no room/state access, action bucket, publish, save, or game timer side effects.
  // Unauthenticated probes consume the same budget as hello/peek, and never earn a reply.
  if (msg.type === "healthPing") {
    if (!ws.room && !ws.watch) { allow(ws.bucket, Date.now()); return; }
    if (typeof msg.nonce !== "string" || !/^[a-f0-9]{32}$/.test(msg.nonce)) return;
    const now = performance.now();
    // Two arrivals may bunch when network delay changes; sustained replies stay at one per 30 seconds.
    ws.healthBucket ??= { tokens: 2, at: now };
    if (!allow(ws.healthBucket, now, 2, 1 / 30)) return;
    return send(ws, { type: "healthPong", nonce: msg.nonce });
  }
  if (ws.watch) {
    // Preserve main's public-card read after the separately bounded health probe; the pre-parse budget was charged above.
    const card = cardRequest(raw);
    if (card) return tableCard(profiles, send, ws, card, rooms.get(ws.watch.code) === ws.watch && ws.watch.watchers.has(ws) ? visibleProfiles(ws.watch) : null, cardAllowed(ws));
    return send(ws, { type: "error", message: "Watching only." });
  }
  // Profile frames have their own connection and limits (#762); a profile connection never opens, joins or watches a table.
  if (PROFILE_TYPES.has(msg.type)) return onProfile(ws, msg);
  if (ws.profileSocket) return send(ws, { type: "error", message: "not ready" });
  // A seat's card read is scoped to its own live seat at its current table; a seatless socket sees no cards (#764).
  if (msg.type === "tableProfileCard") {
    const room = ws.room;
    const here = room && rooms.get(room.code) === room && ws.seat?.ws === ws && room.seats.includes(ws.seat);
    return tableCard(profiles, send, ws, msg, here ? visibleProfiles(room) : null, cardAllowed(ws));
  }
  if (!ws.room) {
    // A socket with no seat has no seat.bucket; this one throttles the pre-seat frames (docs/design/color-peek.md).
    const ok = allow(ws.bucket, Date.now());
    if (msg.type === "list") return ok ? send(ws, { type: "openTables", tables: getOpenTables() }) : undefined;
    if (msg.type === "peek") return ok ? peek(ws, msg) : undefined;
    if (!ok && (msg.type === "create" || msg.type === "join" || msg.type === "hello")) return send(ws, { type: "error", message: "Slow down." });
    // G2: a hello on a protocol newer than this host, or on a version that is not a whole number, is refused before it opens,
    // takes or watches a table. No proto counts as 0 (a page from before G2) and is still let in for now.
    const proto = msg.proto ?? 0;
    if ((msg.type === "create" || msg.type === "join" || msg.type === "hello") && !(Number.isSafeInteger(proto) && proto >= 0 && proto <= PROTO)) {
      return send(ws, { type: "error", proto: PROTO, message: `Unknown protocol version; this table speaks protocol ${PROTO}. Reload to update.` });
    }
    if (msg.type === "hello" && msg.watch === true) return watch(ws, msg);
    // hello with no code opens a table; hello with a code sits down (build bible 2.3, 10).
    if (msg.type === "create" || (msg.type === "hello" && !msg.code)) return openTable(ws, msg);
    if (msg.wayfarerMode !== undefined) return send(ws, { type: "error", message: "Wayfarer mode is fixed when the table is created." });
    if (msg.type === "hello" && typeof msg.secret === "string") return rejoin(ws, msg);
    if (msg.type === "join" || msg.type === "hello") return sitDown(ws, msg);
    return send(ws, { type: "error", message: "not ready" });
  }
  const room = ws.room;
  if (msg.type === "leave") return leaveOnPurpose(ws, room);
  if (msg.wayfarerMode !== undefined || msg.type === "setWayfarerMode") return send(ws, { type: "error", message: "Wayfarer mode is fixed when the table is created." });
  if (msg.type === "chat" || msg.type === "react" || msg.type === "sound") return talk(ws, room, msg);
  if (!allow(ws.seat.act, Date.now(), ACT_CAP, ACT_RATE)) return send(ws, { type: "error", message: "Slow down." });
  if (msg.type === "setVictoryTarget") {
    if (ws.seat.id !== room.host) return send(ws, { type: "error", message: "Only the host can choose the target." });
    if (room.game && room.game.phase !== "over") return send(ws, { type: "error", message: "The target is fixed for this game." });
    if (msg.value !== 7 && msg.value !== 10) return send(ws, { type: "error", message: "Choose 7 or 10 points." });
    room.victoryTarget = msg.value;
    return publish(room);
  }
  // #1156: the same window as the target: the lobby, or a finished game before its rematch.
  if (msg.type === "setNumberTokens") {
    if (ws.seat.id !== room.host) return send(ws, { type: "error", message: "Only the host can choose the number tokens." });
    if (room.game && room.game.phase !== "over") return send(ws, { type: "error", message: "The number tokens are fixed for this game." });
    if (msg.value !== "official" && msg.value !== "random") return send(ws, { type: "error", message: "Choose Official spiral or Random." });
    room.numberTokens = msg.value;
    return publish(room);
  }
  if (msg.type === "ready") {
    const value = Boolean(msg.value);
    if (ws.seat.ready === value) return;
    ws.seat.ready = value;
    return publish(room);
  }
  if (msg.type === "rename") return renameSeat(ws, room, msg);
  if (msg.type === "addBot") return addBot(ws, room);
  if (msg.type === "removeBot") return removeBot(ws, room, msg);
  if (msg.type === "start") return room.game ? send(ws, { type: "error", message: "Game already started." }) : startGame(ws, room);
  if (msg.type === "again") return rematch(ws, room);
  if (!room.game) return send(ws, { type: "error", message: "not ready" });
  if (!freshAction(ws, room, msg)) return;
  if (msg.type === "turnExtensionAsk" || msg.type === "turnExtensionAnswer") {
    const error = msg.type === "turnExtensionAsk" ? extensions(room).ask(ws.seat, msg) : extensions(room).answer(ws.seat, msg);
    if (error) return send(ws, { type: "error", message: error });
    return; // The extension changed callback publishes the updated state.
  }
  if (msg.type === "tradeAsk") return ask(ws, room, msg);
  if (msg.type === "tradeAnswer") return answer(ws, room, msg);
  return play(ws, room, msg);
}

const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

// Answers which seats a lobby holds, without sitting down (docs/design/color-peek.md). The asker has no seat, so it gets
// what dims the swatches and nothing more: no names or pictures for whoever holds the code (G10). Those come with the
// `seats` broadcast after sitting down.
function peek(ws, msg) {
  const code = typeof msg.code === "string" ? msg.code.toUpperCase() : "";
  if (!CODE.test(code)) return;
  const room = rooms.get(code);
  const seats = room && !room.game ? room.seats.map((s) => ({ id: s.id, color: s.color, ready: s.ready })) : [];
  send(ws, { type: "seats", code, seats });
}

// hello {code, secret} puts a dropped player back in their own seat, even after the bot took over.
function rejoin(ws, msg) {
  const room = rooms.get(String(msg.code || "").toUpperCase());
  if (!room) return send(ws, { type: "error", message: "No table with that code" });
  const seat = room.seats.find((s) => s.secret === msg.secret);
  if (!seat) return send(ws, { type: "error", message: "Seat is gone." });
  if (seat.ws && seat.ws.readyState === seat.ws.OPEN) return send(ws, { type: "error", message: "Seat is taken." });
  clearTimeout(seat.graceTimer);
  clearTimeout(seat.holdTimer);
  seat.graceTimer = seat.holdTimer = null;
  seat.ws = ws;
  seat.gone = null;
  // Restore discovery after a reload, without displacing a newer open table.
  if (room.visibility === "open" && room.game?.phase !== "over") registerOpenTable(room);
  ws.room = room;
  ws.seat = seat;
  send(ws, { type: "welcome", proto: PROTO, serverSha: SERVER_SHA, code: room.code, you: seat.id, host: seat.id === room.host, chat: room.chat, secret: seat.secret, ...HOLD_INFO, victoryTarget: room.victoryTarget ?? room.game?.victoryTarget ?? 10, wayfarerMode: room.wayfarerMode ?? room.game?.wayfarerMode ?? "on", numberTokens: numberTokensOf(room) });
  say(room, `${seat.name} is back.`);
  publish(room);
  if (!room.game) return;
  const p = room.game.players.find((x) => x.id === seat.pid);
  if (p?.kind === "bot") {
    room.game = { ...room.game, players: room.game.players.map((x) => (x === p ? { ...x, kind: "human", name: seat.name } : x)) };
  }
  room.recoveryPids = (room.recoveryPids ?? []).filter((pid) => pid !== seat.pid);
  // Other seats may have become bots while nobody was here to watch them play.
  const seen = room.game.log;
  const open = room.offer;
  runBots(room);
  for (const line of newLog(seen, room.game.log)) say(room, line);
  pushState(room);
  // An ask the bots just opened was broadcast to this socket already; only one open from before is re-sent.
  if (open && room.offer === open) resendOffer(ws, room, seat, open);
}

// A seat back inside an open ask it did not make sees the offer again with what is left of its window, then every No
// it missed, so its panel matches the table (#576). After the state, so the client has the names.
function resendOffer(ws, room, seat, offer) {
  if (offer.from === seat.pid) return;
  const seconds = Math.max(0, Math.floor((offer.until - Date.now()) / 1000));
  send(ws, { type: "tradeOffer", tradeId: offer.tradeId, from: offer.from, give: offer.give, want: offer.want, seconds });
  for (const by of offer.declined) {
    send(ws, { type: "tradeDeclined", tradeId: offer.tradeId, by, name: room.game.players.find((p) => p.id === by).name });
  }
}

function dropRoom(room) {
  unregisterOpenTable(room);
  room.extensions?.close();
  closeOffer(room);
  for (const seat of room.seats) {
    clearTimeout(seat.graceTimer);
    clearTimeout(seat.holdTimer);
    clearTimeout(seat.turnTimer);
    forgetAvatar(seat);
  }
  for (const ws of room.watchers) {
    send(ws, { type: "error", message: "The table closed." });
    ws.close();
  }
  room.watchers.clear();
  rooms.delete(room.code);
  unsave(room);
}

// A seat with no socket: the bot takes it after the grace (in a game), and it is let go after the hold.
function hold(room, seat) {
  seat.ws = null;
  seat.gone = Date.now();
  // A dropped seat is the grace timer's business, never the turn timer's (#344).
  disarmTurn(seat);
  if (room.game) extensions(room).sync();
  if (room.game && seat.pid) seat.graceTimer = setTimeout(() => takeOver(room, seat), GRACE_MS);
  seat.holdTimer = setTimeout(() => letGo(room, seat), room.game ? HOLD_MS : LOBBY_HOLD_MS);
  // Free the open-list slot when nobody is connected so a finished or abandoned table cannot block a new open host.
  maybeReleaseOpenSlot(room);
}

// The host role goes to the first seat with a socket; with none, to the first held seat.
function handOffHost(room) {
  const next = room.seats.find((s) => s.ws) ?? room.seats.find((s) => !s.bot);
  room.host = next.id;
  say(room, `${next.name} is now the host.`);
}

// The grace is over: the practice bot plays the seat so the table never waits longer than that.
function takeOver(room, seat) {
  seat.graceTimer = null;
  const p = room.game.players.find((x) => x.id === seat.pid);
  if (!p || p.kind === "bot") return;
  if (room.offer?.from === seat.pid) {
    const tradeId = room.offer.tradeId;
    closeOffer(room);
    broadcast(room, { type: "tradeClosed", tradeId });
  }
  room.recoveryPids = [...new Set([...(room.recoveryPids ?? []), seat.pid])].slice(-4);
  room.game = { ...room.game, players: room.game.players.map((x) => (x === p ? { ...x, kind: "bot", name: `${x.name} (bot)` } : x)) };
  say(room, `${seat.name} is played by the bot until they return.`);
  save(room);
  // With nobody connected, the bots wait too: a rejoin runs them.
  if (!room.seats.some((s) => s.ws)) return;
  const seen = room.game.log;
  runBots(room);
  for (const line of newLog(seen, room.game.log)) say(room, line);
  pushState(room);
}

// The hold is over: the seat is let go for good. The bot keeps playing the player.
function letGo(room, seat) {
  clearTimeout(seat.graceTimer);
  forgetAvatar(seat);
  room.seats = room.seats.filter((s) => s !== seat);
  if (!room.seats.some((s) => !s.bot)) return dropRoom(room);
  if (!room.game) say(room, `${seat.name} left.`);
  if (room.host === seat.id) handOffHost(room);
  publish(room);
}

// The Leave button in the lobby: the seat goes now, so it never blocks Start. A dropped socket is held instead
// (leave), so a locked phone keeps its seat. In a game, Leave is a drop like any other: the seat is held for a rejoin.
function leaveOnPurpose(ws, room) {
  if (room.game) return;
  const seat = ws.seat;
  if (seat.ws !== ws) return;
  ws.room = ws.seat = null;
  seat.ws = null;
  letGo(room, seat);
  maybeReleaseOpenSlot(room);
}

function leave(ws) {
  if (ws.watch) {
    const room = ws.watch;
    ws.watch = null;
    if (!room.watchers.delete(ws) || !rooms.has(room.code)) return;
    watchersChanged(room, "A watcher left.");
    return;
  }
  const room = ws.room;
  if (!room) return;
  const seat = ws.seat;
  // A socket replaced by a rejoin closing late must not touch the seat it no longer holds.
  if (seat.ws !== ws) return;
  if (room.game && seat.pid) {
    hold(room, seat);
    say(room, `${seat.name} lost connection.`);
    publish(room);
    return;
  }
  // In the lobby the seat is held too, so a locked phone keeps its seat; it cannot be ready while away.
  seat.ready = false;
  hold(room, seat);
  say(room, `${seat.name} lost connection.`);
  // A held host hands the role to a live seat now and does not get it back on return.
  if (room.host === seat.id && room.seats.some((s) => s.ws)) handOffHost(room);
  publish(room);
}

// terminate() fires "close", so leave() holds the seat and starts the grace like any other drop.
const pinger = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, PING_MS);
pinger.unref();
wss.on("close", () => clearInterval(pinger));

load();
server.listen(PORT, () => console.log(`host listening ${server.address().port}`));
