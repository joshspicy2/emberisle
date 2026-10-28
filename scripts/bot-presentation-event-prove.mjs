// #720 (child of #608): presentation-only bot events, read at committed updates.
//   Practice: the real store (runBots -> dispatch, openOffer, respond) emits one event per successful action, with the
//   exact action and controller; refused and no-op actions emit nothing; a two-path fortune keeps its placement order.
//   Privacy: a bought fortune's kind, discarded goods and a stolen good never enter an event.
//   Online: the commit observer is silent on a baseline (join, reconnect, rematch), ignores duplicate and stale pushes
//   and repeated or truncated logs, dedupes trade messages by real trade id, and never invents an order or a
//   controller from a batched snapshot. The online information gap (two legal path orders, identical pushes) holds.
//   No observer changes the game: the store's state is the same with a throwing listener as with none.
import assert from "node:assert/strict";
import { createGame } from "../src/lib/game/board.ts";
import { chooseBotAction, chooseTradeAsk } from "../src/lib/game/ai.ts";
import { applyAction, legalRoads, stealTargets } from "../src/lib/game/rules.ts";
import { RESOURCES } from "../src/lib/game/types.ts";
import { createPresentationFeed } from "../src/lib/game/bot-presentation.ts";
import { projectAction } from "../src/lib/game/bot-projection.ts";
import { committedChanges, createCommitObserver } from "../src/lib/net/commit-observer.ts";
import { presentation, useGame } from "../src/lib/game/store.ts";

const PRIVATE = /\b(timber|clay|wool|grain|ore|wood|brick|sheep|wheat|stone|knight|road|plenty|monopoly|vp)\b/i;
const EMPTY = { timber: 0, clay: 0, wool: 0, grain: 0, ore: 0 };
const NO_CARDS = { knight: 0, road: 0, plenty: 0, monopoly: 0, vp: 0 };

// A practice table past setup: p0 is the person, p1..p3 are bots.
function setup(seed) {
  let game = createGame({ humans: [{ name: "Ember" }], bots: 3, seed });
  game.phase = "setupSettle";
  game.rollOff = null;
  while (game.phase === "setupSettle" || game.phase === "setupRoad") {
    const next = applyAction(game, game.current, chooseBotAction(game, game.current));
    assert.ifError(next.error);
    game = next.state;
  }
  game.players.sort((a, b) => a.id.localeCompare(b.id));
  game.phase = "main";
  game.playedCard = false;
  for (const p of game.players) {
    p.resources = { ...EMPTY };
    p.hidden = { ...NO_CARDS };
    p.boughtThisTurn = { ...NO_CARDS };
  }
  return game;
}
function balance(game) {
  for (const r of RESOURCES) game.bank[r] = 19 - game.players.reduce((n, p) => n + p.resources[r], 0);
}

const seen = [];
presentation.subscribe((e) => seen.push(e));
function practice(game, current) {
  useGame.getState().goTitle();
  useGame.getState().startAi();
  game.current = current;
  useGame.setState({ state: game, mode: "ai", localId: "p0", gameLog: [] });
  seen.length = 0;
}
const bot = (game, id) => game.players.find((p) => p.id === id);

// 1. Refused and no-op actions emit nothing.
{
  const game = setup(4);
  practice(game, "p0");
  const taken = game.edges.find((e) => e.path).id;
  bot(useGame.getState().state, "p0").resources = { ...EMPTY, timber: 1, clay: 1 };
  assert.equal(useGame.getState().dispatch({ type: "buildPath", edgeId: taken }).ok, false);
  assert.equal(useGame.getState().dispatch({ type: "buildOutpost", vertexId: game.vertices[0].id }).ok, false);
  assert.equal(useGame.getState().dispatch({ type: "buyCard" }, "p2").ok, false, "not p2's turn");
  await presentation.flush();
  assert.equal(seen.length, 0, "refused actions emit nothing");
  assert.equal(useGame.getState().dispatch({ type: "endTurn" }).ok, true);
  await presentation.flush();
  assert.equal(seen.length, 0, "a pass emits nothing");
  const s = useGame.getState().state;
  assert.equal(projectAction(s, s, "p1", { type: "buyCard" }), null, "an unchanged state reads as refused");
  console.log("PASS: refused actions and no-op actions (pass, unchanged state) emit no event");
}

// 2. Automation versus a person, through the real store.
{
  const game = setup(4);
  bot(game, "p0").resources = { ...EMPTY, timber: 1, clay: 1 };
  balance(game);
  practice(game, "p0");
  const edge = legalRoads(game, "p0", false)[0];
  assert.equal(useGame.getState().dispatch({ type: "buildPath", edgeId: edge }).ok, true);
  await presentation.flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].controller, "human");
  assert.deepEqual([seen[0].kind, seen[0].actor, seen[0].edges, seen[0].via], ["path", "p0", [edge], "build"]);

  const g2 = setup(4);
  bot(g2, "p1").resources = { ...EMPTY, timber: 1, clay: 1 };
  balance(g2);
  practice(g2, "p1");
  const chosen = chooseBotAction(g2, "p1");
  assert.equal(chosen.type, "buildPath");
  useGame.getState().runBots();
  await presentation.flush();
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].kind, seen[0].actor, seen[0].controller, seen[0].edges, seen[0].ordered, seen[0].source], ["path", "p1", "bot", [chosen.edgeId], true, "practice"]);
  assert.match(seen[0].id, /^\d+\.1$/);
  console.log("PASS: a person's build is controller human, runBots' build is controller bot, both with the exact edge");
}

// 3. A two-path fortune keeps its placement order in practice; online both orders give identical pushes and events.
{
  let fixture = null;
  for (let seed = 1; seed < 60 && !fixture; seed++) {
    const game = setup(seed);
    game.current = "p1";
    bot(game, "p1").hidden.road = 1;
    balance(game);
    const roads = legalRoads(game, "p1", false);
    if (roads.length < 2) continue;
    const a = roads[0], b = roads[1];
    const ab = applyAction(game, "p1", { type: "playRoad", edgeIds: [a, b] });
    const ba = applyAction(game, "p1", { type: "playRoad", edgeIds: [b, a] });
    if (ab.error || ba.error) continue;
    fixture = { game, a, b, ab: ab.state, ba: ba.state };
  }
  assert(fixture, "fixture with two independently legal path-fortune edges");
  const { game, a, b, ab, ba } = fixture;
  assert.equal(JSON.stringify(ab), JSON.stringify(ba), "both orders commit byte-identical state and log");
  const pa = projectAction(game, ab, "p1", { type: "playRoad", edgeIds: [a, b] });
  const pb = projectAction(game, ba, "p1", { type: "playRoad", edgeIds: [b, a] });
  assert.deepEqual(pa.edges, [a, b]);
  assert.deepEqual(pb.edges, [b, a]);
  const online = (after) => {
    const feed = createPresentationFeed();
    const out = [];
    feed.subscribe((e) => out.push(e));
    const obs = createCommitObserver(feed);
    obs.state(structuredClone(game), true);
    obs.state(structuredClone(after));
    return out;
  };
  const oa = online(ab), ob = online(ba);
  assert.equal(JSON.stringify(oa), JSON.stringify(ob), "the observer cannot and does not tell the orders apart");
  assert.equal(oa.length, 1);
  assert.equal(oa[0].kind, "summary");
  assert.equal(oa[0].ordered, false);
  assert.deepEqual(oa[0].changes, [{ kind: "path", id: [a, b].sort()[0] }, { kind: "path", id: [a, b].sort()[1] }]);
  console.log(`PASS: information gap: ${JSON.stringify([a, b])} and ${JSON.stringify([b, a])} commit identical state and log; practice first targets differ; online one unordered summary for both`);

  // The real store: runBots plays the fortune and the event carries the bot's own order.
  const g = setup(7);
  g.current = "p2";
  bot(g, "p2").hidden.road = 1;
  balance(g);
  const chosen = chooseBotAction(g, "p2");
  assert.equal(chosen.type, "playRoad");
  assert.equal(chosen.edgeIds.length, 2);
  practice(g, "p2");
  useGame.getState().runBots();
  await presentation.flush();
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].kind, seen[0].via, seen[0].edges, seen[0].ordered, seen[0].controller], ["path", "fortune", chosen.edgeIds, true, "bot"]);
  console.log("PASS: runBots' two-path fortune is one ordered event with both edges in the bot's order");
}

// 4. Private-data projection: bought fortune kind, discarded goods and the stolen good stay out.
{
  const game = setup(5);
  game.current = "p1";
  bot(game, "p1").resources = { ...EMPTY, wool: 1, grain: 1, ore: 1 };
  balance(game);
  const top = game.deck[0];
  practice(game, "p1");
  assert.equal(chooseBotAction(game, "p1").type, "buyCard");
  useGame.getState().runBots();
  await presentation.flush();
  assert.equal(bot(useGame.getState().state, "p1").hidden[top], 1, "the bot really drew the top card");
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ["actor", "controller", "epoch", "id", "kind", "ordered", "seq", "source"]);
  assert.equal(seen[0].kind, "fortuneBuy");
  assert.doesNotMatch(JSON.stringify(seen[0]), PRIVATE);

  const d = setup(5);
  d.current = "p0";
  d.phase = "discard";
  bot(d, "p2").resources = { ...EMPTY, timber: 5, wool: 3 };
  d.discardNeeded = { p2: 4 };
  balance(d);
  practice(d, "p0");
  useGame.getState().runBots();
  await presentation.flush();
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].kind, seen[0].actor, seen[0].count], ["discard", "p2", 4]);
  assert.doesNotMatch(JSON.stringify(seen[0]), PRIVATE);

  let r = null;
  for (let seed = 1; seed < 60 && !r; seed++) {
    const g = setup(seed);
    g.current = "p1";
    g.phase = "robber";
    for (const p of g.players) if (p.id !== "p1") p.resources = { ...EMPTY, ore: 2 };
    balance(g);
    const a = chooseBotAction(g, "p1");
    if (a.type === "moveRobber" && a.stealFrom && stealTargets(g, a.hexId, "p1").includes(a.stealFrom)) r = { g, a };
  }
  assert(r, "fixture where the bot steals");
  practice(r.g, "p1");
  useGame.getState().runBots();
  await presentation.flush();
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].kind, seen[0].hex, seen[0].victim, seen[0].via], ["wayfarer", r.a.hexId, r.a.stealFrom, "move"]);
  assert.doesNotMatch(JSON.stringify(seen[0]), PRIVATE);
  assert.equal(bot(useGame.getState().state, "p1").resources.ore, 1, "the steal really took a good");
  console.log("PASS: fortune buy, discard and steal events carry no fortune kind, discarded goods or stolen good");
}

// 5. Offer callbacks: a bot's ask and a person's ask, each once by real trade id, and the taken trade once.
{
  const HANDS = { p0: { grain: 1, clay: 1 }, p1: { clay: 1 }, p2: { grain: 2, ore: 2, wool: 2 }, p3: { timber: 1 } };
  const game = setup(11);
  for (const p of game.players) p.resources = { ...EMPTY, ...HANDS[p.id] };
  balance(game);
  game.current = "p2";
  const ask = chooseTradeAsk(game, "p2");
  assert(ask, "p2 asks the table");
  practice(game, "p2");
  useGame.getState().runBots();
  await presentation.flush();
  const tradeId = useGame.getState().offer?.tradeId;
  assert(tradeId);
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].kind, seen[0].tradeId, seen[0].actor, seen[0].controller, seen[0].give, seen[0].want], ["offer", tradeId, "p2", "bot", ask.give, ask.want]);
  useGame.getState().runBots();
  await presentation.flush(); // the bot's turn waits on its open ask: no second offer
  assert.equal(seen.length, 1);
  useGame.getState().answerTrade(true);
  await presentation.flush();
  assert.equal(seen.length, 2);
  assert.deepEqual([seen[1].kind, seen[1].tradeId, seen[1].actor, seen[1].taker], ["trade", tradeId, "p2", "p0"]);

  const h = setup(11);
  for (const p of h.players) p.resources = { ...EMPTY, ...HANDS[p.id] };
  balance(h);
  practice(h, "p0");
  useGame.getState().askTable({ grain: 1 }, { wool: 1 });
  await presentation.flush();
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].kind, seen[0].actor, seen[0].controller], ["offer", "p0", "human"]);
  useGame.getState().goTitle(); // clears the practice offer timers
  console.log("PASS: practice offers emit once per trade id with their controller; a taken trade emits once");
}

// 6. Online: baselines, duplicates, stale pushes, repeated/truncated logs, reconnect, rematch, trade duplicates.
{
  const feed = createPresentationFeed();
  const out = [];
  feed.subscribe((e) => out.push(e));
  const obs = createCommitObserver(feed);
  const base = setup(9);
  base.current = "p1";
  bot(base, "p1").resources = { ...EMPTY, timber: 6, clay: 6 };
  bot(base, "p0").resources = { ...EMPTY, timber: 3, clay: 3 };
  balance(base);
  const step = (s, actor, action) => {
    const r = applyAction(s, actor, action);
    assert.ifError(r.error);
    return r.state;
  };
  const push = (s, baseline = false) => {
    const before = JSON.stringify(s);
    const r = obs.state(structuredClone(s), baseline);
    assert.equal(JSON.stringify(s), before, "the observer never touches a push");
    return r;
  };
  assert.equal(push(base, true).length, 0, "join baseline is silent");
  assert.equal(push(base).length, 0, "duplicate snapshot");
  const s1 = step(base, "p1", { type: "buildPath", edgeId: legalRoads(base, "p1", false)[0] });
  const e1 = push(s1);
  assert.equal(e1.length, 1);
  assert.deepEqual([e1[0].kind, e1[0].actor, e1[0].controller, e1[0].ordered], ["path", "p1", "bot", true]);
  assert.equal(push(s1).length, 0, "duplicate snapshot");
  assert.equal(push(base).length, 0, "stale snapshot");
  assert.equal(push({ ...s1, log: [...s1.log, ...s1.log] }).length, 0, "repeated log, same seq");
  assert.equal(push({ ...s1, seq: s1.seq + 1, log: [...s1.log, ...s1.log.slice(-3)] }).length, 0, "repeated log lines, no change");
  const s1b = { ...s1, seq: s1.seq + 1 };
  const s2 = step(s1b, "p1", { type: "buildPath", edgeId: legalRoads(s1b, "p1", false)[0] });
  const e2 = push({ ...s2, log: s2.log.slice(-1) });
  assert.equal(e2.length, 1, "a truncated log does not hide or double the change");
  assert.deepEqual(e2[0].edges, [s2.edges.find((e) => e.path === "p1" && !s1.edges.find((x) => x.id === e.id).path).id]);
  // Another seat's hidden hand changing is not a public change.
  const hidden = structuredClone(s2);
  hidden.seq += 1;
  bot(hidden, "p3").resources.ore += 2;
  assert.equal(push(hidden).length, 0, "a hand change is never read");
  // A person's seat online is not attributed to a person: the host may be covering it.
  const h1 = structuredClone(hidden);
  h1.current = "p0";
  const h2 = step(h1, "p0", { type: "buildPath", edgeId: legalRoads(h1, "p0", false)[0] });
  const eh = push(h2);
  assert.deepEqual([eh[0].actor, eh[0].controller], ["p0", "unknown"]);
  // Two changes in one push: one unordered summary, never two events in a guessed order.
  const b0 = structuredClone(h2);
  b0.current = "p1";
  const b1 = step(b0, "p1", { type: "buildPath", edgeId: legalRoads(b0, "p1", false)[0] });
  const b2 = step(b1, "p1", { type: "buildPath", edgeId: legalRoads(b1, "p1", false)[0] });
  const eb = push(b2);
  assert.equal(eb.length, 1);
  assert.deepEqual([eb[0].kind, eb[0].ordered, eb[0].changes.length], ["summary", false, 2]);
  // A wayfarer move across a turn change is not tied to a seat.
  const w = structuredClone(b2);
  w.seq += 1;
  w.current = "p2";
  w.robberHex = w.hexes.find((x) => x.id !== b2.robberHex).id;
  const ew = push(w);
  assert.deepEqual([ew[0].kind, ew[0].actor, ew[0].victim], ["wayfarer", null, null]);
  // A fortune buy is shown by count only, even for this tab's own fully known hand.
  const f = structuredClone(w);
  f.seq += 1;
  bot(f, "p2").hidden.monopoly += 1;
  const ef = push(f);
  assert.equal(ef[0].kind, "fortuneBuy");
  assert.doesNotMatch(JSON.stringify(ef), PRIVATE);
  // Reconnect: what changed while away is a silent baseline in the same epoch; the next change speaks.
  const epoch = feed.epoch;
  const away = step({ ...f, current: "p1" }, "p1", { type: "buildPath", edgeId: legalRoads({ ...f, current: "p1" }, "p1", false)[0] });
  assert.equal(push(away, true).length, 0, "reconnect baseline is silent");
  assert.equal(feed.epoch, epoch);
  const back = step(away, "p1", { type: "endTurn" });
  assert.equal(push(back).length, 0, "a pass changes no piece");
  // Trade messages: one offer event and one trade event per real trade id.
  assert(obs.offer({ tradeId: "t40-1", from: "p1", give: { clay: 1 }, want: { ore: 1 } }));
  assert.equal(obs.offer({ tradeId: "t40-1", from: "p1", give: { clay: 1 }, want: { ore: 1 } }), null, "duplicate tradeOffer");
  assert.equal(obs.closed({ tradeId: "t40-1" }), null, "nobody took it");
  assert.equal(obs.closed({ tradeId: "t99-9", taker: "p0" }), null, "a close for an unseen offer");
  assert.equal(obs.closed({ tradeId: "t40-1", taker: "p0" }).kind, "trade");
  assert.equal(obs.closed({ tradeId: "t40-1", taker: "p0" }), null, "duplicate tradeClosed");
  // Rematch: a new game is a silent baseline in a new epoch, and ids restart.
  const over = structuredClone(back);
  over.seq += 1;
  over.phase = "over";
  push(over);
  const again = createGame({ humans: [{ name: "Ember" }], bots: 3, seed: back.seed });
  assert.equal(push(again).length, 0, "rematch baseline (same seed, over to new game) is silent");
  assert.equal(feed.epoch, epoch + 1);
  assert(obs.offer({ tradeId: "t40-1", from: "p1", give: { clay: 1 }, want: { ore: 1 } }), "a new epoch forgets the old trade ids");
  const other = createGame({ humans: [{ name: "Ember" }], bots: 3, seed: back.seed + 1 });
  assert.equal(push(other).length, 0, "a different game is a silent baseline");
  assert.equal(feed.epoch, epoch + 2);
  const o1 = setup(back.seed + 1);
  o1.seed = other.seed;
  o1.seq = other.seq + 1;
  o1.current = "p1";
  bot(o1, "p1").resources = { ...EMPTY, timber: 1, clay: 1 };
  assert.equal(committedChanges(other, o1).length > 0, true);
  const fresh = push(o1);
  assert(fresh.length >= 1);
  assert.equal(fresh[0].id, `${epoch + 2}.1`, "ids restart in the new epoch");
  assert(out.every((e) => Object.isFrozen(e)));
  assert.throws(() => { out[0].actor = "p3"; }, TypeError);
  console.log("PASS: online baselines, duplicate/stale pushes, repeated/truncated logs, reconnect, rematch and trade duplicates");
}

// 7. No observer changes or delays the game: the commit is in the store before any event, and the same runBots step
// with a throwing listener leaves exactly what it leaves with none. A capture queued before a reset is dropped.
{
  const run = async (listen) => {
    const game = setup(4);
    bot(game, "p1").resources = { ...EMPTY, timber: 1, clay: 1 };
    balance(game);
    practice(game, "p1");
    const atEvent = [];
    const off = presentation.subscribe(() => {
      atEvent.push(useGame.getState().state.seq);
      if (listen) throw new Error("listener");
    });
    const before = game.seq;
    useGame.getState().runBots();
    assert.equal(useGame.getState().state.seq, before + 1, "the commit lands synchronously");
    assert.equal(seen.length, 0, "no event before the commit is set");
    await presentation.flush();
    off();
    assert.deepEqual(atEvent, [before + 1], "the event reads an already committed state");
    const s = useGame.getState();
    return JSON.stringify({ state: s.state, log: s.gameLog.map((l) => l.text), offer: s.offer, error: s.error });
  };
  assert.equal(await run(true), await run(false));

  const game = setup(4);
  bot(game, "p1").resources = { ...EMPTY, timber: 1, clay: 1 };
  balance(game);
  practice(game, "p1");
  useGame.getState().runBots();
  useGame.getState().goTitle(); // a new epoch before the queued capture is projected
  await presentation.flush();
  assert.equal(seen.length, 0, "a capture from a reset epoch is dropped");
  console.log("PASS: events follow the commit, a throwing listener changes nothing, and a reset drops queued captures");
}
console.log("bot presentation event prove ok");
