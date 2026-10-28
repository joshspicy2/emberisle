// Chat and reactions: the pure helpers, then sockets against a real host.mjs.
// Covers docs/design/chat.md "Test plan" items 1-8. Each socket group gets its own
// fresh table so one seat's rate bucket never bleeds into another test.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { allow, cleanText, loadEmotes, remember } from "./chat.mjs";

// 1. Unit tests -------------------------------------------------------------

assert.equal(cleanText("  hi\u0007 there \n"), "hi there");
assert.equal(cleanText("x".repeat(250)).length, 200);
const withEmoji = "x".repeat(199) + "🙂";
assert.equal(cleanText(withEmoji), withEmoji);
assert.equal(cleanText("a\u200bb\u202ec"), "abc");
assert.equal(cleanText("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"), "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}");
assert.equal(cleanText("\u200b\u200b"), null);
assert.equal(cleanText(""), null);
assert.equal(cleanText("   "), null);
assert.equal(cleanText(42), null);

// The host keeps 30 lines per room (host.mjs passes 30; the default matches it).
const kept = remember([], { n: 0 });
for (let i = 1; i < 60; i++) remember(kept, { n: i });
assert.equal(kept.length, 30, "remember defaults to a 30-line cap");
assert.equal(kept[0].n, 30);
assert.equal(kept[29].n, 59);
const keptExplicit = remember([], { n: 0 }, 30);
for (let i = 1; i < 45; i++) remember(keptExplicit, { n: i }, 30);
assert.equal(keptExplicit.length, 30, "an explicit 30-line cap holds");
assert.equal(keptExplicit[0].n, 15);
assert.equal(keptExplicit[29].n, 44);

{
  const bucket = { tokens: 5, at: 0 };
  for (let i = 0; i < 5; i++) assert.equal(allow(bucket, 0), true, `token ${i}`);
  assert.equal(allow(bucket, 0), false, "6th token");
  assert.equal(allow(bucket, 1000), true, "refilled after 1000ms");
}

const emoteDir = mkdtempSync(path.join(tmpdir(), "emotes-"));
mkdirSync(path.join(emoteDir, "sub")); // must not be picked up as an emote
writeFileSync(path.join(emoteDir, "ben-10.webp"), "x");
writeFileSync(path.join(emoteDir, "Not-Lower.png"), "x");
writeFileSync(path.join(emoteDir, "readme.txt"), "x");
assert.deepEqual(loadEmotes(emoteDir), new Set(["ben-10"]));
assert.deepEqual(loadEmotes(path.join(emoteDir, "missing")), new Set());
rmSync(emoteDir, { recursive: true, force: true });

const realEmotes = loadEmotes(new URL("../src/assets/emotes/", import.meta.url));
assert.ok(realEmotes.has("ben-10"), "real emote folder has ben-10");
assert.deepEqual(new Set([...realEmotes].filter((name) => name !== "ben-10")), new Set(["daffy-shock", "goggles-guy", "leo-laugh", "memoji-scheme", "mike-sully", "old-grump", "shrek-smirk", "sponge-thumbs", "wide-eyes", "monkey-pet", "side-eye", "banana-guy", "glasses-glance", "dark-smile"]));

console.log("unit checks ok");

// 2. Socket tests against a real host ---------------------------------------

// Rooms go to a temp folder, dropped on exit, so the real host never restores this proof's tables (#207).
const ROOMS_DIR = mkdtempSync(path.join(tmpdir(), "emberisle-rooms-"));
process.on("exit", () => rmSync(ROOMS_DIR, { recursive: true, force: true }));
const host = spawn(process.execPath, ["--import", "./register.mjs", "host.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: { ...process.env, PORT: "0", ROOMS_DIR },
});
process.on("exit", () => host.kill("SIGKILL"));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(130));
const port = await new Promise((resolve, reject) => {
  host.stdout.on("data", (d) => {
    const m = String(d).match(/listening (\d+)/);
    if (m) resolve(Number(m[1]));
  });
  host.on("exit", (c) => reject(new Error(`host exited ${c}`)));
});

function fail(why, extra) {
  console.log("FAIL", why, extra ?? "");
  host.kill("SIGKILL");
  process.exit(1);
}

function client(name, color) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const c = { name, color, ws, inbox: [], waiters: [] };
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    c.inbox.push(msg);
    for (const w of c.waiters.splice(0)) w();
  });
  c.send = (msg) => ws.send(JSON.stringify(msg));
  // Waits for the next message matching one of `types`, leaving no dangling waiter behind
  // (racing two independent next() calls would leave the loser polling forever).
  c.nextOf = async (types) => {
    for (;;) {
      const i = c.inbox.findIndex((m) => types.includes(m.type));
      if (i >= 0) return c.inbox.splice(i, 1)[0];
      await new Promise((res, rej) => {
        c.waiters.push(res);
        setTimeout(() => rej(new Error(`${name} waited for ${types.join("/")}`)), 3000);
      }).catch((e) => fail(e.message));
    }
  };
  c.next = (type) => c.nextOf([type]);
  c.quiet = async (type, ms) => {
    await new Promise((r) => setTimeout(r, ms));
    if (c.inbox.some((m) => m.type === type)) fail(`${name} unexpectedly got ${type}`);
  };
  c.open = new Promise((res) => ws.on("open", res));
  return c;
}

// A fresh table with `n` seated players, past the initial "seats" broadcast.
async function freshTable(names) {
  const clients = names.map((n, i) => client(n, ["#e23d2e", "#2d6ee8", "#8a4fd3", "#f3ecd9"][i]));
  await Promise.all(clients.map((c) => c.open));
  clients[0].send({ type: "hello", name: clients[0].name, color: clients[0].color });
  const welcome = await clients[0].next("welcome");
  for (const c of clients.slice(1)) {
    c.send({ type: "hello", code: welcome.code, name: c.name, color: c.color });
    await c.next("welcome");
  }
  for (const c of clients) await c.next("seats");
  return { clients, code: welcome.code, firstWelcome: welcome };
}

// Item 2: the host fills in the sender, ignoring a spoofed name/from/color.
{
  const { clients } = await freshTable(["Ember", "Tide", "Pine"]);
  const [ember, tide, pine] = clients;
  ember.send({ type: "chat", text: "hello", name: "Mallory", from: "s9", color: "#000" });
  const [onEmber, onTide, onPine] = await Promise.all([ember.next("chat"), tide.next("chat"), pine.next("chat")]);
  for (const line of [onEmber, onTide, onPine]) {
    assert.equal(line.seat, "s0");
    assert.equal(line.player, null);
    assert.equal(line.name, "Ember");
    assert.equal(line.color, "#e23d2e");
    assert.equal(line.text, "hello");
  }
  console.log("lobby chat: host fills in the sender");

  // Item 3: an empty chat and an unknown emote reach nobody.
  ember.send({ type: "chat", text: "   " });
  ember.send({ type: "react", emote: "nope" });
  await Promise.all([tide.quiet("chat", 300), pine.quiet("react", 300)]);
  console.log("empty chat and unknown emote are dropped silently");
}

// Item 4: rate limit is per seat, shared by chat and react, and does not affect others.
{
  const { clients } = await freshTable(["Ember", "Tide", "Pine"]);
  const [ember, tide, pine] = clients;
  for (let i = 0; i < 6; i++) ember.send({ type: "chat", text: `msg${i}` });
  let echoes = 0;
  let errors = 0;
  for (let i = 0; i < 6; i++) {
    const m = await ember.nextOf(["chat", "error"]);
    if (m.type === "chat") echoes++;
    else {
      errors++;
      assert.equal(m.message, "Slow down.");
    }
  }
  assert.equal(echoes, 5, "Ember gets 5 echoes");
  assert.equal(errors, 1, "Ember gets one error");
  let tideLines = 0;
  for (let i = 0; i < 5; i++) if ((await tide.next("chat")).text.startsWith("msg")) tideLines++;
  assert.equal(tideLines, 5, "Tide gets 5 lines, no error");
  await pine.quiet("error", 100);
  console.log("rate limit: 5 through, the 6th slowed down, other seats unaffected");
}

// Item 5: reactions, aimed and not.
{
  const { clients } = await freshTable(["Ember", "Tide", "Pine"]);
  const [ember, tide, pine] = clients;
  ember.send({ type: "react", emote: "ben-10", to: "s1" });
  const [rE, rT, rP] = await Promise.all([ember.next("react"), tide.next("react"), pine.next("react")]);
  for (const r of [rE, rT, rP]) {
    assert.equal(r.emote, "ben-10");
    assert.equal(r.to, "s1");
  }
  ember.send({ type: "react", emote: "ben-10", to: "zz" });
  const bad = await tide.next("react");
  assert.equal(bad.to, null, "an unknown seat/player id in to becomes null");
  console.log("reactions: aimed and unaimed");
}

// Item 6: a late joiner's welcome carries the room's earlier lines, in order.
{
  const { clients, code } = await freshTable(["Ember", "Tide"]);
  const [ember, tide] = clients;
  ember.send({ type: "chat", text: "first" });
  await Promise.all([ember.next("chat"), tide.next("chat")]);
  ember.send({ type: "chat", text: "second" });
  await Promise.all([ember.next("chat"), tide.next("chat")]);
  const late = client("Late", "#f3ecd9");
  await late.open;
  late.send({ type: "hello", code, name: "Late", color: late.color });
  const lateWelcome = await late.next("welcome");
  assert.deepEqual(
    lateWelcome.chat.map((l) => l.text),
    ["first", "second"],
    "a late joiner's welcome.chat holds the earlier lines in order",
  );
  console.log("late joiner gets the chat history");
}

// Item 7: after start, a chat line carries `player`, the seat's game-player id.
{
  const { clients } = await freshTable(["Ember", "Tide", "Pine"]);
  const [ember, tide, pine] = clients;
  for (const c of clients) c.send({ type: "ready", value: true });
  while (!(await ember.next("seats")).seats.every((s) => s.ready));
  ember.send({ type: "start" });
  await Promise.all(clients.map((c) => c.next("state")));
  ember.send({ type: "chat", text: "after start" });
  const [afterStart] = await Promise.all([ember.next("chat"), tide.next("chat"), pine.next("chat")]);
  assert.ok(afterStart.player, "chat after start carries a player id");
  console.log("chat after start carries the seat's player id:", afterStart.player);
}

// Item 8: an over-limit frame closes only that socket; the rest still chat.
{
  const { clients } = await freshTable(["Ember", "Tide"]);
  const [ember, tide] = clients;
  const big = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((res) => big.on("open", res));
  const closed = new Promise((res) => big.on("close", res));
  big.send("x".repeat(20 * 1024));
  const bigCode = await closed;
  assert.equal(bigCode, 1009, "an over-limit frame gets ws close code 1009");
  ember.send({ type: "chat", text: "still here" });
  await tide.next("chat");
  console.log("an over-limit frame closes only that socket; the table carries on");
}

host.kill("SIGKILL");
console.log("chat prove ok");
process.exit(0);
