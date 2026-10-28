// Online bot-presentation events (#608, #720), read conservatively from the host's committed `state` pushes and its
// trade messages. A push is a snapshot: when it carries more than one change, the order they were played in is gone
// (scripts/bot-presentation-event-prove.mjs shows two path orders reach identical pushes), so such a push becomes one
// unordered summary per seat and never a guessed sequence. A change is tied to the seat that owns the new piece; its
// controller is "bot" only for a bot seat. Only board pieces, the wayfarer's hex and fortune counts are read, all of
// which every seat already sees; hands are never read. The observer only reads: it never dispatches or delays a state.
import type { BatchedChange, Bag, Controller, EventBody, PresentationFeed } from "@/lib/game/bot-presentation";
import { emit } from "@/lib/game/bot-projection";
import type { GameState } from "@/lib/game/types";

type Change = BatchedChange & { owner: string | null; setup?: boolean };

const fortunesOf = (p: GameState["players"][number]) =>
  p.fortunes ?? Object.values(p.hidden ?? {}).reduce((n, k) => n + k, 0);

// The public pieces that differ between two pushes of the same game.
export function committedChanges(prev: GameState, next: GameState): Change[] {
  const out: Change[] = [];
  const setup = prev.phase === "setupSettle" || prev.phase === "setupRoad";
  for (const v of next.vertices) {
    const was = prev.vertices.find((x) => x.id === v.id)?.building ?? null;
    const now = v.building;
    if (!now) continue;
    if (!was) out.push({ kind: "outpost", id: v.id, owner: now.playerId, setup });
    else if (was.kind === "outpost" && now.kind === "stronghold" && was.playerId === now.playerId) out.push({ kind: "stronghold", id: v.id, owner: now.playerId });
  }
  for (const e of next.edges) {
    if (e.path && !prev.edges.find((x) => x.id === e.id)?.path) out.push({ kind: "path", id: e.id, owner: e.path });
  }
  // Only the seat whose turn it is moves the wayfarer; across a turn change the push cannot say which seat that was.
  if (next.robberHex !== prev.robberHex) out.push({ kind: "wayfarer", id: next.robberHex, owner: prev.current === next.current ? next.current : null });
  for (const p of next.players) {
    const was = prev.players.find((x) => x.id === p.id);
    if (!was) continue;
    for (let i = fortunesOf(was); i < fortunesOf(p); i++) out.push({ kind: "fortuneBuy", id: `${p.id}#${i + 1}`, owner: p.id });
  }
  return out;
}

function single(c: Change): EventBody {
  switch (c.kind) {
    case "outpost":
      return { kind: "outpost", vertex: c.id, setup: c.setup ?? false };
    case "stronghold":
      return { kind: "stronghold", vertex: c.id };
    case "path":
      return { kind: "path", edges: [c.id], via: "build" };
    case "wayfarer":
      // A push does not say whether a card was taken, or whose: say nobody rather than guess.
      return { kind: "wayfarer", hex: c.id, victim: null, via: "move" };
    case "fortuneBuy":
      return { kind: "fortuneBuy" };
  }
}

export function createCommitObserver(feed: PresentationFeed) {
  let prev: GameState | null = null;
  const offers = new Map<string, { from: string; give: Bag; want: Bag }>();
  const controllerOf = (id: string | null, game: GameState | null): Controller =>
    id && game?.players.find((p) => p.id === id)?.kind === "bot" ? "bot" : "unknown";

  return {
    // Every `state` push. `baseline` is the first push after a welcome (a join or a reconnect): it is recorded silently,
    // so nothing missed while away is replayed as if it just happened.
    state(next: GameState, baseline = false) {
      const rematch = prev !== null && (prev.seed !== next.seed || (prev.phase === "over" && next.phase !== "over"));
      if (rematch) {
        feed.reset();
        offers.clear();
      }
      if (!prev || baseline || rematch) {
        prev = next;
        return [];
      }
      // A repeated or older push of the same game says nothing new.
      if (next.seq <= prev.seq) return [];
      const before = prev;
      prev = next;
      const changes = committedChanges(before, next);
      if (changes.length === 1) {
        const c = changes[0]!;
        const e = emit(feed, `state:${next.seq}:${c.owner}`, single(c), { source: "online", actor: c.owner, controller: controllerOf(c.owner, next), ordered: true, seq: next.seq });
        return e ? [e] : [];
      }
      const owners = [...new Set(changes.map((c) => c.owner))];
      const events = [];
      for (const owner of owners) {
        const mine = changes
          .filter((c) => c.owner === owner)
          .map(({ kind, id }) => ({ kind, id }))
          .sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1));
        const e = emit(feed, `state:${next.seq}:${owner}`, { kind: "summary", changes: mine }, { source: "online", actor: owner, controller: controllerOf(owner, next), ordered: false, seq: next.seq });
        if (e) events.push(e);
      }
      return events;
    },
    // `tradeOffer`: one event per real trade id, however often the host's message repeats.
    offer(msg: { tradeId: string; from: string; give: Bag; want: Bag }) {
      if (!offers.has(msg.tradeId)) offers.set(msg.tradeId, { from: msg.from, give: msg.give, want: msg.want });
      const { tradeId, from, give, want } = msg;
      return emit(feed, `offer:${tradeId}`, { kind: "offer", tradeId, give, want }, { source: "online", actor: from, controller: controllerOf(from, prev), ordered: true, seq: prev?.seq ?? 0 });
    },
    // `tradeClosed` with a taker: the offer's goods changed hands. A close for an offer this tab never saw says nothing.
    closed(msg: { tradeId: string; taker?: string }) {
      const o = offers.get(msg.tradeId);
      if (!o || !msg.taker) return null;
      const { tradeId, taker } = msg;
      return emit(feed, `trade:${tradeId}`, { kind: "trade", tradeId, taker, give: o.give, want: o.want }, { source: "online", actor: o.from, controller: controllerOf(o.from, prev), ordered: true, seq: prev?.seq ?? 0 });
    },
    // Leaving the table: the next push is a fresh baseline in a new epoch.
    reset() {
      prev = null;
      offers.clear();
      feed.reset();
    },
  };
}

export type CommitObserver = ReturnType<typeof createCommitObserver>;
