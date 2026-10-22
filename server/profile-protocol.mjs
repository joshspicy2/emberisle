// The profile connection (#762, docs/design/profiles.md "Protocol and seat recovery"): a seatless socket that creates, signs in,
// resumes and signs out a profile. It never opens, joins, watches or recovers a table, and table sockets never carry these frames.
import { allow } from "./chat.mjs";
import { ProfileError, publicCard, seatView } from "./profiles.mjs";

export const CAPS = ["profilesV1"];
export const PROFILE_TYPES = new Set(["profileHello", "profileCreate", "profileLogin", "profileResume", "profileLogout"]);

// What a refused request says. Sign-in failures share one message: a wrong PIN, an unknown login and a spent budget look alike.
const MESSAGES = {
  invalid: "Check the highlighted fields.",
  loginTaken: "Choose another login.",
  signInFailed: "Couldn't sign in. Check your login and PIN, or try again later.",
  signedOut: "Signed out on this device. Sign in again.",
  busy: "The host is busy. Try again in a moment.",
  slowDown: "Slow down.",
  https: "Profiles need the HTTPS link. You can still play as a guest.",
  origin: "Profiles need the HTTPS link. You can still play as a guest.",
  unavailable: "Profiles unavailable on this host.",
  tableSocket: "Profiles use their own connection.",
};

const AUTH_PER_MIN = 20;
const CREATE_PER_HOUR = 3;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const IDLE_MS = 10 * 60 * 1000;
const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostnameOf(host) {
  if (typeof host !== "string" || !host) return null;
  return URL.parse(`http://${host}`)?.hostname ?? null;
}

// Whether this socket may carry a PIN or a device credential ("Authentication boundaries"). Decided once, at the upgrade.
// - Direct TLS: an encrypted socket whose page is https on this same host.
// - Cloudflare tunnel: cloudflared's loopback hop, with the edge's cf-connecting-ip and X-Forwarded-Proto: https, and an https
//   page on the host the visitor asked for. Only loopback is trusted for those headers (#581); a direct peer's copies mean nothing.
// - Explicit loopback development (PROFILES_DEV=1): page and socket both on loopback, with no forwarding headers at all.
// Anything else, including plain same-Wi-Fi ws:// and the production localhost link, stays guest-only.
export function profileGate(req, dev = false) {
  const h = req.headers;
  const origin = typeof h.origin === "string" ? URL.parse(h.origin) : null;
  const host = typeof h.host === "string" ? h.host.toLowerCase() : "";
  const peer = String(req.socket.remoteAddress ?? "").toLowerCase().replace(/^::ffff:/, "");
  const loop = LOOPBACK.has(peer);
  const cf = loop && typeof h["cf-connecting-ip"] === "string" && h["cf-connecting-ip"] !== "";
  const sameHttps = Boolean(origin) && origin.protocol === "https:" && origin.host === host;
  if (req.socket.encrypted) return sameHttps ? { credentials: true } : { credentials: false, reason: "origin" };
  if (cf && h["x-forwarded-proto"] === "https") return sameHttps ? { credentials: true } : { credentials: false, reason: "origin" };
  const forwarded = h["cf-connecting-ip"] !== undefined || h["x-forwarded-for"] !== undefined || h["x-forwarded-proto"] !== undefined;
  if (dev && loop && !forwarded && origin?.protocol === "http:" && LOOPBACK_NAMES.has(origin.hostname) && LOOPBACK_NAMES.has(hostnameOf(host))) {
    return { credentials: true };
  }
  return { credentials: false, reason: "https" };
}

// Sliding-window counts per normalized address (ipKey). Loopback without a tunnel header has no key, so no address bucket.
function windowed(limit, span) {
  const map = new Map();
  return (key, now) => {
    if (!key) return true;
    if (map.size > 4096) for (const [k, ts] of map) if (!ts.some((t) => now - t < span)) map.delete(k);
    const ts = (map.get(key) ?? []).filter((t) => now - t < span);
    if (ts.length >= limit) return (map.set(key, ts), false);
    ts.push(now);
    map.set(key, ts);
    return true;
  };
}

const reqId = (id) => (typeof id === "string" && id.length <= 64) || Number.isSafeInteger(id) ? id : null;

// Every reply is built here, field by field, from the store's owner view. Nothing is spread from a stored record.
function session(id, out, withCredential) {
  const p = out.profile;
  const msg = {
    type: "profileSession",
    id,
    profile: {
      profileId: p.profileId,
      displayName: p.displayName,
      login: p.login,
      color: p.color,
      backupColor: p.backupColor,
      catchphrase: p.catchphrase,
      winSongId: p.winSongId,
    },
    expiresAt: out.expiresAt,
  };
  if (withCredential) msg.credential = out.token;
  return msg;
}

export function profileHandler(store, send) {
  const authOk = windowed(AUTH_PER_MIN, MINUTE);
  const createOk = windowed(CREATE_PER_HOUR, HOUR);
  const refuse = (ws, id, code) => send(ws, { type: "profileError", id, code, message: MESSAGES[code] ?? MESSAGES.unavailable });

  async function run(ws, msg, id) {
    const now = Date.now();
    if (msg.type === "profileHello") {
      const available = store.ready && ws.profileGate.credentials;
      return send(ws, { type: "profileHello", id, caps: CAPS, available, reason: available ? null : store.ready ? ws.profileGate.reason : "unavailable" });
    }
    // Refused before the credential is looked at: the host never acts on a PIN or token that came the wrong way.
    if (!ws.profileGate.credentials) return refuse(ws, id, ws.profileGate.reason);
    if (!store.ready) return refuse(ws, id, "unavailable");
    if (!authOk(ws.ipKey, now)) return refuse(ws, id, "slowDown");
    if (msg.type === "profileCreate") {
      if (!createOk(ws.ipKey, now)) return refuse(ws, id, "slowDown");
      const out = await store.create({
        displayName: msg.displayName,
        login: msg.login,
        pin: msg.pin,
        pinConfirm: msg.pinConfirm,
        color: msg.color,
        backupColor: msg.backupColor,
        catchphrase: msg.catchphrase,
      });
      return send(ws, session(id, out, true));
    }
    if (msg.type === "profileLogin") return send(ws, session(id, await store.login(msg.login, msg.pin), true));
    if (msg.type === "profileResume") return send(ws, session(id, store.resume(msg.credential), false));
    if (msg.type === "profileLogout") {
      await store.logout(msg.credential);
      return send(ws, { type: "profileLoggedOut", id });
    }
  }

  // The host routes every PROFILE_TYPES frame here, after parsing and before any table branch.
  return function handleProfile(ws, msg) {
    const id = reqId(msg.id);
    if (ws.room || ws.watch) return refuse(ws, id, "tableSocket");
    // From the first profile frame this socket is a profile connection only; host.mjs refuses its table frames.
    ws.profileSocket = true;
    ws.profileBucket ??= { tokens: 10, at: Date.now() };
    clearTimeout(ws.profileIdle);
    ws.profileIdle = setTimeout(() => ws.close(1000, "idle"), IDLE_MS);
    ws.profileIdle.unref?.();
    if (!allow(ws.profileBucket, Date.now(), 10, 1)) return refuse(ws, id, "slowDown");
    run(ws, msg, id).catch((e) => {
      if (!(e instanceof ProfileError)) console.error("profile request failed:", e);
      refuse(ws, id, e instanceof ProfileError ? e.code : "unavailable");
    });
  };
}

// --- Seats and table cards (#764, docs/design/profiles.md "Protocol and seat recovery") -------------------------------------
// The table side of a profile: an optional `credential` on the initial host/join, the public projection of a bound seat, and
// `tableProfileCard` for a participant visible at the asking socket's own table. Rejoin never comes through here.
const SEAT_MESSAGES = {
  https: MESSAGES.https,
  origin: MESSAGES.origin,
  unavailable: MESSAGES.unavailable,
  slowDown: MESSAGES.slowDown,
  signedOut: "Signed out on this device. Sign in again, or join as a guest.",
  profileSeated: "That profile already has a seat at this table. Join as a guest, or leave the other seat.",
  watcher: "Watchers join as guests.",
  notAtTable: "Profile cards are for players at your table.",
  notFound: "No profile card for that player.",
};

// The profile a host/join may bind: null for a guest (no credential), { profileId } once the host has verified it, or a
// refusal { code, message }, which leaves the player where they were. `taken(id)` says whether that profile already holds
// a seat at the table, held or live. The transport is checked before the credential is looked at.
export function seatCredential(store, ws, msg, taken) {
  if (msg.credential === undefined || msg.credential === null) return null;
  const refuse = (code) => ({ code, message: SEAT_MESSAGES[code] ?? SEAT_MESSAGES.unavailable });
  if (!ws.profileGate?.credentials) return refuse(ws.profileGate?.reason ?? "https");
  if (!store.ready) return refuse("unavailable");
  const profileId = store.validate(msg.credential);
  if (!profileId) return refuse("signedOut");
  if (taken(profileId)) return refuse("profileSeated");
  return { profileId };
}

export function watchRefusal() {
  return { code: "watcher", message: SEAT_MESSAGES.watcher };
}

// The public `profile` field of one bound seat, built from the allowlist; the bare id when the store cannot read it.
export function seatProfile(store, profileId) {
  const p = store.profile(profileId);
  return p ? seatView(p) : { profileId };
}

// tableProfileCard {id, profileId}: `visible` is the profile ids of the asking socket's current table (its seats and the
// frozen roster of its game), or null when the socket is at no table; `allowed` is false when its request limit is spent.
// Any room or code in the request is ignored.
export function tableCard(store, send, ws, msg, visible, allowed) {
  const id = reqId(msg.id);
  const refuse = (code) => send(ws, { type: "profileError", id, code, message: SEAT_MESSAGES[code] });
  if (!allowed) return refuse("slowDown");
  if (!visible) return refuse("notAtTable");
  if (typeof msg.profileId !== "string" || !visible.has(msg.profileId)) return refuse("notFound");
  const p = store.profile(msg.profileId);
  if (!p) return refuse("notFound");
  send(ws, { type: "tableProfileCard", id, card: publicCard(p) });
}
