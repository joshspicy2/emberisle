// Pure chat/reaction validation, kept out of host.mjs so chat-prove.mjs can test it with no socket.
// Design: docs/design/chat.md "Validation".
import { readdirSync } from "node:fs";

// Keep U+200D: it joins emoji such as family and flag sequences.
const CONTROL = /(?!\u200D)[\p{Cc}\p{Cf}]/gu;
const SPACES = / {2,}/g;
const EMOTE_FILE = /^([a-z0-9-]+)\.(png|webp)$/;

// The soundboard clips a seat may trigger (src/lib/sound.ts SOUNDBOARD). The client holds the files; the host only relays a known id.
export const SOUNDBOARD = new Map([
  ["robbed_fah", "Fah"],
  ["sb_wololo", "Wololo"],
  ["sb_win_reaction", "GG!"],
  ["sb_airhorn", "Airhorn"],
  ["sb_quit_touchin", "Quit touchin' me"],
  ["sb_only_wood", "Wood please"],
  ["sb_plump_sheep", "Plump sheep"],
  ["sb_nice_sheep", "Nice sheep"],
  ["sb_sheep_please", "Sheep please"],
  ["sb_grain_please", "Grain please"],
  ["sb_brick_please", "Brick please"],
  ["sb_perfect", "Perfect"],
  ["sb_real_badman", "Real badman"],
  ["sb_gong", "Gong"],
  ["bong", "Bong"],
]);

export function cleanText(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL, "").replace(SPACES, " ").trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, 200).join("");
}

// A token bucket. By default the shared 5-per-5s one for chat and reactions, refilled at 1 token/second;
// the host passes a larger cap and rate for a seat's non-chat messages.
export function allow(bucket, now, cap = 5, rate = 1) {
  const elapsed = Math.max(0, now - bucket.at);
  bucket.tokens = Math.min(cap, bucket.tokens + (elapsed / 1000) * rate);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

export function remember(list, line, limit = 30) {
  list.push(line);
  if (list.length > limit) list.splice(0, list.length - limit);
  return list;
}

export function loadEmotes(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    console.warn(`chat: no emote folder at ${dir}`);
    return new Set();
  }
  const ids = new Set();
  for (const name of names) {
    const m = EMOTE_FILE.exec(name);
    if (m) ids.add(m[1]);
  }
  return ids;
}
