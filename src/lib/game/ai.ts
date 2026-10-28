import { COST, RESOURCES, type Action, type GameState, type PlayerState, type Resource, type TradeOffer } from "./types";
import { harborRate, legalCities, legalRoads, legalSettle, playable, publicVP, stealTargets, wayfarerMode } from "./rules";

function cards(p: { resources: Record<Resource, number> }) {
  return RESOURCES.reduce((n, r) => n + p.resources[r], 0);
}

function hasCost(p: { resources: Record<Resource, number> }, cost: Partial<Record<Resource, number>>) {
  return RESOURCES.every((r) => p.resources[r] >= (cost[r] ?? 0));
}

function pipScore(state: GameState, vid: string) {
  const v = state.vertices.find((x) => x.id === vid);
  if (!v) return -1;
  let s = 0;
  for (const hid of v.hexes) {
    const h = state.hexes.find((x) => x.id === hid);
    if (!h || h.pip == null) continue;
    const w = 6 - Math.abs(h.pip - 7);
    s += w * w;
  }
  return s;
}

function discardHalf(p: { resources: Record<Resource, number> }, n: number): Partial<Record<Resource, number>> {
  const pool = { ...p.resources };
  const out: Partial<Record<Resource, number>> = {};
  for (let i = 0; i < n; i++) {
    const r = RESOURCES.slice().sort((a, b) => pool[b] - pool[a])[0]!;
    if (pool[r] <= 0) break;
    pool[r] -= 1;
    out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}

// The target showing the most points, then the fullest hand (#362). Public information only:
// `stealTargets` already drops empty hands, and the card count arrives as `goods` online.
function bestVictim(state: GameState, targets: string[]): string | null {
  let best: { id: string; vp: number; cards: number } | null = null;
  for (const id of targets) {
    const p = state.players.find((x) => x.id === id);
    if (!p) continue;
    const vp = publicVP(state, id);
    const n = p.goods ?? cards(p);
    if (!best || vp > best.vp || (vp === best.vp && n > best.cards)) best = { id, vp, cards: n };
  }
  return best?.id ?? null;
}

// Block the opponent showing the most points (#362): their buildings weigh on top of the token,
// and a hex the bot itself farms is never chosen while some other hex blocks an opponent.
function bestRobberHex(state: GameState, pid: string): { hexId: string; stealFrom: string | null } {
  const opps = state.players.filter((p) => p.id !== pid);
  const leaderVP = Math.max(0, ...opps.map((p) => publicVP(state, p.id)));
  const leaders = new Set(opps.filter((p) => publicVP(state, p.id) === leaderVP).map((p) => p.id));
  const legal = state.hexes.filter((h) => h.id !== state.robberHex && h.terrain !== "waste");
  const owned = (hid: string) => state.vertices.some((v) => v.hexes.includes(hid) && v.building?.playerId === pid);
  const blocks = (hid: string) =>
    state.vertices.some((v) => v.hexes.includes(hid) && v.building && v.building.playerId !== pid);
  const pool = legal.some((h) => !owned(h.id) && blocks(h.id)) ? legal.filter((h) => !owned(h.id)) : legal;
  let best = { hexId: pool[0]!.id, stealFrom: null as string | null, score: -1 };
  for (const h of pool) {
    const targets = stealTargets(state, h.id, pid);
    let score = h.pip ? 6 - Math.abs(h.pip - 7) : 0;
    if (targets.length) score += 8;
    if (blocks(h.id)) score += 4;
    for (const v of state.vertices) {
      if (!v.hexes.includes(h.id) || !v.building || !leaders.has(v.building.playerId)) continue;
      score += v.building.kind === "stronghold" ? 6 : 3;
    }
    if (owned(h.id)) score -= 6;
    if (score > best.score) {
      best = { hexId: h.id, stealFrom: bestVictim(state, targets), score };
    }
  }
  return best;
}

// The state with one more of the bot's paths on `eid`, for asking the rules what that opens up.
function withPath(state: GameState, pid: string, eid: string): GameState {
  return { ...state, edges: state.edges.map((e) => (e.id === eid ? { ...e, path: pid } : e)) };
}

// The edge among `roads` that opens the most outpost corners, then the most pips at its far end.
function bestRoad(state: GameState, pid: string, roads: string[]): string {
  let best = { eid: roads[0]!, score: -1 };
  for (const eid of roads) {
    const next = withPath(state, pid, eid);
    const corners = legalSettle(next, pid, false);
    const e = state.edges.find((x) => x.id === eid)!;
    const score = corners.length * 1000 + Math.max(pipScore(state, e.va), pipScore(state, e.vb));
    if (score > best.score) best = { eid, score };
  }
  return best.eid;
}

type Cost = Partial<Record<Resource, number>>;
type Hand = Record<Resource, number>;

// The next buy the bot is saving for (#233, #361).
function goalOf(state: GameState, me: PlayerState, cities: string[], settles: string[], roads: string[]): Cost | null {
  if (cities.length && me.strongholdsLeft > 0) return COST.stronghold;
  if (settles.length && me.outpostsLeft > 0) return COST.outpost;
  if (roads.length && me.pathsLeft > 0 && me.outpostsLeft > 0) return COST.path;
  return state.deck.length > 0 ? COST.card : null;
}

// One entry per card `hand` still lacks for `goal`.
function shortOf(hand: Hand, goal: Cost | null): Resource[] {
  const short: Resource[] = [];
  if (goal) for (const r of RESOURCES) for (let n = hand[r]; n < (goal[r] ?? 0); n++) short.push(r);
  return short;
}

function goalFor(state: GameState, me: PlayerState) {
  return goalOf(state, me, legalCities(state, me.id), legalSettle(state, me.id, false), legalRoads(state, me.id, false));
}

function size(bag: Cost) {
  return RESOURCES.reduce((n, r) => n + (bag[r] ?? 0), 0);
}

// A table ask (#363) as its asker sent it: the asker gives `give` and wants `want`.
export type TradeAsk = Pick<TradeOffer, "from" | "give" | "want">;

// Whether a bot says Yes to an ask (#363). It reads only its own hand and what every seat sees:
// it can pay, it gets at least as many cards as it gives, the trade leaves it fewer cards short of
// its next build, and the asker is not the leader on public points.
export function shouldAcceptTrade(state: GameState, botId: string, offer: TradeAsk): boolean {
  const me = state.players.find((p) => p.id === botId);
  if (!me || offer.from === botId || !state.players.some((p) => p.id === offer.from)) return false;
  if (RESOURCES.some((r) => (offer.want[r] ?? 0) > me.resources[r])) return false;
  if (size(offer.give) < size(offer.want)) return false;
  const askerVP = publicVP(state, offer.from);
  const topVP = Math.max(...state.players.map((p) => publicVP(state, p.id)));
  if (askerVP === topVP && askerVP > publicVP(state, botId)) return false;
  const goal = goalFor(state, me);
  const after = { ...me.resources };
  for (const r of RESOURCES) after[r] += (offer.give[r] ?? 0) - (offer.want[r] ?? 0);
  return shortOf(after, goal).length < shortOf(me.resources, goal).length;
}

// What a bot asks the table for on its own turn (#363), or null. Only when exactly one card short of
// its next build: that card, one for one, against its biggest spare (a card the build does not use).
// Pure; the caller holds a bot to one ask per turn.
export function chooseTradeAsk(
  state: GameState,
  botId: string,
  lastDeclined?: { give: Cost; want: Cost } | null,
): { give: Cost; want: Cost } | null {
  const me = state.players.find((p) => p.id === botId);
  if (!me || state.phase !== "main" || state.current !== botId || state.trade) return null;
  const goal = goalFor(state, me);
  const short = shortOf(me.resources, goal);
  if (!goal || short.length !== 1) return null;
  const want = short[0]!;
  const spare = (r: Resource) => me.resources[r] - (goal[r] ?? 0);
  const give = RESOURCES.filter((r) => r !== want && spare(r) > 0).sort((a, b) => spare(b) - spare(a))[0];
  if (!give) return null;
  const ask = { give: { [give]: 1 }, want: { [want]: 1 } };
  if (
    lastDeclined &&
    RESOURCES.every((r) => (lastDeclined.give[r] ?? 0) === (ask.give[r] ?? 0)) &&
    RESOURCES.every((r) => (lastDeclined.want[r] ?? 0) === (ask.want[r] ?? 0))
  ) return null;
  return ask;
}

// A human seat covered by the host after its reconnect grace gets only the moves that keep play
// flowing without spending or trading anything. Keep this separate from chooseBotAction so practice
// bots retain their full strategy.
export function chooseRecoveryAction(state: GameState, pid: string): Action | null {
  const me = state.players.find((p) => p.id === pid);
  if (!me) return null;

  if (state.phase === "discard" && (state.discardNeeded[pid] ?? 0) > 0) {
    return { type: "discard", resources: discardHalf(me, state.discardNeeded[pid]!) };
  }
  if (state.phase === "setupSettle" && state.current === pid) {
    const opts = legalSettle(state, pid, true);
    opts.sort((a, b) => pipScore(state, b) - pipScore(state, a));
    if (opts[0]) return { type: "setupSettle", vertexId: opts[0] };
  }
  if (state.phase === "setupRoad" && state.current === pid) {
    const opts = legalRoads(state, pid, true);
    if (opts[0]) return { type: "setupRoad", edgeId: opts[0] };
  }
  if (state.current !== pid) return null;
  if (state.phase === "roll" || state.phase === "rollOff") return { type: "roll" };
  if (state.phase === "robber") {
    const move = bestRobberHex(state, pid);
    return { type: "moveRobber", hexId: move.hexId, stealFrom: move.stealFrom };
  }
  if (state.phase === "main") return { type: "endTurn" };
  return null;
}

// Goods events already have a canonical public voice. Annotate only automation of
// non-goods setup/roll-off/pass events so idle recovery remains attributable.
export function logBotAction(before: GameState, after: GameState, action: Action, _pid: string, seatName: string, who = "Bot"): GameState {
  // `who` is "Practice bot" in a practice game (#562); online idle takeover keeps "Bot" because it acts for a human seat.
  const replace = (line: string) => {
    if (action.type === "roll" && before.phase === "rollOff") return line.replace(/^.+ rolls a (\d+)\.$/, `${who} rolled for ${seatName}: roll-off die $1.`);
    if (action.type === "setupSettle" && before.setupIndex < before.players.length) return line.replace(/^.+ raises an outpost\.$/, `${who} built an outpost for ${seatName}.`);
    if (action.type === "setupRoad") return line.replace(/^.+ lays a path\.$/, `${who} built a path for ${seatName}.`);
    if (action.type === "endTurn" && /'s turn\.$/.test(line)) return `${who} passed for ${seatName}; ${line}`;
    return line;
  };
  let overlap = Math.min(before.log.length, after.log.length);
  while (overlap && !before.log.slice(-overlap).every((line, i) => line === after.log[i])) overlap--;
  return { ...after, log: [...before.log, ...after.log.slice(overlap).map(replace)].slice(-200) };
}

export function chooseBotAction(state: GameState, pid: string): Action | null {
  const me = state.players.find((p) => p.id === pid);
  if (!me) return null;

  if (state.phase === "discard" && (state.discardNeeded[pid] ?? 0) > 0) {
    return { type: "discard", resources: discardHalf(me, state.discardNeeded[pid]!) };
  }
  if (state.phase === "setupSettle") {
    const opts = legalSettle(state, pid, true);
    opts.sort((a, b) => pipScore(state, b) - pipScore(state, a));
    if (opts[0]) return { type: "setupSettle", vertexId: opts[0] };
  }
  if (state.phase === "setupRoad") {
    const opts = legalRoads(state, pid, true);
    if (opts[0]) return { type: "setupRoad", edgeId: opts[0] };
  }
  if (state.current !== pid) return null;
  if (state.phase === "robber") {
    const m = bestRobberHex(state, pid);
    return { type: "moveRobber", hexId: m.hexId, stealFrom: m.stealFrom };
  }
  if (state.phase === "roll" || state.phase === "rollOff") return { type: "roll" };
  if (state.phase !== "main") return null;

  // A held knight is 2 points once three are out (#233: bots that never play them stall a game).
  if (!state.playedCard && playable(me, "knight") > 0) {
    if (wayfarerMode(state) === "off") return { type: "playKnight", hexId: "", stealFrom: null };
    const m = bestRobberHex(state, pid);
    return { type: "playKnight", hexId: m.hexId, stealFrom: m.stealFrom };
  }

  const cities = legalCities(state, pid);
  if (cities.length && hasCost(me, COST.stronghold) && me.strongholdsLeft > 0) {
    return { type: "buildStronghold", vertexId: cities[0]! };
  }
  const settles = legalSettle(state, pid, false);
  if (settles.length && hasCost(me, COST.outpost) && me.outpostsLeft > 0) {
    settles.sort((a, b) => pipScore(state, b) - pipScore(state, a));
    return { type: "buildOutpost", vertexId: settles[0]! };
  }
  const roads = legalRoads(state, pid, false);
  if (roads.length && hasCost(me, COST.path) && me.pathsLeft > 0 && me.outpostsLeft > 0) {
    return { type: "buildPath", edgeId: roads[Math.floor(roads.length / 2)]! };
  }

  const goal = goalOf(state, me, cities, settles, roads);
  const short = shortOf(me.resources, goal);

  // Fortunes held since an earlier turn (#361: a bot that never plays them makes practice too easy).
  if (!state.playedCard) {
    if (goal && playable(me, "plenty") > 0 && short.length >= 1 && short.length <= 2) {
      const pick = short.slice();
      if (pick.length === 1) {
        const extra = RESOURCES.find((r) => (goal[r] ?? 0) > 0 && state.bank[r] > (r === pick[0] ? 1 : 0)) ?? RESOURCES.find((r) => state.bank[r] > (r === pick[0] ? 1 : 0));
        if (extra) pick.push(extra);
      }
      if (pick.length === 2 && RESOURCES.every((r) => state.bank[r] >= pick.filter((x) => x === r).length)) {
        return { type: "playPlenty", resources: pick };
      }
    }
    if (playable(me, "road") > 0 && me.pathsLeft > 0 && roads.length) {
      const first = bestRoad(state, pid, roads);
      const edgeIds = [first];
      if (me.pathsLeft > 1) {
        const next = withPath(state, pid, first);
        const more = legalRoads(next, pid, false);
        if (more.length) edgeIds.push(bestRoad(next, pid, more));
      }
      return { type: "playRoad", edgeIds };
    }
    if (goal && playable(me, "monopoly") > 0 && short.length) {
      // Only the bot's own need decides; opponents' hands are hidden online and stay unread here.
      const count = (r: Resource) => short.filter((x) => x === r).length;
      const resource = RESOURCES.slice().sort((a, b) => count(b) - count(a))[0]!;
      return { type: "playMonopoly", resource };
    }
  }

  if (hasCost(me, COST.card) && state.deck.length > 0) return { type: "buyCard" };

  // Trade spare cards toward the next buy (#233: a bot with no ore hex never reached 2 ore by
  // trading only for what it had none of, and sat at 9 points for hundreds of turns).
  if (goal) {
    const want = RESOURCES.find((r) => me.resources[r] < (goal[r] ?? 0) && state.bank[r] > 0);
    const give = RESOURCES.find((r) => r !== want && me.resources[r] - (goal[r] ?? 0) >= harborRate(state, pid, r));
    if (want && give) return { type: "bankTrade", give, want };
  }
  if (roads.length && hasCost(me, COST.path) && me.pathsLeft > 0) {
    return { type: "buildPath", edgeId: roads[0]! };
  }
  return { type: "endTurn" };
}
