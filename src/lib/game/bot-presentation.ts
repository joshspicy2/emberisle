// Presentation-only events for bot action moments (#608, #720). An event says what a committed action did, in public
// terms only, for a later centre line, highlight and sound. Nothing here dispatches an action, holds the store, or
// changes a state: a feed only reads the before/after it is handed, after the canonical state is already set.
// Private details never enter an event: a bought fortune's kind, the goods a seat discarded, and the good a steal took.
// This file is the small part the first-load index carries; the projection and emitter (bot-projection.ts) and the
// online observer (net/commit-observer.ts) load on demand.
import type { Resource } from "./types";

export type Bag = Partial<Record<Resource, number>>;
// Who chose the action. Practice knows it exactly; online it is "bot" only for a bot seat (the host runs every bot
// seat), and "unknown" for a person's seat, which the host's recovery may be playing.
export type Controller = "bot" | "human" | "unknown";
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

export type EventMeta = {
  source: "practice" | "online";
  // The seat the change belongs to; null only when an online batch cannot be tied to one seat.
  actor: string | null;
  controller: Controller;
  // True when the event is one atomic action whose internal order (a fortune's two paths) is known.
  ordered: boolean;
  // The committed state's seq the event was read from.
  seq: number;
};

// `id` is local to this tab, `${epoch}.${n}`; a new game, rematch or other table starts a new epoch.
export type PresentationEvent = EventBody & EventMeta & { id: string; epoch: number };
export type PresentationListener = (event: Readonly<PresentationEvent>) => void;
// What the emitter needs of a feed.
export interface FeedCore {
  listeners: Set<PresentationListener>;
  epoch: number;
  n: number;
  seen: Set<string>;
}

type Projection = typeof import("./bot-projection");
let projection: Promise<Projection> | null = null;
const loadProjection = () => (projection ??= import("./bot-projection").catch((e: unknown) => ((projection = null), Promise.reject(e))));
type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;

// One tab's event feed: listeners, the local epoch and the keys already emitted in it. Practice captures queue in commit
// order and are projected once the projection has loaded; `flush()` resolves when the queue is drained. A capture from
// an epoch that has since been reset is dropped.
export function createPresentationFeed() {
  let queue: Promise<unknown> = Promise.resolve();
  const feed = {
    listeners: new Set<PresentationListener>(),
    epoch: 1,
    n: 0,
    seen: new Set<string>(),
    subscribe(listener: PresentationListener) {
      feed.listeners.add(listener);
      return () => void feed.listeners.delete(listener);
    },
    flush: () => queue,
    // A new game, a rematch or another table: ids restart under a new epoch and old keys are forgotten.
    reset() {
      feed.epoch++;
      feed.n = 0;
      feed.seen = new Set();
    },
    // Practice: one committed action (store dispatch), an ask-the-table offer opened, and that offer taken.
    practice: (...a: Tail<Parameters<Projection["practice"]>>) => later((m) => m.practice(feed, ...a)),
    offer: (...a: Tail<Parameters<Projection["offer"]>>) => later((m) => m.offer(feed, ...a)),
    trade: (...a: Tail<Parameters<Projection["trade"]>>) => later((m) => m.trade(feed, ...a)),
  };
  const later = (run: (m: Projection) => void) => {
    const at = feed.epoch;
    queue = queue.then(loadProjection).then((m) => at === feed.epoch && run(m)).catch(() => {});
  };
  return feed;
}

export type PresentationFeed = ReturnType<typeof createPresentationFeed>;
