// Presentation-only events for bot action moments (#608, #720). An event says what a committed action did, in public
// terms only, for a later centre line, highlight and sound. Nothing here dispatches an action, holds the store, or
// changes a state: a feed only reads the before/after it is handed, after the canonical state is already set.
// Private details never enter an event: a bought fortune's kind, the goods a seat discarded, and the good a steal took.
import { RESOURCES, type Action, type DevKind, type GameState, type Resource } from "./types";

export type Bag = Partial<Record<Resource, number>>;
// Who chose the action. Practice knows it exactly; online it is "bot" only for a bot seat (the host runs every bot
// seat), and "unknown" for a person's seat, which the host's recovery may be playing.
export type Controller = "bot" | "human" | "unknown";
export type PlayedFortune = Exclude<DevKind, "vp">;
export type BatchedChange = { kind: "outpost" | "stronghold" | "path" | "wayfarer" | "fortuneBuy"; id: string };

export type EventBody =
  | { kind: "outpost"; vertex: string; setup: boolean }
  | { kind: "stronghold"; vertex: string }
  // `edges` is in placement order when the event is `ordered`; a path fortune may lay two.
  | { kind: "path"; edges: string[]; via: "setup" | "build" | "fortune" }
  // `victim` is who lost one good, never which good; null when nothing was taken or (online) it cannot be told.
  | { kind: "wayfarer"; hex: string; victim: string | null; via: "move" | "fortune" }
  | { kind: "fortuneBuy" }
  | { kind: "fortunePlay"; fortune: "knight" }
  | { kind: "plenty"; resources: Resource[] }
  | { kind: "monopoly"; resource: Resource; taken: number }
  | { kind: "bankTrade"; give: Resource; rate: number; want: Resource }
  | { kind: "discard"; count: number }
  | { kind: "offer"; tradeId: string; give: Bag; want: Bag }
  | { kind: "trade"; tradeId: string; taker: string; give: Bag; want: Bag }
  // Online, one snapshot that carries more than one change: the set in a canonical order, never a guessed play order.
  | { kind: "summary"; changes: BatchedChange[] };

export type PresentationEvent = EventBody & {
  // Local to this tab: `${epoch}.${n}`. A new game, rematch or reconnect baseline starts a new epoch.
  id: string;
  epoch: number;
  source: "practice" | "online";
  // The seat the change belongs to; null only when an online batch cannot be tied to one seat.
  actor: string | null;
  controller: Controller;
  // True when the event is one atomic action whose internal order (a fortune's two paths) is known.
  ordered: boolean;
  // The committed state's seq the event was read from.
  seq: number;
};

export type PresentationListener = (event: Readonly<PresentationEvent>) => void;

const cards = (p: { resources: Record<Resource, number> }) => RESOURCES.reduce((n, r) => n + p.resources[r], 0);

// What a successful practice action did, from the committed before/after and the exact action. Null for a refused
// action (the caller passes only successes, and an unchanged state reads as refused), and for an action that moves no
// piece and no hand in a way the moments show (roll, roll-off, pass, a direct offer, a decline).
export function projectAction(before: GameState, after: GameState, actor: string, action: Action): EventBody | null {
  if (after === before || after.seq === before.seq) return null;
  const was = before.players.find((p) => p.id === actor);
  const now = after.players.find((p) => p.id === actor);
  if (!was || !now) return null;
  const laid = (ids: string[]) =>
    ids.filter((id, i) => ids.indexOf(id) === i && after.edges.find((e) => e.id === id)?.path === actor && !before.edges.find((e) => e.id === id)?.path);
  // The one seat whose hand shrank by a card, as the rules' public line names it; never the good.
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

// One tab's event feed: local epoch and event ids, and deduplication by a key each source gives (a state seq, a real
// trade id). Listeners get frozen copies; a listener that throws is cut off from that event, never from the game.
export function createPresentationFeed() {
  const listeners = new Set<PresentationListener>();
  let epoch = 1;
  let n = 0;
  let seen = new Set<string>();
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const feed = {
    get epoch() {
      return epoch;
    },
    subscribe(listener: PresentationListener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    // A new game, a rematch or a fresh baseline: ids restart under a new epoch and old keys are forgotten.
    reset() {
      epoch += 1;
      n = 0;
      seen = new Set();
    },
    // Emit once per key in this epoch. Returns the event, or null for a duplicate.
    emit(key: string, body: EventBody, meta: Pick<PresentationEvent, "source" | "actor" | "controller" | "ordered" | "seq">): PresentationEvent | null {
      if (seen.has(key)) return null;
      seen.add(key);
      n += 1;
      const event = Object.freeze({ ...copy(body), ...meta, id: `${epoch}.${n}`, epoch }) as PresentationEvent;
      for (const l of listeners) {
        try {
          l(event);
        } catch {
          // presentation only: a broken listener never reaches the game
        }
      }
      return event;
    },
    // Practice: one committed action, with the controller the store knows (a bot's runBots, or a person's tap).
    practice(before: GameState, after: GameState, actor: string, action: Action, controller: Controller) {
      const body = projectAction(before, after, actor, action);
      return body ? feed.emit(`seq:${after.seq}:${actor}`, body, { source: "practice", actor, controller, ordered: true, seq: after.seq }) : null;
    },
    // An ask-the-table offer opened (practice) or announced (online), keyed by its real trade id.
    offer(source: PresentationEvent["source"], tradeId: string, from: string, give: Bag, want: Bag, controller: Controller, seq: number) {
      return feed.emit(`offer:${tradeId}`, { kind: "offer", tradeId, give, want }, { source, actor: from, controller, ordered: true, seq });
    },
    // That offer taken: once per trade id, whoever repeats the close.
    trade(source: PresentationEvent["source"], tradeId: string, from: string, taker: string, give: Bag, want: Bag, controller: Controller, seq: number) {
      return feed.emit(`trade:${tradeId}`, { kind: "trade", tradeId, taker, give, want }, { source, actor: from, controller, ordered: true, seq });
    },
  };
  return feed;
}

export type PresentationFeed = ReturnType<typeof createPresentationFeed>;
