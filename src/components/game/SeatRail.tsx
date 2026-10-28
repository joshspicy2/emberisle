// #443: each seat is one line and the points are the number (docs/design/polish.md: numbers are heroes, colour is
// information). The desktop rail (an accordion: the player menu opens under its card, docs/design/chat.md) and the phone
// strip (docs/design/mobile-hud.md) share SeatLine: colour dot, name, goods and fortunes as two small counts only when
// non-zero, the roll-off die only while the roll-off is live, and the points at text-title. The seat on turn carries
// `seat-turn`: its dot pulses softly (bible §4.3) and the card brightens over 200 ms (§8), with an ink ring on the dot and
// aria-current so the turn never rests on colour or motion alone (#312); the dot is a SeatDot.
// #645: under that line, on a line of its own, two public tallies at every width: "🛤 n" (longest continuous path) and "⚔ n"
// (wayfarers played); the Longest Path / Largest Army holder wears a gold badge on its tally (see Tally).
// Your fortunes by kind and a dropped seat's state are facts in the player menu, one tap away.
import { useMemo } from "react";
import { type LucideIcon, Route, ScrollText, Swords } from "lucide-react";
import { SeatBubbles } from "@/components/game/chunks";
import { LazyBoundary } from "@/lib/lazy";
import { PlayerMenu, seatAway } from "@/components/game/PlayerMenu";
import { SeatDot } from "@/components/game/SeatDot";
import type { GameState, PlayerState } from "@/lib/game/types";
import { cards, hiddenCount, publicVP, roadLength } from "@/lib/game/rules";
import { useGame } from "@/lib/game/store";
import { cn } from "@/lib/utils";

// Same reminder for every viewer and hand; its presence never signals a held point card.
export function HiddenPointHint() {
  return <p data-testid="hidden-point-hint" className="rounded-control px-2 text-xs leading-3" style={{ background: "var(--table)", color: "var(--table-muted)" }}>Hidden fortunes may add points.</p>;
}

// The seat's roll-off die, "–" until it rolls this round; gone once the roll-off is settled (docs/design/first-player.md).
function RollOffDie({ state, id, className }: { state: GameState; id: string; className: string }) {
  if (!state.rollOff || state.phase !== "rollOff") return null;
  return (
    <span data-testid="rolloff-die" className={cn("grid shrink-0 place-items-center rounded-[8px] bg-fg font-medium text-bg tabular-nums", className)}>
      {state.rollOff.rolls[id] ?? "–"}
    </span>
  );
}

// A small count with its unit as a mark (a card outline for goods, the Fortune button's scroll for fortunes); the unit's
// word stays for screen readers. zinc-700 reads ≥ 4.5:1 on the glass.
function Count({ testid, n, unit, className }: { testid: string; n: number; unit: "good" | "fortune"; className?: string }) {
  return (
    <span data-testid={testid} className={cn("flex shrink-0 items-center gap-0.5 text-caption tabular-nums text-zinc-700", className)}>
      {n}
      {unit === "good" ? <span className="h-3 w-2.5 rounded-[2px] border-[1.5px] border-current" /> : <ScrollText className="size-3" aria-hidden="true" />}
      <span className="sr-only"> {unit}{n === 1 ? "" : "s"}</span>
    </span>
  );
}

// #645: a public tally, a Route icon and n (longest continuous path) or a Swords icon and n (wayfarers played), always drawn, at every width. The
// holder of the award (state.longestRoad / state.largestArmy, which already carry the 5 and 3 minimums and the tie rule)
// wears a gold badge: its accessible name is the award, e.g. "Longest path, 7". The badge pulses once when it lands on a
// seat (the existing `build-ready` keyframes; none under reduced motion); the log line is rules.ts's own.
function Tally({ testid, Icon, n, name, held }: { testid: string; Icon: LucideIcon; n: number; name: [string, string]; held: boolean }) {
  return (
    <span
      data-testid={testid}
      role="img"
      aria-label={`${name[+held]}, ${n}`}
      className={cn("flex shrink-0 items-center gap-0.5 rounded-full px-0.5", held ? "bg-amber-300 font-semibold text-zinc-900 ring-1 ring-amber-600 build-ready" : "text-zinc-700")}
    >
      <Icon aria-hidden="true" className="size-3" />
      {n}
    </span>
  );
}

// #562: a practice bot's persistent label. The desktop rail spells "Practice" on the tally line. A phone cell has no room on
// either line without squeezing the short name, so the strip pins a compact "P" (12 px text) to the card's top corner,
// clear of the name and the points. Its accessible name and title are the word. It claims nothing about strength.
function PracticeMark({ strip }: { strip: boolean }) {
  return (
    <span
      data-testid="practice-label"
      role="img"
      aria-label="Practice"
      title="Practice"
      className={cn("shrink-0 rounded-full bg-zinc-200 font-medium text-zinc-800 ring-1 ring-zinc-400", strip ? "pointer-events-none absolute -top-2.5 right-1 grid size-4 place-items-center text-xs leading-none" : "ml-auto px-1 text-xs leading-4")}
    >
      <span aria-hidden="true">{strip ? "P" : "Practice"}</span>
    </span>
  );
}

// `short` is the strip's under-100 px form (#420); its presence makes this a strip line, which also hides the counts in
// a cell under 200 px so the name keeps its room. A dropped seat's marker shows at every width (the word only where it fits).
function SeatLine({ p, actor, short }: { p: PlayerState; actor: string; short?: string }) {
  const state = useGame((s) => s.state)!;
  const away = seatAway(useGame((s) => s.seats), p);
  const strip = short !== undefined;
  const hidden = p.id === actor && p.hidden.vp > 0 ? p.hidden.vp : 0;
  const goods = cards(p);
  const fortunes = p.fortunes ?? hiddenCount(p);
  const narrow = strip ? "@max-[200px]:hidden" : undefined;
  const path = useMemo(() => roadLength(state, p.id), [state, p.id]);
  // #562: practice bot seats only (never an online or hotseat seat, even a host-run bot online).
  const practice = useGame((s) => s.mode === "ai") && p.kind === "bot";
  return (
    <>
      <span className={cn("flex w-full items-center", strip ? "gap-1.5 @max-[100px]:gap-1 @max-[100px]:has-[.seat-away]:gap-0.5 @max-[72px]:has-[.seat-away]:gap-0" : "gap-1.5")}>
        {/* Under 100 px a cell holds "Emb" and the points with 4 px gaps; the dot gives back its two extra pixels there (#420). */}
        <SeatDot color={p.color} className={cn("seat-dot size-3", strip && "@max-[100px]:size-2.5")} />
        <span data-testid="seat-name" className={cn("min-w-0 flex-auto truncate text-sm font-medium", strip && "@max-[128px]:sr-only")}>
          {p.name}
        </span>
        {strip ? (
          <span data-testid="seat-name" aria-hidden="true" className="hidden min-w-0 flex-auto truncate text-xs font-medium @max-[128px]:block">
            {short}
          </span>
        ) : null}
        {away ? (
          <span data-testid="seat-away" className={cn("seat-away flex min-w-4 shrink-[9] items-center gap-0.5 text-caption text-zinc-700", strip && "@max-[100px]:min-w-3")}>
            {/* A struck ring: the seat's circle with a line through it, in CSS so it costs no icon. */}
            <span className="relative size-2.5 shrink-0 rounded-full border-[1.5px] border-current after:absolute after:-inset-x-0.5 after:top-1/2 after:h-[1.5px] after:-rotate-45 after:bg-current" />
            <span aria-hidden="true" className={cn("truncate", narrow)}>
              Away
            </span>
            <span className="sr-only">reconnecting</span>
          </span>
        ) : (
          <>
            {goods > 0 ? <Count testid="seat-goods" n={goods} unit="good" className={narrow} /> : null}
            {fortunes > 0 ? <Count testid="seat-fortunes" n={fortunes} unit="fortune" className={narrow} /> : null}
          </>
        )}
        <RollOffDie state={state} id={p.id} className={strip ? "size-5 rounded-[4px] text-xs" : "size-6 text-sm"} />
        <span
          data-testid="seat-vp"
          className={cn("shrink-0 text-title tabular-nums", strip && state.phase === "rollOff" && "@max-[100px]:hidden")}
        >
          {publicVP(state, p.id)}
          <span className="sr-only"> points{hidden ? `, plus ${hidden} hidden` : ""}</span>
          {hidden ? (
            <span aria-hidden="true" className={cn("text-caption text-zinc-700", strip && "sr-only")}>
              +{hidden}
            </span>
          ) : null}
        </span>
      </span>
      {/* Its own line, so the cell's width is the tallies' room: a 77 px phone cell holds both with two-digit counts. */}
      <span className="flex w-full items-center gap-1 text-caption">
        <Tally testid="tally-path" Icon={Route} n={path} name={["Path length", "Longest path"]} held={state.longestRoad === p.id} />
        <Tally testid="tally-army" Icon={Swords} n={p.knightsPlayed} name={["Wayfarers played", "Largest army"]} held={state.largestArmy === p.id} />
        {practice ? <PracticeMark strip={strip} /> : null}
      </span>
    </>
  );
}

// One seat's card: the menu's trigger (docs/design/chat.md "The player action menu") with its seat bubble beside it (#899). The rail
// gives it `rail-<id>` and chip corners, the strip `seat-<id>`, control corners and a short name.
function SeatCard({ p, actor, short, className }: { p: PlayerState; actor: string; short?: string; className: string }) {
  const current = useGame((s) => s.state!.current);
  const menuFor = useGame((s) => s.menuFor);
  const openMenu = useGame((s) => s.openMenu);
  // #488: reactions only arrive at an online table; the chunk that draws them is loaded by then (see chunks.ts).
  const online = useGame((s) => s.mode === "online");
  const strip = short !== undefined;
  return (
    <div
      data-testid={`${strip ? "seat" : "rail"}-${p.id}`}
      className={cn("seat-card relative transition-colors duration-200", className, p.id === current && "seat-turn")}
    >
      <button
        type="button"
        data-menu-trigger={p.id}
        aria-expanded={menuFor === p.id}
        aria-controls={`player-menu-${p.id}`}
        aria-current={p.id === current || undefined}
        onClick={() => openMenu(menuFor === p.id ? null : p.id)}
        className={cn(
          "flex h-11 w-full cursor-pointer flex-col justify-center rounded-[inherit] text-left hover:bg-white/40",
          strip ? "px-2 @max-[100px]:px-1.5 @max-[72px]:px-1" : "px-2.5",
        )}
      >
        <SeatLine p={p} actor={actor} short={short} />
      </button>
      {online ? (
        <LazyBoundary failed={null}>
          <SeatBubbles by="player" id={p.id} at={strip ? "strip" : "rail"} />
        </LazyBoundary>
      ) : null}
    </div>
  );
}

// An open player menu is a popover, so the rail rises over the bottom stack while it shows (they overlap at 800x500).
export function SeatRail({ actor }: { actor: string }) {
  const players = useGame((s) => s.state!.players);
  const menuFor = useGame((s) => s.menuFor);
  return (
    <aside className={cn("pointer-events-none absolute left-3 top-20 hidden w-48 flex-col gap-1 md:flex", menuFor ? "z-20" : "z-10")}>
      {players.map((p) => (
        <div key={p.id} className="pointer-events-auto flex flex-col gap-1">
          <SeatCard p={p} actor={actor} className="rounded-chip" />
          {menuFor === p.id ? <PlayerMenu player={p} /> : null}
        </div>
      ))}
      <HiddenPointHint />
    </aside>
  );
}

// Hotseat's "Seat 2" .. "Seat 4" would all read "Sea", so a trailing number keeps the initial and the number ("S2").
function shortName(name: string) {
  const n = /\d+$/.exec(name)?.[0];
  return n ? `${name[0]}${n}` : name.slice(0, 3);
}

// Three letters is all an 89 px cell holds, so seats that still share a short form ("Ember", "Emberly") fall back to
// the initial and the seat number ("E1", "E2").
function shortNames(names: string[]) {
  const short = names.map(shortName);
  return short.map((s, i) => (short.some((o, j) => j !== i && o === s) ? `${names[i]![0]}${i + 1}` : s));
}

// Phone seat strip (docs/design/mobile-hud.md): 44 px, one cell per seat.
export function SeatStrip({ actor, className }: { actor: string; className: string }) {
  const players = useGame((s) => s.state!.players);
  const short = shortNames(players.map((p) => p.name));
  return (
    <div data-testid="seat-strip" className={cn("pointer-events-auto flex h-11 gap-1", className)}>
      {players.map((p, i) => (
        <SeatCard key={p.id} p={p} actor={actor} short={short[i]} className="@container h-11 min-w-0 flex-1 rounded-control" />
      ))}
    </div>
  );
}
