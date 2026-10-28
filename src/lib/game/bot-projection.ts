// What a successful practice action did, in public terms, and the emitter every source shares (#608, #720). Loaded on
// demand by bot-presentation.ts and by net/commit-observer.ts.
import { RESOURCES, type Action, type GameState, type Resource } from "./types";
import type { Bag, Controller, EventBody, EventMeta, FeedCore, PresentationEvent } from "./bot-presentation";

// Emit once per key in the feed's epoch, to every listener, as a frozen copy. Returns the event, or null for a
// duplicate. A listener that throws is cut off from that event, never from the game.
export function emit(feed: FeedCore, key: string, body: EventBody, meta: EventMeta): PresentationEvent | null {
  if (feed.seen.has(key)) return null;
  feed.seen.add(key);
  const event: PresentationEvent = Object.freeze({ ...(JSON.parse(JSON.stringify(body)) as EventBody), ...meta, id: `${feed.epoch}.${++feed.n}`, epoch: feed.epoch });
  for (const l of feed.listeners) {
    try {
      l(event);
    } catch {
      // presentation only
    }
  }
  return event;
}

// Practice: one committed action. `automated` is the store's own flag: true for runBots' moves, false for a person's.
export function practice(feed: FeedCore, before: GameState, after: GameState, actor: string, action: Action, automated: boolean) {
  const body = projectAction(before, after, actor, action);
  const controller: Controller = automated ? "bot" : "human";
  return body && emit(feed, `seq:${after.seq}:${actor}`, body, { source: "practice", actor, controller, ordered: true, seq: after.seq });
}

type Ask = { tradeId: string; from: string; give: Bag; want: Bag };
// In practice a bot seat's ask always comes from runBots and a person's from their own Ask the table.
const asker = (state: GameState, from: string): Controller => (state.players.find((p) => p.id === from)?.kind === "bot" ? "bot" : "human");

// Practice's ask-the-table offer opened, keyed by its real trade id.
export function offer(feed: FeedCore, state: GameState, { tradeId, from, give, want }: Ask) {
  return emit(feed, `offer:${tradeId}`, { kind: "offer", tradeId, give, want }, { source: "practice", actor: from, controller: asker(state, from), ordered: true, seq: state.seq });
}

// That offer taken by `taker`: once per trade id.
export function trade(feed: FeedCore, state: GameState, { tradeId, from, give, want }: Ask, taker: string) {
  return emit(feed, `trade:${tradeId}`, { kind: "trade", tradeId, taker, give, want }, { source: "practice", actor: from, controller: asker(state, from), ordered: true, seq: state.seq });
}

const cards = (p: { resources: Record<Resource, number> }) => RESOURCES.reduce((n, r) => n + p.resources[r], 0);

// From the committed before/after and the exact action. Null for a refused action (the caller passes only successes,
// and an unchanged state reads as refused), and for an action that moves no piece and no hand in a way the moments
// show (roll, roll-off, pass, a direct offer, a decline). A bought fortune's kind, discarded goods and a stolen good
// are never read into the result.
export function projectAction(before: GameState, after: GameState, actor: string, action: Action): EventBody | null {
  if (after === before || after.seq === before.seq) return null;
  const was = before.players.find((p) => p.id === actor);
  const now = after.players.find((p) => p.id === actor);
  if (!was || !now) return null;
  const laid = (ids: string[]) =>
    ids.filter((id, i) => ids.indexOf(id) === i && after.edges.find((e) => e.id === id)?.path === actor && !before.edges.find((e) => e.id === id)?.path);
  // The one seat whose hand shrank, as the rules' public line names it; never the good.
  const victim = () => {
    const lost = after.players.filter((p) => p.id !== actor && cards(p) < cards(before.players.find((x) => x.id === p.id)!));
    return lost.length === 1 ? lost[0]!.id : null;
  };
  switch (action.type) {
    case "setupSettle":
      return { kind: "outpost", vertex: action.vertexId, setup: true };
    case "buildOutpost":
      return { kind: "outpost", vertex: action.vertexId, setup: false };
    case "buildStronghold":
      return { kind: "stronghold", vertex: action.vertexId };
    case "setupRoad":
    case "buildPath": {
      const edges = laid([action.edgeId]);
      return edges.length ? { kind: "path", edges, via: action.type === "setupRoad" ? "setup" : "build" } : null;
    }
    case "playRoad": {
      const edges = laid(Array.isArray(action.edgeIds) ? action.edgeIds : []);
      return edges.length ? { kind: "path", edges, via: "fortune" } : null;
    }
    case "moveRobber":
      return { kind: "wayfarer", hex: after.robberHex, victim: victim(), via: "move" };
    case "playKnight":
      return before.robberHex === after.robberHex
        ? { kind: "fortunePlay", fortune: "knight" }
        : { kind: "wayfarer", hex: after.robberHex, victim: victim(), via: "fortune" };
    case "buyCard":
      return { kind: "fortuneBuy" };
    case "playPlenty":
      return { kind: "plenty", resources: [...action.resources] };
    case "playMonopoly":
      return { kind: "monopoly", resource: action.resource, taken: now.resources[action.resource] - was.resources[action.resource] };
    case "bankTrade":
      return { kind: "bankTrade", give: action.give, rate: was.resources[action.give] - now.resources[action.give], want: action.want };
    case "discard":
      return { kind: "discard", count: cards(was) - cards(now) };
    default:
      return null;
  }
}
