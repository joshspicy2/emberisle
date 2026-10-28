import { create } from "zustand";
import { createGame } from "./board";
import { logBotAction } from "./ai";
import { applyAction, legalCities, legalRoads, legalSettle, publicVP, stealTargets, victoryTarget } from "./rules";

const BANNER_MS = 2500;
let bannerTimer: ReturnType<typeof setTimeout> | null = null;
function showBanner(set: (p: { banner: string | null }) => void, text: string) {
  if (bannerTimer) clearTimeout(bannerTimer);
  set({ banner: text });
  bannerTimer = setTimeout(() => set({ banner: null }), BANNER_MS);
}

// An award that changed hands between two states, as one line, or null.
function awardLine(before: GameState | null, after: GameState) {
  // After a win the next state is a rematch's new game (#266): nobody lost anything.
  if (!before || before.phase === "over") return null;
  const who = (id: string | null) => after.players.find((p) => p.id === id)?.name ?? "Nobody";
  if (after.longestRoad !== before.longestRoad) {
    return after.longestRoad ? `${who(after.longestRoad)} holds the longest path` : `${who(before.longestRoad)} loses the longest path`;
  }
  if (after.largestArmy !== before.largestArmy) return `${who(after.largestArmy)} holds the largest army`;
  return null;
}

// The roll-off's new log lines as one banner ("Dune rolls a 4. · Dune places first, then …"), or null.
function rollOffLine(before: GameState | null, after: GameState) {
  if (before?.phase !== "rollOff") return null;
  const lines = newLog(before.log, after.log);
  return lines.length ? lines.join(" · ") : null;
}

// The table sounds a change of state makes, with their volume (#303, #609): the same diff serves practice, hotseat, and the
// host's pushes, so a bot's placement knocks like yours. `mine` is whether this browser's seat took the action (a fortune
// bought by someone else is a touch quieter).
function soundsFor(before: GameState | null, after: GameState, mine: boolean, victim = false): [SoundName, number][] {
  if (!before) return [];
  const out: [SoundName, number][] = [];
  const built = (s: GameState, kind: "outpost" | "stronghold") => s.vertices.filter((v) => v.building?.kind === kind).length;
  const paths = (s: GameState) => s.edges.filter((e) => e.path).length;
  if (after.dice && !before.dice) out.push(["dice_land", 1]);
  else if (built(after, "stronghold") > built(before, "stronghold")) out.push(["stronghold_place", 1]);
  else if (built(after, "outpost") > built(before, "outpost")) out.push(["outpost_place", 1]);
  else if (paths(after) > paths(before)) out.push(["path_place", 1]);
  else if ((after.deckLeft ?? after.deck.length) < (before.deckLeft ?? before.deck.length)) out.push(["card_buy", mine ? 1 : 0.6]);
  else if (after.playedCard && !before.playedCard) out.push(["card_play", 1]);
  // A new game moves the wayfarer back to the desert: only a move within the same game is a sound. The host strips the seed
  // from pushed states, so the same game is "not over before, same island, the turn count never fell".
  const sameGame = before.phase !== "over" && after.turn >= before.turn && after.hexes.every((h, i) => h.terrain === before.hexes[i]?.terrain);
  // The one set against (a piece on the new hex) hears robbed_fah in its place; everyone else keeps the usual cue.
  // One point from the target, by public points only (a held point fortune is never counted, so it cannot leak). Once per player.
  if (sameGame && after.robberHex !== before.robberHex) out.push(victim ? ["robbed_fah", 1] : ["wayfarer_move", 1]);
  return out;
}

// A board's identity for "this game": the host strips the seed, and a new island lays its hexes differently.
const gameSig = (g: GameState) => g.hexes.map((h) => `${h.terrain}${h.pip ?? ""}`).join();

// Match point (target - 1 public points) fires once per player per game: losing and regaining Longest Path or Largest Army
// does not repeat it. `claimed` is the sig of the game it counts for and the players already announced.
const claimed: { sig: string; pids: string[] } = { sig: "", pids: [] };
let matchLine: string | null = null;

// The players whose public points first reach target - 1 in this change, claimed for this game. Public points only, so a
// held point fortune can neither trigger it nor leak through it.
function claimMatchPoints(before: GameState, after: GameState) {
  if (before.phase === "over" || after.phase === "over") return [];
  const sig = gameSig(after);
  if (claimed.sig !== sig) Object.assign(claimed, { sig, pids: [] });
  const line = victoryTarget(after) - 1;
  const out = after.players.filter((p) => !claimed.pids.includes(p.id) && publicVP(after, p.id) >= line && publicVP(before, p.id) < line);
  claimed.pids.push(...out.map((p) => p.id));
  return out;
}

// The banner for the match point the last `hear` claimed (once), or null.
export function takeMatchPointLine() {
  const line = matchLine;
  matchLine = null;
  return line;
}

// End music: queued a moment after the win/lose sting at game over, once per game end. Leaving the end screen (the menu, a
// rematch, a new game) cancels it. Only a live change into "over" starts it, so a reload into a finished game stays quiet.
function stopEndMusic() {
  stop("end_music");
  stop("isaac_win");
}

// The board the start sting last played for, kept for the tab session so a reload mid-setup does not replay it.
const START_KEY = "emberisle-start-sig";
let startSig = "";
function startedSig() {
  if (startSig) return startSig;
  try {
    return (startSig = sessionStorage.getItem(START_KEY) ?? "");
  } catch {
    return "";
  }
}
function rememberStart(sig: string) {
  startSig = sig;
  try {
    sessionStorage.setItem(START_KEY, sig);
  } catch {
    // storage can be blocked; the sting still plays once for this page
  }
}

// Knocks waiting for their piece to land (#438). Leaving the table or starting a game drops them, so none plays late.
const knocks = new Set<ReturnType<typeof setTimeout>>();
function clearKnocks() {
  for (const t of knocks) clearTimeout(t);
  knocks.clear();
}

// Play the sound for a state change, and the your-turn chime when the turn comes round to this browser's seat
// (not in hotseat, where every seat is this browser).
export function hear(before: GameState | null, after: GameState, me: string, mode: GameStore["mode"], reconnect?: boolean) {
  const victim =
    mode !== "hotseat" && !!before && before.current !== me && after.vertices.some((v) => v.building?.playerId === me && v.hexes.includes(after.robberHex));
  const cue = haptics.player?.(before, after, me, mode) ?? play;
  if (before && after.winner && !before.winner) {
    // The banner buzz is felt at once; only the choice of sting waits for the lazy trade-sound chunk.
    if (me && (mode === "hotseat" || after.winner === me)) haptics.buzz?.(HAPTIC_MS.win);
    void tradeSounds.then(({ gameEnd }) => gameEnd(play, before, after, me, mode));
  } else {
    for (const [sound, volume] of soundsFor(before, after, mode === "hotseat" || after.current === me, victim)) {
      // A piece knocks when it lands, not when it is picked (#438); reduced motion has no fall, so it knocks at once.
      const land = sound in LAND_MS && !calmMotion() ? LAND_MS[sound as keyof typeof LAND_MS] : 0;
      if (land) {
        const t = setTimeout(() => {
          knocks.delete(t);
          cue(sound, volume);
        }, land);
        knocks.add(t);
      } else cue(sound, volume);
    }
  }
  // A new game (the lobby's Start, a rematch): the sting plays once, for a seat; the first roll cuts it off.
  // Keyed on the board: a bot may already have rolled first (seq > 0), and a reconnect into setup must not replay it.
  if (mode === "online" && me && (!before || before.phase === "over") && (after.phase === "rollOff" || after.phase === "setupSettle") && startedSig() !== gameSig(after)) {
    rememberStart(gameSig(after));
    play("game_start");
  }
  if (before?.phase === "over" && after.phase !== "over") stopEndMusic();
  matchLine = null;
  if (before && before.phase !== "over" && after.turn >= before.turn && after.hexes.every((h, i) => h.terrain === before.hexes[i]?.terrain)) {
    const reached = claimMatchPoints(before, after);
    for (const _ of reached) play("match_point");
    if (reached[0]) matchLine = `${reached[0].name} reached ${publicVP(after, reached[0].id)} points — one to win`;
  }
  if (mode !== "hotseat" && after.current === me && after.phase !== "over" && (reconnect || (before && before.current !== me))) cue("your_turn");
}

// The game log the dock shows (#305): a line of `state.log` or a host `log` message, stamped when this browser saw it.
export interface GameLogLine {
  at: number;
  text: string;
}
const GAME_LOG_MAX = 200;
const WATER_KEY = "emberisle-water";
const VIEW_KEY = "emberisle-view";

// The engine keeps only the last 200 log lines (rules.ts `log`), so once the log is full its length never grows and
// `after.slice(before.length)` would be empty. The new lines are what follows the longest tail of the old log that
// the new one still starts with.
function newLog(before: string[], after: string[]) {
  for (let k = Math.min(before.length, after.length); k > 0; k--) {
    if (before.slice(-k).every((line, i) => line === after[i])) return after.slice(k);
  }
  return after;
}

function stamp(lines: string[]): GameLogLine[] {
  const at = Date.now();
  return lines.map((text) => ({ at, text }));
}

function appendLog(log: GameLogLine[], lines: string[]) {
  return lines.length ? [...log, ...stamp(lines)].slice(-GAME_LOG_MAX) : log;
}

function savedWater(): WaterPath | null {
  try {
    const v = localStorage.getItem(WATER_KEY);
    return v === "crystal" || v === "simple" ? v : null;
  } catch {
    return null;
  }
}

// The table's camera in play (#597) as the player chose it, or null for the default for the screen's shape.
function savedView(): PlayView | null {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "diorama" || v === "overhead" ? v : null;
  } catch {
    return null;
  }
}

// The board as it would be with these paths laid, so the second pick of a path fortune can glow (#184).
function withPaths(state: GameState, edgeIds: string[], pid: string): GameState {
  if (!edgeIds.length) return state;
  return { ...state, edges: state.edges.map((e) => (edgeIds.includes(e.id) ? { ...e, path: pid } : e)) };
}
import { chooseBotAction, chooseTradeAsk, shouldAcceptTrade } from "./ai";
import { createPresentationFeed } from "./bot-presentation";
import { createCommitObserver } from "@/lib/net/commit-observer";
import { PLAYER_COLORS, RESOURCES, type Action, type BuildMode, type GameState, type VictoryTarget, type WayfarerMode } from "./types";
import type { Bag, ChatLine, Legal, Me, Reaction, Seat, TableClient } from "@/lib/net/table";
import { chunk } from "@/lib/lazy";
import { PROTO } from "@/lib/net/proto";
import { readMutedSeats } from "@/lib/muted-seats";
import { HAPTIC_MS } from "@/lib/haptic-durations";
import { haptics, play, playLater, stop, yourTurn, type SoundName } from "@/lib/sound";
import { calmMotion, LAND_MS } from "@/lib/scene/landing";
import type { WaterPath, WaterStatus } from "@/lib/scene/crystal-water";
import type { PlayView } from "@/lib/scene/mobile-fit";

const tradeSounds = import("../trade-sound");

// Bot action moments (#608, #720): presentation-only events read after each commit. They never dispatch or delay a state.
export const presentation = createPresentationFeed();
const commits = createCommitObserver(presentation);
const controllerOf = (state: GameState | null, id: string): "bot" | "human" =>
  state?.players.find((p) => p.id === id)?.kind === "bot" ? "bot" : "human";

// The ask-the-table offer every seat is looking at (docs/BUILD_BIBLE.md 4.4). `until` is when the host's 20 s run out.
export interface OpenOffer {
  tradeId: string;
  from: string;
  fromName: string;
  give: Bag;
  want: Bag;
  until: number;
}

// The client is needed only for discovery or an explicit online journey.
const tableModule = chunk(() => import("@/lib/net/table"));

// The window listeners that wake a backing-off table; one connection at a time, so one remover.
let stopWake: (() => void) | null = null;
function clearWake() {
  stopWake?.();
  stopWake = null;
}
let outcomeTimer: ReturnType<typeof setTimeout> | null = null;

// Practice runs the ask-the-table offer here, as host.mjs does online (#363): a bot answers BOT_ANSWER_MS to twice that
// after the ask, and an offer nobody takes closes after OFFER_MS. The timers belong to the open offer.
const BOT_ANSWER_MS = 1000;
const OFFER_MS = 20000;
// People first (#850), as host.mjs: a bot's Yes waits this long, or until every person asked has said No.
const PEOPLE_FIRST_MS = 8000;
let offerTimers: ReturnType<typeof setTimeout>[] = [];
let peopleUntil = 0;
// Bots that said Yes inside the people-first window, in the order they said it.
let heldYes: string[] = [];
let offerSeq = 0;
// `${turn}:${bot}` of the last bot turn that had its one chance to ask the table.
let botAsked = "";
// The last proposal every bot was explicitly declined, keyed only by bot and named goods.
let botDeclined = new Map<string, { give: Bag; want: Bag }>();
function clearOfferTimers() {
  for (const t of offerTimers) clearTimeout(t);
  offerTimers = [];
  heldYes = [];
}

export type Screen = "title" | "lobby" | "play";

interface GameStore {
  screen: Screen;
  name: string;
  // null until the player picks a swatch; see savedColor().
  color: string | null;
  mode: "ai" | "hotseat" | "online";
  serverSha: string | null;
  table: string;
  localId: string;
  host: boolean;
  state: GameState | null;
  error: string | null;
  // Bumped on every refused move, so the same error twice is announced twice (#380).
  errorSeq: number;
  // Said to a screen reader (and sounded) without a line on screen: a short build's tap is answered by its chip (#535).
  announcement: string | null;
  buildMode: BuildMode;
  // Edges picked so far for a path fortune (buildMode "roadCard"); sent together as one playRoad.
  roadPicks: string[];
  howTo: boolean;
  /** The element that opened How to play; Safari does not focus buttons on click, so activeElement cannot be trusted. */
  howToOpener: HTMLElement | null;
  // The Costs card (the building-costs card that comes with the board game), opened from the Table menu.
  costs: boolean;
  costsOpener: HTMLElement | null;
  toast: string | null;
  // One line everyone reads for a moment: the roll and who got what, or an award changing hands (#188).
  banner: string | null;
  // While typing the name may be empty; commitName (host, join, play, blur) trims it and falls back to "Ember".
  setName: (n: string) => void;
  commitName: () => string;
  setColor: (c: string) => void;
  setHowTo: (v: boolean, opener?: HTMLElement | null) => void;
  setCosts: (v: boolean, opener?: HTMLElement | null) => void;
  setBuildMode: (m: BuildMode) => void;
  wayfarerChoices: Partial<Record<"ai" | "online" | "hotseat", WayfarerMode>>;
  setWayfarerChoice: (context: "ai" | "online" | "hotseat", mode: WayfarerMode) => void;
  tableWayfarerMode: WayfarerMode;
  startAi: () => void;
  startHotseat: (count: number) => void;
  loadState: (s: GameState, localId: string, host: boolean, table?: string) => void;
  // True from page load while a saved seat at a table in play is being reclaimed: the loading screen shows, not the title.
  restoring: boolean;
  goTitle: () => void;
  dispatch: (action: Action, asId?: string, automated?: boolean) => { ok: boolean; state?: GameState; error?: string };
  runBots: () => void;
  pickHex: (id: string) => void;
  pickVertex: (id: string) => void;
  pickEdge: (id: string) => void;
  // Coarse pointers pick a mark first and confirm it with the Place chip (docs/design/mobile-camera-touch.md).
  pendingPlace: { kind: "hex" | "vertex" | "edge"; id: string } | null;
  setPendingPlace: (p: { kind: "hex" | "vertex" | "edge"; id: string } | null) => void;
  confirmPlace: () => void;
  // A refused action says why (the status line, the screen reader, the error cue).
  refuse: (message: string) => void;
  // The same cue and announcement as `refuse`, with no line on the HUD: the caller shows the message itself.
  refuseQuietly: (message: string) => void;
  highlights: () => { vertices: string[]; edges: string[]; hexes: string[] };
  // Set when a robber/knight hex has 2+ steal targets and needs the player to pick one.
  pendingSteal: { hexId: string; kind: "moveRobber" | "playKnight"; targets: string[] } | null;
  chooseSteal: (playerId: string) => void;
  // Online table (docs/design/online-client.md)
  net: TableClient | null;
  // True when `net` is the pre-join peek connection (docs/design/color-peek.md), not a seated or rejoining one.
  peeking: boolean;
  connectionHealth: import("@/lib/net/table").ConnectionHealth;
  code: string;
  isHost: boolean;
  tableVictoryTarget: VictoryTarget;
  setVictoryTarget: (value: VictoryTarget) => void;
  seats: Seat[];
  legal: Legal | null;
  // The host's turn timer (#344): when it fires on this tab's clock, whose seat it is, and the host's own value
  // (`deadline`) that tells one window from the next. Null when none is armed.
  // `host` is the host's clock on the push that opened this window (0 when the push carried none).
  turnTimer: { at: number; player: string; deadline: number; host: number } | null;
  // The host clock minus this one, as best this tab has measured it (0 before any push). A push shows the skew less the time it
  // spent on the way, so the largest one seen is the closest. The final-countdown cues are timed from it, not from `at`.
  clockSkew: number;
  lobbyLog: string;
  hostTable: (visibility?: "open" | "private") => void;
  joinTable: (code: string) => void;
  // Ask which colors a lobby already holds, on a connection of its own, before the player joins.
  peekTable: (code: string) => void;
  // Watch a started table read-only (docs/design/spectator.md): no seat, no actions, no chat input, no rejoin.
  watchTable: (code: string) => void;
  // True from a `welcome {spectator:true}` until the Title; every seat-only action returns at once while it is set.
  spectator: boolean;
  // Bumped by the first game state after each welcome, in the same update that loads it (a join, a page-load rejoin or a
  // reconnect). The turn moment and gain lines take that state as their baseline and say nothing about it.
  synced: number;
  // A welcome has come and its first state has not: loadState bumps `synced`.
  resync: boolean;
  // How many spectators the table has, from `seats {watching}` (#347).
  watching: number;
  // Sit back down in the seat this browser held (localStorage), e.g. after a reload (#196).
  rejoinTable: () => boolean;
  setReady: (value: boolean) => void;
  // Lobby: change this seat's name (the host validates and answers with `seats`) and remember it for the title.
  renameSeat: (name: string) => void;
  // Lobby, host only: seat a bot, or take the bot at seat `id` away.
  addBot: () => void;
  removeBot: (id: string) => void;
  startTable: () => void;
  // A rematch (#266): online the host asks for it; hotseat deals it here, the last winner first.
  playAgain: () => void;
  // Table chat (docs/design/chat.md)
  // This tab's seat id (s0...), from welcome. localId is the player id once the game starts.
  seatId: string;
  chat: ChatLine[];
  reactions: Reaction[];
  chatOpen: boolean;
  unread: number;
  chatDraft: string;
  setChatOpen: (v: boolean) => void;
  setChatDraft: (v: string) => void;
  sendChat: (text: string) => void;
  // A soundboard tap: the host checks the id and the pace, and every seat hears it (README: sound).
  sendSound: (id: string) => void;
  sendReact: (emote: string, to?: string) => void;
  // The whole game log, for the dock (#305): the new lines of `state.log` after each local action, and the host's `log` messages online.
  gameLog: GameLogLine[];
  // The sea (docs/design/crystal-water.md): the player's saved Water choice (null lets the GPU probe decide), and what the
  // renderer actually shows.
  waterChoice: WaterPath | null;
  setWaterChoice: (v: WaterPath) => void;
  water: WaterStatus | null;
  // The camera in play, from the table menu, remembered like the water: the tilted diorama or the overhead board; null
  // until the player picks, which leaves the renderer's default (overhead on a portrait screen, the diorama otherwise).
  viewChoice: PlayView | null;
  // The view the renderer shows in play now, chosen or default.
  playView: PlayView;
  setViewChoice: (v: PlayView) => void;
  // Ask-the-table trades (docs/BUILD_BIBLE.md 4.4): the open offer, who has said No to it, and the asker's closing line.
  offer: OpenOffer | null;
  declined: string[];
  tradeOutcome: string | null;
  tradeTaker: string | null;
  tradeOpen: boolean;
  // Who opened the panel, so focus can go back there on close (Safari does not focus buttons on click, #302).
  tradeOpener: HTMLElement | null;
  setTradeOpen: (v: boolean, opener?: HTMLElement | null) => void;
  // #488: counts the commits that land a lazily loaded dock or panel after its flag above flipped, so the island measures
  // the hole it leaves once more (IslandCanvas keys its measure on chatOpen, tradeOpen and this). It only ever grows.
  chromeSeq: number;
  chromeLanded: () => void;
  askTable: (give: Bag, want: Bag) => void;
  answerTrade: (yes: boolean) => void;
  // The player whose action menu is open in the HUD rail or seat strip (docs/design/chat.md "The player action menu").
  menuFor: string | null;
  openMenu: (id: string | null) => void;
}

const CHAT_OPEN_KEY = "emberisle-chat-open";
// The table code and this seat's secret from the last welcome, so a reload or a new tab can rejoin (#196).
const SEAT_KEY = "emberisle-seat";

export function savedSeat(): { code: string; secret: string } | null {
  try {
    const raw = localStorage.getItem(SEAT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { code?: unknown; secret?: unknown };
    return typeof v.code === "string" && typeof v.secret === "string" ? { code: v.code, secret: v.secret } : null;
  } catch {
    return null;
  }
}

// The table code whose game this browser last saw in play (#543). A reload with a seat at that table goes to a branded
// loading screen and straight to the board: it never passes through the title or the lobby on the way.
const LIVE_KEY = "emberisle-seat-live";

function inPlayAtSavedSeat() {
  try {
    return savedSeat()?.code === localStorage.getItem(LIVE_KEY);
  } catch {
    return false;
  }
}

let liveCode = "";
function rememberLive(code: string) {
  if (code === liveCode) return;
  liveCode = code;
  try {
    localStorage.setItem(LIVE_KEY, code);
  } catch {
    // storage can be blocked; a reload then takes the lobby's way back
  }
}

function rememberSeat(seat: { code: string; secret: string } | null) {
  try {
    if (seat) localStorage.setItem(SEAT_KEY, JSON.stringify(seat));
    else {
      localStorage.removeItem(SEAT_KEY);
      localStorage.removeItem(LIVE_KEY);
      liveCode = "";
    }
  } catch {
    // storage can be blocked; the game still plays, it just cannot rejoin after a reload
  }
}

function savedChatOpen() {
  try {
    return localStorage.getItem(CHAT_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

// The host keeps 16 characters of a name (server/host.mjs seatName), so the title and the lobby stop there too.
const NAME_MAX = 16;
const NAME_KEY = "emberisle-name";
function savedName() {
  if (typeof window === "undefined") return "Ember";
  return localStorage.getItem(NAME_KEY) || "Ember";
}

// null (not a default swatch) until the player actively picks one, so a fresh tab sends no `color`
// in `hello` and the host's existing free-color assignment runs — otherwise two players who never
// touch the picker would both request the same default color and the second would be rejected.
function savedColor(): string | null {
  if (typeof window === "undefined") return null;
  const saved = localStorage.getItem("emberisle-color");
  return saved && (PLAYER_COLORS as readonly string[]).includes(saved) ? saved : null;
}

export const useGame = create<GameStore>((set, get) => ({
  screen: "title",
  name: savedName(),
  color: savedColor(),
  mode: "ai",
  serverSha: null,
  table: "",
  localId: "p0",
  host: true,
  state: null,
  error: null,
  announcement: null,
  errorSeq: 0,
  buildMode: "none",
  roadPicks: [],
  howTo: false,
  howToOpener: null,
  costs: false,
  costsOpener: null,
  toast: null,
  banner: null,
  net: null,
  peeking: false,
  connectionHealth: { status: "Offline", rtt: null },
  code: "",
  isHost: false,
  tableVictoryTarget: 10,
  seats: [],
  legal: null,
  turnTimer: null,
  clockSkew: 0,
  lobbyLog: "",
  spectator: false,
  synced: 0,
  resync: false,
  watching: 0,
  pendingSteal: null,
  seatId: "",
  chat: [],
  reactions: [],
  chatOpen: savedChatOpen(),
  unread: 0,
  chatDraft: "",
  gameLog: [],
  waterChoice: savedWater(),
  water: null,
  viewChoice: savedView(),
  playView: "diorama",
  offer: null,
  declined: [],
  tradeOutcome: null, tradeTaker: null,
  tradeOpen: false,
  tradeOpener: null,
  chromeSeq: 0,
  menuFor: null,
  setName: (n) => {
    const name = Array.from(n).slice(0, NAME_MAX).join("");
    if (name.trim() && typeof window !== "undefined") localStorage.setItem(NAME_KEY, name.trim());
    set({ name });
  },
  commitName: () => {
    const name = get().name.trim() || "Ember";
    if (typeof window !== "undefined") localStorage.setItem(NAME_KEY, name);
    set({ name });
    return name;
  },
  setColor: (c) => {
    if (typeof window !== "undefined") localStorage.setItem("emberisle-color", c);
    set({ color: c });
  },
  setHowTo: (v, opener) => set({ howTo: v, howToOpener: v ? (opener ?? null) : null }),
  setCosts: (v, opener) => set({ costs: v, costsOpener: v ? (opener ?? null) : null }),
  setBuildMode: (m) => set({ buildMode: m, roadPicks: [] }),
  wayfarerChoices: {},
  tableWayfarerMode: "on",
  setWayfarerChoice: (context, mode) => {
    if (get().screen === "title" && ["on", "off"].includes(mode)) set({ wayfarerChoices: { ...get().wayfarerChoices, [context]: mode } });
  },
  startAi: () => {
    stopEndMusic();
    // A table left dialing (a reload with a saved seat) must not pull a practice game back to the lobby.
    clearWake();
    clearKnocks();
    get().net?.close();
    // A new game owes nothing to the last one's offer or bot ask.
    clearOfferTimers();
    botAsked = "";
    botDeclined.clear();
    commits.reset();
    const name = get().commitName();
    const state = createGame({ humans: [{ name }], bots: 3, wayfarerMode: get().wayfarerChoices.ai ?? "on" });
    set({
      screen: "play",
      mode: "ai",
      host: true,
      localId: "p0",
      state,
      gameLog: stamp(state.log),
      error: null,
      announcement: null,
      toast: null,
      buildMode: "none",
      net: null,
      peeking: false,
      spectator: false,
      offer: null,
      declined: [],
      tradeOutcome: null, tradeTaker: null,
    });
    play("game_start");
  },
  startHotseat: (count) => {
    stopEndMusic();
    clearWake();
    clearKnocks();
    get().net?.close();
    clearOfferTimers();
    botAsked = "";
    botDeclined.clear();
    commits.reset();
    const humans = Array.from({ length: count }, (_, i) => ({
      name: i === 0 ? get().commitName() : `Seat ${i + 1}`,
    }));
    const state = createGame({ humans, bots: 0, wayfarerMode: get().wayfarerChoices.hotseat ?? "on" });
    set({
      screen: "play",
      mode: "hotseat",
      host: true,
      localId: "p0",
      state,
      gameLog: stamp(state.log),
      error: null,
      announcement: null,
      toast: null,
      buildMode: "none",
      net: null,
      peeking: false,
      spectator: false,
      offer: null,
      declined: [],
      tradeOutcome: null, tradeTaker: null,
    });
  },
  restoring: typeof window !== "undefined" && inPlayAtSavedSeat(),
  loadState: (s, localId, host, table) => {
    // A push that leaves the turn alone (a seat rejoining) keeps an open picker, with the host's fresh victims (#1110).
    const { pendingSteal: ps, state: was, legal } = get();
    const targets = ps && was && s.phase === was.phase && s.current === was.current ? (legal?.steal[ps.hexId] ?? []) : [];
    set({
      restoring: false,
      screen: "play",
      mode: "online",
      state: s,
      localId,
      host,
      table: table ?? get().table,
      error: null,
      announcement: null,
      pendingSteal: ps && targets.length > 1 ? { ...ps, targets } : null,
      resync: false,
      synced: get().resync ? get().synced + 1 : get().synced,
    });
  },
  goTitle: () => {
    stopEndMusic();
    // Leaving on purpose frees the seat; only a drop keeps it. A watcher never held one, and the saved seat may be another table's.
    if (!get().spectator) rememberSeat(null);
    clearWake();
    clearKnocks();
    clearOfferTimers();
    botAsked = "";
    botDeclined.clear();
    commits.reset();
    get().net?.close();
    set({
      screen: "title",
      serverSha: null,
      wayfarerChoices: {},
      state: null,
      error: null,
      announcement: null,
      buildMode: "none",
      net: null,
      peeking: false,
      seats: [],
      legal: null,
      turnTimer: null,
      code: "",
      spectator: false,
      watching: 0,
      pendingSteal: null,
      chat: [],
      reactions: [],
      unread: 0,
      chatDraft: "",
      gameLog: [],
      menuFor: null,
      lobbyLog: "",
      seatId: "",
      isHost: false,
      roadPicks: [],
      pendingPlace: null,
      toast: null,
      offer: null,
      declined: [],
      tradeOutcome: null, tradeTaker: null,
      tradeOpen: false,
      tradeOpener: null,
    });
  },
  dispatch: (action, asId, automated = false) => {
    const { state, localId, mode, net, spectator } = get();
    if (!state) return { ok: false, error: "No game." };
    if (spectator) return { ok: false, error: "Watching only." };
    if (mode === "online") {
      // The host is the rules; its next state message updates the board.
      if (!net?.act(action)) return { ok: false, error: "Not available online." };
      set({ buildMode: "none", roadPicks: [] });
      return { ok: true };
    }
    const actor = asId ?? (mode === "hotseat" ? state.current : localId);
    const res = applyAction(state, actor, action);
    if (res.error) {
      set({ announcement: null, error: res.error, toast: res.error, errorSeq: get().errorSeq + 1 });
      play("ui_error");
      return { ok: false, error: res.error };
    }
    const nextState = automated
      ? logBotAction(state, res.state, action, actor, state.players.find((p) => p.id === actor)?.name.replace(/ \(bot\)$/i, "") ?? actor)
      : res.state;
    set({ state: nextState, gameLog: appendLog(get().gameLog, newLog(state.log, nextState.log)), error: null, announcement: null, toast: null, buildMode: "none", roadPicks: [] });
    hear(state, nextState, localId, mode);
    // Read after the commit: the event cannot hold back or change this state.
    presentation.practice(state, nextState, actor, action, automated ? "bot" : "human");
    // An offer lives only while its asker still has the turn in `main` and still holds the offered goods (as host.mjs play).
    const open = get().offer;
    if (open) {
      const asker = nextState.players.find((p) => p.id === open.from);
      const turnOver = nextState.current !== open.from || nextState.phase !== "main";
      if (turnOver || RESOURCES.some((r) => (open.give[r] ?? 0) > (asker?.resources[r] ?? 0))) {
        endOffer(set, get, null);
        if (!turnOver) set({ gameLog: appendLog(get().gameLog, [`${asker?.name} spent the offered goods; the offer is withdrawn.`]) });
      }
    }
    const rollOff = rollOffLine(state, nextState);
    if (rollOff) {
      showBanner(set, rollOff);
    } else {
      const swing = awardLine(state, nextState) ?? takeMatchPointLine();
      if (swing) showBanner(set, swing);
    }
    return { ok: true, state: nextState };
  },
  runBots: () => {
    const { state, dispatch, mode } = get();
    // Online, the host runs the bots; a bot move sent as our own intent only draws "Not your turn."
    if (!state || mode === "online" || state.phase === "over") return;
    if (state.phase === "discard") {
      for (const p of state.players) {
        if (p.kind === "bot" && (state.discardNeeded[p.id] ?? 0) > 0) {
          const a = chooseBotAction(state, p.id);
          if (a) dispatch(a, p.id, true);
          return;
        }
      }
    }
    const cur = state.players.find((p) => p.id === state.current);
    if (cur?.kind !== "bot") return;
    // A bot's own ask is open: its turn waits for the answers, and the offer's close plays on (EmberisleApp re-runs this).
    const { offer } = get();
    if (offer?.from === cur.id) return;
    // Once per bot turn, before its other moves, the bot may ask the table (#363).
    if (state.phase === "main" && !offer && botAsked !== `${state.turn}:${cur.id}`) {
      botAsked = `${state.turn}:${cur.id}`;
      const ask = chooseTradeAsk(state, cur.id, botDeclined.get(cur.id));
      if (ask) return openOffer(set, get, cur.id, ask.give, ask.want);
    }
    const a = chooseBotAction(state, cur.id);
    if (a) dispatch(a, cur.id, true);
  },
  pickHex: (id) => {
    const { state, localId, mode, buildMode, legal, dispatch } = get();
    if (!state) return;
    const actor = mode === "hotseat" ? state.current : localId;
    const kind: "moveRobber" | "playKnight" | null =
      state.phase === "robber" && state.current === actor ? "moveRobber" : buildMode === "knight" ? "playKnight" : null;
    if (!kind) return;
    // Online, the host says whom each hex can rob. Offline, ask the rules the same question (#189).
    const targets = mode === "online" ? (legal?.steal[id] ?? []) : stealTargets(state, id, actor);
    if (targets.length > 1) {
      set({ pendingSteal: { hexId: id, kind, targets } });
      return;
    }
    set({ pendingSteal: null });
    const stealFrom = targets[0] ?? null;
    if (kind === "moveRobber") dispatch({ type: "moveRobber", hexId: id, stealFrom });
    else dispatch({ type: "playKnight", hexId: id, stealFrom });
  },
  pendingPlace: null,
  setPendingPlace: (p) => set({ pendingPlace: p }),
  refuse: (message) => {
    set({ announcement: null, error: message, toast: message, errorSeq: get().errorSeq + 1 });
    play("ui_error");
  },
  // `error` also draws the HUD's line, so the message goes to `announcement` and an earlier line is cleared: the newest word wins.
  refuseQuietly: (message) => {
    set({ error: null, announcement: message, errorSeq: get().errorSeq + 1 });
    play("ui_error");
  },
  confirmPlace: () => {
    const { pendingPlace: p, pickHex, pickVertex, pickEdge } = get();
    if (!p) return;
    set({ pendingPlace: null });
    if (p.kind === "hex") pickHex(p.id);
    if (p.kind === "vertex") pickVertex(p.id);
    if (p.kind === "edge") pickEdge(p.id);
  },
  chooseSteal: (playerId) => {
    const { pendingSteal, dispatch } = get();
    if (!pendingSteal) return;
    const { hexId, kind } = pendingSteal;
    if (kind === "moveRobber") dispatch({ type: "moveRobber", hexId, stealFrom: playerId });
    else dispatch({ type: "playKnight", hexId, stealFrom: playerId });
    set({ pendingSteal: null });
  },
  pickVertex: (id) => {
    const { state, localId, mode, buildMode, dispatch } = get();
    if (!state) return;
    const actor = mode === "hotseat" ? state.current : localId;
    if (state.phase === "setupSettle" && state.current === actor) {
      dispatch({ type: "setupSettle", vertexId: id });
      return;
    }
    if (buildMode === "outpost") dispatch({ type: "buildOutpost", vertexId: id });
    if (buildMode === "stronghold") dispatch({ type: "buildStronghold", vertexId: id });
  },
  pickEdge: (id) => {
    const { state, localId, mode, buildMode, roadPicks, dispatch } = get();
    if (!state) return;
    const actor = mode === "hotseat" ? state.current : localId;
    if (state.phase === "setupRoad" && state.current === actor) {
      dispatch({ type: "setupRoad", edgeId: id });
      return;
    }
    if (buildMode === "path") dispatch({ type: "buildPath", edgeId: id });
    if (buildMode === "roadCard") {
      // One pick at a time, each legal given the ones before it. Two picks play the card; one is
      // enough when no second path is legal or the stock is down to one (rules.ts playRoad).
      if (!legalRoads(withPaths(state, roadPicks, actor), actor, false).includes(id)) return;
      const picks = [...roadPicks, id];
      const me = state.players.find((p) => p.id === actor);
      const canPlaceMore = (me?.pathsLeft ?? 0) > picks.length && legalRoads(withPaths(state, picks, actor), actor, false).length > 0;
      if (picks.length < 2 && canPlaceMore) {
        set({ roadPicks: picks });
        return;
      }
      dispatch({ type: "playRoad", edgeIds: picks });
    }
  },
  highlights: () => {
    const { state, localId, mode, buildMode, legal, roadPicks } = get();
    if (!state) return { vertices: [], edges: [], hexes: [] };
    if (buildMode === "roadCard") {
      // Same rules online and offline: the client holds the whole board, and the host re-checks the play.
      const actor = mode === "hotseat" ? state.current : localId;
      return { vertices: [], edges: legalRoads(withPaths(state, roadPicks, actor), actor, false), hexes: [] };
    }
    if (mode === "online") {
      const l = legal;
      if (!l) return { vertices: [], edges: [], hexes: [] };
      if (state.phase === "setupSettle") return { vertices: l.outpost, edges: [], hexes: [] };
      if (state.phase === "setupRoad") return { vertices: [], edges: l.path, hexes: [] };
      if (state.phase === "robber") return { vertices: [], edges: [], hexes: l.wayfarer };
      if (buildMode === "knight") return { vertices: [], edges: [], hexes: state.hexes.filter((h) => h.id !== state.robberHex).map((h) => h.id) };
      if (buildMode === "outpost") return { vertices: l.outpost, edges: [], hexes: [] };
      if (buildMode === "stronghold") return { vertices: l.stronghold, edges: [], hexes: [] };
      if (buildMode === "path") return { vertices: [], edges: l.path, hexes: [] };
      return { vertices: [], edges: [], hexes: [] };
    }
    const actor = mode === "hotseat" ? state.current : localId;
    if (state.current !== actor && state.phase !== "discard") {
      return { vertices: [], edges: [], hexes: [] };
    }
    if (state.phase === "setupSettle") return { vertices: legalSettle(state, actor, true), edges: [], hexes: [] };
    if (state.phase === "setupRoad") return { vertices: [], edges: legalRoads(state, actor, true), hexes: [] };
    if (state.phase === "robber" || buildMode === "knight") {
      return { vertices: [], edges: [], hexes: state.hexes.filter((h) => h.id !== state.robberHex).map((h) => h.id) };
    }
    if (buildMode === "outpost") return { vertices: legalSettle(state, actor, false), edges: [], hexes: [] };
    if (buildMode === "stronghold") return { vertices: legalCities(state, actor), edges: [], hexes: [] };
    if (buildMode === "path") return { vertices: [], edges: legalRoads(state, actor, false), hexes: [] };
    return { vertices: [], edges: [], hexes: [] };
  },
  hostTable: (visibility) => {
    get().commitName();
    const wayfarerMode = get().wayfarerChoices.online ?? "on";
    connect(set, get, (t, me) => t.open(me, { wayfarerMode, visibility }));
  },
  joinTable: (code) => {
    get().commitName();
    // A color the peek showed taken at this table is sent as no color, so the host seats the first free one.
    const { code: peeked, seats, color } = get();
    const free = color && !(peeked === code.toUpperCase() && seats.some((s) => s.color === color));
    connect(set, get, (t, me) => t.join(code, { ...me, color: free ? me.color : undefined }));
  },
  peekTable: (code) => {
    const { screen, net, peeking } = get();
    if (screen !== "title") return;
    // A non-peek `net` is the page-load rejoin; a peek queued on it would reach a seated socket and come back "not ready".
    if (!net && stopWake && !peeking) return;
    if (net) return peeking ? net.peek(code) : undefined;
    connect(set, get, (t) => t.peek(code), "peek");
  },
  watchTable: (code) => connect(set, get, (t) => t.watch(code), "watch"),
  rejoinTable: () => {
    const seat = savedSeat();
    if (!seat) return false;
    connect(set, get, (t) => t.rejoin(seat.code, seat.secret), "quiet");
    return true;
  },
  setVictoryTarget: (value) => {
    if (!get().spectator) get().net?.setVictoryTarget(value);
  },
  setReady: (value) => {
    if (!get().spectator) get().net?.ready(value);
  },
  renameSeat: (n) => {
    if (get().spectator) return;
    const name = Array.from(n.trim()).slice(0, NAME_MAX).join("");
    if (!name) return;
    set({ name });
    if (typeof window !== "undefined") localStorage.setItem(NAME_KEY, name);
    get().net?.rename(name);
  },
  addBot: () => {
    if (!get().spectator) get().net?.addBot();
  },
  removeBot: (id) => {
    if (!get().spectator) get().net?.removeBot(id);
  },
  startTable: () => {
    if (!get().spectator) get().net?.start();
  },
  playAgain: () => {
    const { mode, state, net, spectator } = get();
    if (spectator) return;
    if (mode === "online") return net?.again();
    if (mode !== "hotseat" || state?.phase !== "over") return;
    const winner = state.players.find((p) => p.id === state.winner)!;
    const ordered = [winner, ...state.players.filter((p) => p !== winner)];
    const next = createGame({ humans: ordered.map((p) => ({ name: p.name })), bots: 0, winnerFirst: true, wayfarerMode: state.wayfarerMode ?? "on" });
    commits.reset();
    set({
      state: next,
      localId: "p0",
      gameLog: appendLog(get().gameLog, next.log),
      error: null,
      announcement: null,
      toast: null,
      buildMode: "none",
      roadPicks: [],
      pendingPlace: null,
      pendingSteal: null,
      tradeOpen: false,
    });
  },
  setChatOpen: (v) => {
    try {
      localStorage.setItem(CHAT_OPEN_KEY, v ? "1" : "0");
    } catch {
      // storage can be blocked; the dock still works for this page
    }
    set(v ? { chatOpen: true, unread: 0 } : { chatOpen: false });
  },
  setChatDraft: (v) => set({ chatDraft: v }),
  setWaterChoice: (v) => {
    try {
      localStorage.setItem(WATER_KEY, v);
    } catch {
      // storage can be blocked; the choice still holds for this page
    }
    set({ waterChoice: v });
  },
  setViewChoice: (v) => {
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // storage can be blocked; the choice still holds for this page
    }
    set({ viewChoice: v });
  },
  sendChat: (text) => {
    const { spectator, net } = get();
    if (spectator || !net) return;
    net.say(text);
    play("chat_send");
  },
  sendSound: (id) => {
    const { spectator, net } = get();
    if (spectator || !net) return;
    net.sound(id);
  },
  sendReact: (emote, to) => {
    if (!get().spectator) get().net?.react(emote, to);
  },
  setTradeOpen: (v, opener) => set({ tradeOpen: v, tradeOpener: v ? (opener ?? null) : null }),
  chromeLanded: () => set({ chromeSeq: get().chromeSeq + 1 }),
  askTable: (give, want) => {
    const { mode, state, localId, spectator, net } = get();
    set({ tradeOpen: false });
    if (spectator) return;
    if (mode === "online") return net?.ask(give, want);
    // Practice: the store is the host, so it refuses what host.mjs `ask` refuses.
    const me = state?.players.find((p) => p.id === localId);
    const error =
      state?.phase !== "main" || state.current !== localId
        ? "Not your turn."
        : RESOURCES.some((r) => (give[r] ?? 0) > (me?.resources[r] ?? 0))
          ? "You lack those goods."
          : RESOURCES.every((r) => !give[r] && !want[r])
            ? "Offer something."
            : null;
    if (error) {
      set({ announcement: null, error, toast: error, errorSeq: get().errorSeq + 1 });
      play("ui_error");
      return;
    }
    openOffer(set, get, localId, give, want);
  },
  answerTrade: (yes) => {
    const { offer, net, spectator, mode, localId } = get();
    if (!offer || spectator) return;
    if (mode === "online") return net?.answer(offer.tradeId, yes);
    const error = respond(set, get, localId, yes);
    if (error) {
      set({ announcement: null, error, toast: error, errorSeq: get().errorSeq + 1 });
      play("ui_error");
    }
  },
  openMenu: (id) => {
    set({ menuFor: id });
  },
}));

type Set = (partial: Partial<GameStore>) => void;
type Get = () => GameStore;

// The open offer is over, taken by `taker` or by nobody: the toast goes, and the asker reads the outcome for a moment.
function endOffer(set: Set, get: Get, taker: string | null) {
  const { offer, state, declined } = get();
  if (!offer) return;
  clearOfferTimers();
  const takerName = state?.players.find((p) => p.id === taker)?.name ?? "Someone";
  set({ offer: null, declined: [] });
  // Both parties hear a deal in full and the rest of the table softer; only the asker hears a No (#609).
  const me = get().localId;
  if (taker) play("trade_yes", me === taker || me === offer.from ? 1 : 0.5);
  else if (state?.players.every((p) => p.id === offer.from || declined.includes(p.id))) play("corn_no");
  else if (me === offer.from) play("trade_no");
  // Every receiver gets the resolved offer as one brief log line, with no response controls.
  if (outcomeTimer) clearTimeout(outcomeTimer);
  set({ tradeTaker: taker, tradeOutcome: taker ? `${takerName} takes it.` : "Nobody took it." });
  outcomeTimer = setTimeout(() => set({ tradeOutcome: null, tradeTaker: null }), BANNER_MS);
}

// Practice's table offer for `from`, closing any earlier one (host.mjs openOffer). Every other bot answers it after a delay.
function openOffer(set: Set, get: Get, from: string, give: Bag, want: Bag) {
  endOffer(set, get, null);
  const state = get().state!;
  const tradeId = `t${state.seq}-${++offerSeq}`;
  const fromName = state.players.find((p) => p.id === from)?.name ?? "Someone";
  set({ offer: { tradeId, from, fromName, give, want, until: Date.now() + OFFER_MS }, declined: [], tradeOutcome: null, tradeTaker: null });
  presentation.offer("practice", tradeId, from, give, want, controllerOf(state, from), state.seq);
  const me = get().localId;
  void tradeSounds.then(({ offerChime }) => offerChime(play, from, fromName, me, give, want));
  offerTimers.push(setTimeout(() => endOffer(set, get, null), OFFER_MS));
  for (const p of state.players) {
    if (p.kind !== "bot" || p.id === from) continue;
    const answer = () => {
      if (get().offer?.tradeId !== tradeId) return;
      const yes = shouldAcceptTrade(get().state!, p.id, { from, give, want });
      if (yes && peopleWaiting(get)) heldYes.push(p.id);
      else respond(set, get, p.id, yes);
    };
    offerTimers.push(setTimeout(answer, BOT_ANSWER_MS + Math.floor(Math.random() * (BOT_ANSWER_MS + 1))));
  }
  peopleUntil = Date.now() + PEOPLE_FIRST_MS;
  offerTimers.push(setTimeout(() => releaseHeld(set, get), PEOPLE_FIRST_MS));
}

function peopleWaiting(get: Get) {
  const { offer, state, declined } = get();
  if (!offer || !state || Date.now() >= peopleUntil) return false;
  return state.players.some((p) => p.kind !== "bot" && p.id !== offer.from && !declined.includes(p.id));
}

// The first bot to say Yes still takes it (host.mjs releaseHeld).
function releaseHeld(set: Set, get: Get) {
  for (const id of heldYes.splice(0)) {
    if (!get().offer) return;
    respond(set, get, id, true);
  }
}

// `actor`'s Yes or No to practice's open offer, from the person or a bot (host.mjs respond). Returns an error, if any.
function respond(set: Set, get: Get, actor: string, yes: boolean): string | null {
  const { offer, state, declined, gameLog } = get();
  if (!offer || !state || actor === offer.from) return "Offer is gone.";
  if (!yes) {
    // A No is told to the table; the offer closes once every other seat, person or bot, has declined.
    if (declined.includes(actor)) return null;
    const now = [...declined, actor];
    set({ declined: now, gameLog: appendLog(gameLog, [`${state.players.find((p) => p.id === actor)?.name} declines.`]) });
    if (state.players.every((p) => p.id === offer.from || now.includes(p.id))) {
      if (state.players.find((p) => p.id === offer.from)?.kind === "bot") {
        botDeclined.set(offer.from, { give: offer.give, want: offer.want });
      }
      endOffer(set, get, null);
    } else if (!peopleWaiting(get)) releaseHeld(set, get);
    return null;
  }
  const offered = applyAction(state, offer.from, { type: "offerTrade", to: actor, give: offer.give, want: offer.want });
  // Every offerTrade refusal is the asker's (wrong phase, short of the goods), so the offer is dead for the whole table.
  if (offered.error) {
    endOffer(set, get, null);
    return "Offer is gone.";
  }
  const accepted = applyAction(offered.state, actor, { type: "respondTrade", accept: true });
  if (accepted.error) return accepted.error;
  const tradeLines = newLog(state.log, accepted.state.log).filter((line) => !line.includes(" offers a trade to "));
  set({ state: { ...accepted.state, log: [...state.log, ...tradeLines].slice(-200) }, gameLog: appendLog(gameLog, tradeLines) });
  presentation.trade("practice", offer.tradeId, offer.from, actor, offer.give, offer.want, controllerOf(state, offer.from), accepted.state.seq);
  endOffer(set, get, actor);
  return null;
}

// "quiet" is the automatic rejoin on page load: until the first welcome, a dead seat is dropped without telling the player.
// "peek" asks a lobby for its seats before joining (docs/design/color-peek.md): it never seats, toasts, or touches the saved seat.
// "watch" is a spectator (docs/design/spectator.md): no seat and no secret, so a drop never redials and must not erase a
// seat this browser saved for another table.
type ConnectKind = "normal" | "quiet" | "peek" | "watch";
async function connect(set: Set, get: Get, first: (t: TableClient, me: Me) => void, kind: ConnectKind = "normal") {
  clearWake();
  // Not a leave: a rejoin after a crash dials the same seat, which the host must still be holding.
  get().net?.close(false);
  const selectedHost = new URL(window.location.href);
  const selectedMe: Me = { name: get().name.trim() || "Ember", color: get().color ?? undefined };
  let cancelled = false;
  let removeListeners = () => {};
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  stopWake = () => { cancelled = true; clearTimeout(restoreTimer); removeListeners(); };
  // The original three-second fallback includes time spent fetching the client.
  if (kind === "quiet" && get().restoring) restoreTimer = setTimeout(() => !cancelled && get().restoring && set({ restoring: false }), 3000);
  set({ serverSha: null, net: null, peeking: kind === "peek", connectionHealth: { status: "Reconnecting", rtt: null } });
  const loadFailed = () => {
    if (cancelled) return;
    clearWake();
    const error = "Online play could not load. Try again.";
    set(kind === "peek" ? { peeking: false, connectionHealth: { status: "Offline", rtt: null } } : { restoring: false, error, toast: error, connectionHealth: { status: "Offline", rtt: null } });
  };
  let transport;
  try { transport = await tableModule.load(); } catch { loadFailed(); return; }
  if (cancelled) return;
  const { connectTable, hostUrl } = transport;
  let pending = kind === "quiet";
  let recovery = pending;
  let welcomed = false;
  let outdated: string | null = null;
  let firstState = false;
  let table: TableClient;
  try { table = connectTable(hostUrl(selectedHost), {
    health: (connectionHealth) => {
      if (recovery && (get().restoring || get().state !== null) && connectionHealth.status === "Reachable") return;
      set({ connectionHealth });
    },
    welcome: ({ proto, serverSha, code, you, host, chat, secret, spectator, victoryTarget, wayfarerMode }) => {
      pending = false;
      welcomed = true;
      firstState = true;
      // G2: a host on a newer wire protocol than this page says so where errors go, and keeps saying it after every state.
      outdated = (proto ?? 0) > PROTO ? "This page is out of date. Reload to update." : null;
      set({ serverSha: typeof serverSha === "string" && /^(?:[a-f0-9]{7,40}|dev)$/.test(serverSha) ? serverSha : null, resync: true, tableVictoryTarget: victoryTarget === 7 ? 7 : 10, tableWayfarerMode: wayfarerMode ?? "on" });
      if (secret) rememberSeat({ code, secret });
      // A page-load rejoin has no state yet, so it passes through the lobby until the host's state push moves it to play.
      // A mid-game reconnect already holds the game: stay on the board so the HUD keeps its local state.
      const inGame = get().state !== null && get().screen === "play";
      // Chat and game-log lines sort together by this browser's clock, never the host's (#305): the history keeps the
      // stamps of the lines this tab already held, and the rest arrive now, before any log line that follows.
      const known = new Map(get().chat.map((l) => [l.id, l.at]));
      const now = Date.now();
      const history = (chat ?? []).slice(-50).map((l) => ({ ...l, at: known.get(l.id) ?? now }));
      if (spectator) {
        // No lobby for a watcher: the host's first `state`, which follows at once, moves it to the board.
        set({ announcement: null, code, spectator: true, seatId: "", isHost: false, mode: "online", error: outdated, toast: outdated, chat: history, reactions: [], unread: 0 });
        return;
      }
      // A reload at a table that was in play (#543) waits on the loading screen for the state that follows at once, not the
      // lobby; if none comes (the table was reset meanwhile), the lobby is where the seat belongs.
      const restoring = get().restoring;
      // A recovered lobby has no full game state to recover. Its later Start is a new game.
      if (!inGame && !restoring) recovery = false;
      if (restoring)
        setTimeout(() => {
          if (!get().restoring || get().net !== table) return;
          // The lobby is where this seat belongs now; a later reload has no game to wait for, so it skips the splash.
          try {
            localStorage.removeItem(LIVE_KEY);
          } catch {
            // storage can be blocked
          }
          liveCode = "";
          recovery = false;
          set({ restoring: false, screen: "lobby" });
        }, 1500);
      set({ announcement: null, code, spectator: false, seatId: you ?? "", isHost: host ?? false, screen: restoring ? "title" : inGame ? "play" : "lobby", mode: "online", error: outdated, toast: outdated, chat: history, reactions: [], unread: 0 });
    },
    // The window may have closed while we were away; the next state brings it back rather than a chip stuck at 0:00.
    reconnecting: (attempt) => {
      recovery = true;
      firstState = true;
      set({ announcement: null, error: `Reconnecting… (try ${attempt})`, toast: "Reconnecting…", turnTimer: null });
    },
    chat: (line) => {
      const { chat, chatOpen, unread, seatId, screen } = get();
      // The lobby box is always open, so only lines that arrive during the game can be unread.
      const counts = screen === "play" && !chatOpen && line.seat !== seatId;
      set({ chat: [...chat, { ...line, at: Date.now() }].slice(-50), unread: counts ? unread + 1 : unread });
      // Others' lines tick; the sender's echo does not, and nothing ticks under the hands of someone typing in the chat (#609).
      // A soundboard line plays its clip for everyone, the sender too; it is not also a tick.
      // A muted seat's soundboard taps are as silent here as its chat line is hidden.
      if (line.sound) {
        const clip = line.sound.replace(/^(bong|plop|pluck)$/, "board_$1") as SoundName;
        if (!readMutedSeats(get().code).includes(line.seat)) play(clip);
      } else if (line.seat !== seatId && document.activeElement?.id !== "chat-input") play("chat_recv");
    },
    react: (r) => {
      set({ reactions: [...get().reactions, r] });
      setTimeout(() => set({ reactions: get().reactions.filter((x) => x !== r) }), 2000);
    },
    // A peek answers id/color/ready only (G10); the lobby is not shown until the full broadcast after sitting replaces it.
    seats: ({ code, seats, watching, victoryTarget, wayfarerMode }) => {
      const before = get().seats;
      const after = seats as Seat[];
      const me = get().localId;
      void tradeSounds.then(({ diggerBell }) => diggerBell(play, before, after, me));
      set({ code, seats: seats as Seat[], watching: watching ?? 0, tableVictoryTarget: victoryTarget === 7 ? 7 : 10, tableWayfarerMode: wayfarerMode ?? "on" });
    },
    // Dice and gain floats present the roll; its words live only in the persistent log.
    rolled: () => {},
    state: ({ you, game, legal, turnDeadline, turnPlayer, serverNow }) => {
      // A watcher's `you` is null: "" matches no player, so nothing is ever its turn and the your-turn chime never fires.
      const me = you ?? "";
      const rollOff = rollOffLine(get().state, game);
      // hear first: it is what claims a match point, and the banner line is read off that claim on this same state.
      hear(get().state, game, me, "online", firstState);
      // A welcome's first state is a silent baseline for the bot moments.
      commits.state(game, firstState);
      const swing = awardLine(get().state, game) ?? takeMatchPointLine();
      // The deadline moves onto this clock by the skew the message shows, so a phone minutes off still counts true.
      // Every push carries the same window, and the skew wobbles by however long this tab took to get to the message:
      // the timer we hold stays while the host's deadline is the same, so the chip neither remounts nor announces twice.
      const skew = typeof serverNow === "number" ? serverNow - Date.now() : 0;
      const prev = get().turnTimer;
      // A new connection starts the estimate over: a rejoin may reach a different host clock.
      const clockSkew = firstState ? skew : Math.max(skew, get().clockSkew);
      firstState = false;
      const turnTimer = !turnDeadline || !turnPlayer ? null : prev?.deadline === turnDeadline && prev.player === turnPlayer ? prev : { at: turnDeadline - skew, player: turnPlayer, deadline: turnDeadline, host: serverNow as number };
      // The first state after a join or a page-load rejoin seeds the log with what the engine kept, the way practice does.
      set({ legal, turnTimer, clockSkew, gameLog: get().state ? get().gameLog : appendLog(get().gameLog, game.log) });
      // A rematch's new game (#266): drop any half-made move or open panel left over from the win.
      if (get().state?.phase === "over" && game.phase !== "over") set({ buildMode: "none", roadPicks: [], pendingPlace: null, tradeOpen: false });
      get().loadState(game, me, get().isHost, get().code);
      if (recovery && !get().spectator) {
        recovery = false;
        set({ announcement: "Back at the table", toast: "Back at the table", connectionHealth: { status: "Reachable", rtt: get().connectionHealth.rtt } });
      }
      if (!get().spectator) rememberLive(get().code);
      if (outdated) set({ announcement: null, error: outdated, toast: outdated });
      if (rollOff) showBanner(set, rollOff);
      else if (swing) showBanner(set, swing);
    },
    log: (text) => set({ lobbyLog: text, gameLog: appendLog(get().gameLog, [text]) }),
    tradeOffer: ({ tradeId, from, give, want, seconds }) => {
      const fromName = get().state?.players.find((p) => p.id === from)?.name ?? "Someone";
      set({ offer: { tradeId, from, fromName, give, want, until: Date.now() + seconds * 1000 }, declined: [], tradeOutcome: null, tradeTaker: null });
      commits.offer({ tradeId, from, give, want });
      const me = get().localId;
      void tradeSounds.then(({ offerChime }) => offerChime(play, from, fromName, me, give, want));
    },
    tradeDeclined: ({ tradeId, by }) => {
      const { offer, declined } = get();
      if (offer?.tradeId === tradeId && !declined.includes(by)) set({ declined: [...declined, by] });
    },
    tradeClosed: ({ tradeId, taker }) => {
      commits.closed({ tradeId, taker });
      if (get().offer?.tradeId === tradeId) endOffer(set, get, taker ?? null);
    },
    error: (message) => {
      if (!pending && kind !== "peek") {
        set({ announcement: null, error: message, toast: message, errorSeq: get().errorSeq + 1 });
        play("ui_error");
      }
      // A refused join leaves an unseated socket the host never closes; drop it so the next peek can open its own.
      if ((kind === "normal" || kind === "watch") && !welcomed) {
        clearWake();
        table.close();
        if (get().net === table) set({ net: null, peeking: false });
      }
    },
    closed: (keepSeat) => {
      clearWake();
      if (kind === "peek") {
        if (get().net === table) set({ net: null, peeking: false });
        return;
      }
      if (keepSeat) {
        stopEndMusic();

        set({ announcement: null, restoring: false, error: "Your seat is open in another tab", toast: "Your seat is open in another tab", screen: "title", net: null, peeking: false, seats: [], code: "", state: null });
        return;
      }
      if (kind === "watch") {
        // A watcher holds nothing worth saving, and the seat secret in localStorage may belong to another table.
        stopEndMusic();

        set({ announcement: null, error: "Lost the table", toast: "Lost the table", screen: "title", net: null, peeking: false, seats: [], code: "", state: null, spectator: false, watching: 0 });
        return;
      }
      rememberSeat(null);
      if (pending) {
        const gone = get().restoring ? "Seat is gone." : null;
        stopEndMusic();

        set({ announcement: null, restoring: false, error: gone, toast: gone, screen: "title", net: null, peeking: false, seats: [], code: "", state: null });
        return;
      }
      stopEndMusic();

      set({ announcement: null, error: "Lost the table", toast: "Lost the table", screen: "title", net: null, peeking: false, seats: [], code: "", state: null });
    },
  });
  } catch { loadFailed(); return; }
  // A peek is not the player's action, so it leaves a join error ("Lost the table") on the Title card.
  set(kind === "peek" ? { net: table, peeking: true, mode: "online" } : { net: table, peeking: false, mode: "online", error: null, announcement: null });
  if (kind !== "peek") {
    const online = () => table.wake();
    const visible = () => {
      if (document.visibilityState === "visible") table.wake();
    };
    window.addEventListener("online", online);
    window.addEventListener("visibilitychange", visible);
    removeListeners = () => {
      window.removeEventListener("online", online);
      window.removeEventListener("visibilitychange", visible);
    };
  }
  first(table, selectedMe);
}
