// The table chat dock and the shared chat box. Design: docs/design/chat.md, and Chat C (#899, docs/design/chat-c/README.md):
// one chat button opens one panel with two tabs, Chat (the log, the six emoji, the composer) and Sounds & stickers.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MessageSquare, Volume2, VolumeX } from "lucide-react";
import { EmojiRow, Emote, setTab, SoundsTab, useMutedSeats, useTalk, type ChatTab, type ReactLine } from "@/components/game/talk";
import { useGame, type GameLogLine } from "@/lib/game/store";
import type { ChatLine } from "@/lib/net/table";
import { LazyBoundary } from "@/lib/lazy";
import { cn } from "@/lib/utils";
import { useViewport } from "@/lib/viewport";

export { SeatBubbles } from "@/components/game/talk";

const INPUT_ID = "chat-input";
// A chat line is 14 px text at leading-snug (about 20 px) plus the 4 px gap between lines.
const LINE_PX = 22;
// The Open chat button sets this before the dock opens, and the dock focuses the input once it has (the two are separate components).
const focusNext = { current: false };
// Set when the dock is minimized from inside, so the Open chat button that replaces it takes focus (not <body>).
const focusOpenButton = { current: false };
const minimizeChat = () => {
  focusOpenButton.current = true;
  useGame.getState().setChatOpen(false);
};

// Text renders only as React children. The mention is found with split() on the literal "@name", never a regex.
function Mention({ text, name }: { text: string; name: string }) {
  const parts = text.split(`@${name}`);
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 ? <mark className="rounded bg-accent/25 px-0.5 text-inherit">{`@${name}`}</mark> : null}
          {part}
        </span>
      ))}
    </>
  );
}

// A watcher has no name at the table (docs/design/spectator.md), so nothing is a mention of it.
function useMyName() {
  return useGame((s) => (s.spectator ? "" : (s.seats.find((x) => x.id === s.seatId)?.name ?? s.name)));
}

function Line({ line, me }: { line: ChatLine; me: string }) {
  // A soundboard tap is a light line: the speaker mark and the chip's label, not the "🔊" text the host sends.
  if (line.sound) {
    return (
      <li data-testid="sound-line" className="flex items-center break-words text-sm leading-snug text-zinc-700">
        <span className="mr-1 inline-block size-2 shrink-0 rounded-full" style={{ background: line.color }} />
        <span className="mr-1 font-medium">{line.name}</span>
        <Volume2 aria-hidden="true" className="mr-0.5 size-3.5 shrink-0" />
        {line.text.replace(/^🔊\s*/, "")}
      </li>
    );
  }
  return (
    <li className="break-words text-sm leading-snug text-zinc-900">
      <span className="mr-1 inline-block size-2 rounded-full align-baseline" style={{ background: line.color }} />
      <span className="mr-1 font-medium text-zinc-700">
        {line.name}
      </span>
      {me ? <Mention text={line.text} name={me} /> : line.text}
    </li>
  );
}

// An emote or sticker as a light log line; repeats in a row from the same seat read "×n", as the seat bubble does.
function ReactRow({ line, count }: { line: ReactLine; count: number }) {
  return (
    <li data-testid="react-line" data-emote={line.emote} className="flex items-center text-sm leading-snug text-zinc-700">
      <span className="mr-1 inline-block size-2 shrink-0 rounded-full" style={{ background: line.color }} />
      <span className="mr-1 font-medium">{line.name}</span>
      <Emote emote={line.emote} className="inline-flex size-5 shrink-0 items-center justify-center text-base leading-none" />
      {count > 1 ? <span className="ml-1 text-caption font-semibold tabular-nums">×{count}</span> : null}
    </li>
  );
}

const TABS: [ChatTab, string, typeof MessageSquare][] = [
  ["chat", "Chat", MessageSquare],
  ["sounds", "Sounds & stickers", Volume2],
];

// The panel's two tabs (at most two, README), then the dock's own actions (Mute, Minimize) at the right.
function Tabs({ actions, testid, dense, narrow }: { actions?: ReactNode; testid?: string; dense?: boolean; narrow?: boolean }) {
  const tab = useTalk((s) => s.tab);
  return (
    <div data-testid={testid} className="flex shrink-0 items-center gap-1">
      <div role="tablist" aria-label="Chat panel" className="flex min-w-0 flex-1 gap-1">
        {TABS.map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`chat-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="chat-tabpanel"
            onClick={() => setTab(id)}
            className={cn(
              dense ? "h-8" : "h-11",
              "flex min-w-0 cursor-pointer items-center gap-1 rounded-control bg-glass px-1.5 text-sm text-zinc-700 hover:text-zinc-900",
              id === "chat" && "shrink-0",
              tab === id && "font-semibold text-zinc-900 underline underline-offset-4",
            )}
          >
            {narrow ? null : <Icon aria-hidden="true" className="size-4 shrink-0" />}
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>
      {actions}
    </div>
  );
}

// The main-phase roll line rules.ts writes: "<name> rolled <sum>!", sums 2 to 12 (the roll-off's "rolls a N." is another line).
const ROLL_LINE = /^(.+) rolled (1[0-2]|[2-9])!$/;

// A game log line (#305): a muted system row, no speaker. A roll line (#687) has its sum in the number tokens' red on 6 and 8,
// and your own roll in green with the name bold, so it does not rest on colour alone. Only the online table lists the log (the dock),
// and a watcher has no seat, so no roll is its own. `mine` is this seat's player name ("" for a watcher), worked out once by the
// list that renders the rows, so no row subscribes to the store.
function LogRow({ line, mine }: { line: GameLogLine; mine: string }) {
  const roll = ROLL_LINE.exec(line.text);
  if (roll) {
    const own = mine !== "" && roll[1] === mine;
    const sum = Number(roll[2]);
    return (
      <li data-testid="log-row" data-roll={sum} data-own={own ? "true" : undefined} className={cn("break-words text-sm leading-snug", own ? "text-gain" : "text-zinc-700")}>
        <span data-testid="log-roll-name" className={own ? "font-bold" : undefined}>{roll[1]}</span> rolled{" "}
        <span data-testid="log-roll-sum" className={sum === 6 || sum === 8 ? "text-danger" : undefined}>{sum}</span>!
      </li>
    );
  }
  return (
    <li data-testid="log-row" className="break-words text-sm leading-snug text-zinc-700">
      {line.text}
    </li>
  );
}

// The panel: the two tabs, then the Chat tab (the log, the six emoji and the input) or the Sounds & stickers tab.
// `onEscape` is the dock's minimize; `actions` are the dock's Mute and Minimize, in the tab row.
// `game` (the in-game dock, not the Lobby) always lists the game log in with the chat (#899: no filter; Copy log is in the Table menu).
// `minRows`: the log keeps at least that many lines, whatever else is squeezed (the page scrolls instead).
export function ChatBox({ rows, minRows = 0, game, dense, narrow, onEscape, actions, headerTestId, className }: { rows: number; minRows?: number; game?: boolean; dense?: boolean; narrow?: boolean; onEscape?: () => void; actions?: ReactNode; headerTestId?: string; className?: string }) {
  const chat = useGame((s) => s.chat);
  const gameLog = useGame((s) => s.gameLog);
  const code = useGame((s) => s.code);
  const draft = useGame((s) => s.chatDraft);
  const setDraft = useGame((s) => s.setChatDraft);
  const sendChat = useGame((s) => s.sendChat);
  const spectator = useGame((s) => s.spectator);
  // The local player's name at the table, for the roll rows' own-roll test (a watcher has none).
  const mine = useGame((s) => (s.spectator ? "" : (s.state?.players.find((p) => p.id === s.localId)?.name ?? "")));
  const reactLog = useTalk((s) => s.reactLog);
  // A watcher sends nothing, so it has the log alone: no tabs (docs/design/spectator.md).
  const tab = useTalk((s) => (spectator ? "chat" : s.tab));
  const { muted } = useMutedSeats(code);
  const me = useMyName();
  const log = useRef<HTMLUListElement>(null);
  const stuck = useRef(true);
  // Reflow at either dimension can scroll the log before its resize observer repins it.
  const pinnedSize = useRef({ width: 0, height: 0 });
  const withLog = game;
  const visibleChat = chat.filter((line) => !muted.has(line.seat));

  useEffect(() => {
    const el = log.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [chat, gameLog, reactLog, withLog, tab]);

  // A layout change (the sheet settling, the keyboard) resizes the log; the newest line stays in view unless the reader scrolled up.
  useEffect(() => {
    const el = log.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    pinnedSize.current = { width: el.clientWidth, height: el.clientHeight };
    const observer = new ResizeObserver(() => {
      pinnedSize.current = { width: el.clientWidth, height: el.clientHeight };
      if (stuck.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [tab]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    sendChat(text);
    setDraft("");
  };

  // Chat, reaction and game lines in the order this browser saw them (every `at` stamp is its own clock, store.ts). The
  // sort is stable, so each kind keeps its own order when stamps tie. Reactions in a row from one seat fold into one "×n" line.
  type Row = { at: number; node: ReactNode } | { at: number; react: ReactLine; count: number };
  const lines: Row[] = visibleChat.map((line) => ({ at: line.at, node: <Line key={`c${line.id}`} line={line} me={me} /> }));
  for (const line of reactLog) if (!muted.has(line.seat)) lines.push({ at: line.at, react: line, count: 1 });
  if (withLog) for (const [i, line] of gameLog.entries()) lines.push({ at: line.at, node: <LogRow key={`g${i}`} line={line} mine={mine} /> });
  lines.sort((x, y) => x.at - y.at);
  const rowsShown: Row[] = [];
  for (const row of lines) {
    const prev = rowsShown.at(-1);
    if ("react" in row && prev && "react" in prev && prev.react.seat === row.react.seat && prev.react.emote === row.react.emote) prev.count++;
    else rowsShown.push(row);
  }

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      {spectator ? (
        <div data-testid={headerTestId} className="flex shrink-0 items-center justify-between">
          <h2 className="text-sm font-medium">Table chat</h2>
          {actions}
        </div>
      ) : (
        <Tabs actions={actions} testid={headerTestId} dense={dense} narrow={narrow} />
      )}
      {tab === "sounds" ? (
        <div id="chat-tabpanel" role="tabpanel" aria-labelledby="chat-tab-sounds" className="flex min-h-0 flex-1 flex-col">
          <LazyBoundary failed={null}>
            <SoundsTab dense={dense} />
          </LazyBoundary>
        </div>
      ) : (
        <div id="chat-tabpanel" role={spectator ? undefined : "tabpanel"} aria-labelledby={spectator ? undefined : "chat-tab-chat"} className="flex min-h-0 flex-1 flex-col gap-2">
          <ul
            ref={log}
            data-testid="chat-log"
            role="log"
            aria-label="Chat"
            tabIndex={0}
            onScroll={(e) => {
              const el = e.currentTarget;
              if (el.clientWidth !== pinnedSize.current.width || el.clientHeight !== pinnedSize.current.height) return;
              stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
            }}
            className="flex min-h-0 flex-col gap-1 overflow-y-auto"
            style={{ height: rows * LINE_PX, minHeight: minRows * LINE_PX, flex: "1 1 auto" }}
          >
            {rowsShown.map((row) => ("react" in row ? <ReactRow key={`r${row.react.id}`} line={row.react} count={row.count} /> : row.node))}
          </ul>
          {spectator ? (
            // Read-only (docs/design/spectator.md): the log stays; the emoji and input are this one line.
            <p data-testid="chat-readonly" className="shrink-0 text-xs text-zinc-700">
              Watching — chat is read-only
            </p>
          ) : (
            <>
              <EmojiRow keys={game} dense={dense} />
              <div className="flex shrink-0 gap-1">
                <input
                  id={INPUT_ID}
                  value={draft}
                  maxLength={200}
                  placeholder="Say something…"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") send();
                    if (e.key === "Escape") {
                      e.currentTarget.blur();
                      onEscape?.();
                    }
                  }}
                  className="h-11 min-w-0 flex-1 rounded-control bg-glass px-2 text-sm text-zinc-900 placeholder:text-zinc-700"
                />
                <button
                  type="button"
                  onClick={send}
                  className="h-11 min-w-11 cursor-pointer rounded-control bg-fg px-3 text-sm font-medium text-bg hover:bg-fg/90"
                >
                  Send
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MuteMenu({ above = false }: { above?: boolean }) {
  const seats = useGame((s) => s.seats);
  const seatId = useGame((s) => s.seatId);
  const code = useGame((s) => s.code);
  const mode = useGame((s) => s.mode);
  const { muted, toggle } = useMutedSeats(code);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const targets = mode === "online" ? seats.filter((seat) => seat.id !== seatId && seat.name) : [];

  // Escape closes the panel and returns focus to its toggle; a press outside closes it too. The capture listener on `document`
  // runs after escape-disarm's window one (which stands down while the panel is in the DOM) and stops the key there, so the chat
  // input does not also minimize: the first Escape closes this layer and only the next one reaches the layer under it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      root.current?.querySelector<HTMLElement>('[data-testid="chat-mute-toggle"]')?.focus();
    };
    const onPress = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPress, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPress, true);
    };
  }, [open]);

  if (!targets.length) return null;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-testid="chat-mute-toggle"
        aria-label="Mute players"
        aria-expanded={open}
        aria-controls="chat-mute-panel"
        title="Mute players"
        onClick={() => setOpen((value) => !value)}
        className={cn("flex h-11 shrink-0 cursor-pointer items-center justify-center rounded-control bg-glass text-zinc-700 hover:text-zinc-900", above ? "w-11" : "w-10")}
      >
        {/* Icon only, so the two tabs fit beside it; its name and title say what it does. */}
        <VolumeX className="size-4" />
      </button>
      {open ? (
        <div
          id="chat-mute-panel"
          data-testid="chat-mute-panel"
          role="group"
          aria-label="Mute players"
          className={cn(
            "absolute right-0 z-40 flex max-h-[min(50vh,220px)] min-w-40 flex-col gap-1 overflow-y-auto rounded-chip bg-glass p-2 backdrop-blur-md",
            above ? "bottom-full mb-2" : "top-full mt-2",
          )}
        >
          {targets.map((seat) => {
            const isMuted = muted.has(seat.id);
            return (
              <button
                key={seat.id}
                type="button"
                data-testid={`chat-mute-seat-${seat.id}`}
                aria-label={`Mute player ${seat.name}`}
                aria-pressed={isMuted}
                onClick={() => toggle(seat.id)}
                className="h-11 shrink-0 cursor-pointer rounded-control bg-glass px-3 text-left text-sm text-zinc-700 hover:text-zinc-900"
              >
                {`Mute ${seat.name}`}
                {isMuted ? <span aria-hidden="true"> (muted)</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// The store's unread count, less the lines from seats this browser has muted (they are hidden in the chat too).
function useUnmutedUnread() {
  const unreadTotal = useGame((s) => s.unread);
  const open = useGame((s) => s.chatOpen);
  const chat = useGame((s) => s.chat);
  const seatId = useGame((s) => s.seatId);
  const code = useGame((s) => s.code);
  const { muted } = useMutedSeats(code);
  const [unreadBySeat, setUnreadBySeat] = useState<Map<string, number>>(() => new Map());
  const previousChat = useRef(chat);
  const unreadBySeatRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (open || unreadTotal === 0) {
      unreadBySeatRef.current.clear();
    } else {
      const previousIds = new Set(previousChat.current.map((line) => line.id));
      for (const line of chat) {
        if (!previousIds.has(line.id) && line.seat !== seatId) {
          unreadBySeatRef.current.set(line.seat, (unreadBySeatRef.current.get(line.seat) ?? 0) + 1);
        }
      }
    }
    previousChat.current = chat;
    setUnreadBySeat(new Map(unreadBySeatRef.current));
  }, [chat, open, seatId, unreadTotal]);
  return [...unreadBySeat].reduce((count, [seat, messages]) => count + (muted.has(seat) ? 0 : messages), 0);
}

// The two table buttons, in the top row beside the Table menu (Hud's header). They sit in that row's flow, so they keep the same
// 44 px place on every phone and turn, and the seat strip beside them in a sideways phone gives way to them.
export function ChatControls() {
  const mode = useGame((s) => s.mode);
  const open = useGame((s) => s.chatOpen);
  const unread = useUnmutedUnread();
  const setOpen = useGame((s) => s.setChatOpen);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open && focusOpenButton.current) {
      focusOpenButton.current = false;
      button.current?.focus();
    }
  }, [open, mode]);
  if (mode !== "online") return null;
  const openButton = (
    <button
      ref={button}
      type="button"
      aria-label={unread ? `Open chat, ${unread} unread` : "Open chat"}
      onClick={() => {
        focusNext.current = true;
        setOpen(true);
      }}
      className="pointer-events-auto relative flex size-11 cursor-pointer items-center justify-center rounded-control bg-glass text-zinc-700 backdrop-blur-md hover:text-zinc-900"
    >
      <MessageSquare className="size-5" />
      {unread > 0 ? (
        <span
          data-testid="chat-unread"
          className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-xs font-medium text-white"
        >
          {unread}
        </span>
      ) : null}
    </button>
  );

  // Chat C: this is the one button. The emoji, the sounds and the stickers are inside the panel it opens.
  return open ? null : openButton;
}

export function ChatDock() {
  const sheet = useRef<HTMLElement>(null);
  const choiceOpen = useGame((s) => (!!s.offer && !s.declined.includes(s.localId)) || !!s.pendingSteal);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const mode = useGame((s) => s.mode);
  const open = useGame((s) => s.chatOpen);
  const setOpen = useGame((s) => s.setChatOpen);
  const { phone } = useViewport();

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!phone || !open || !viewport) return;
    let last = -1;
    const update = () => {
      const inset = Math.max(0, Math.round(innerHeight - viewport.height - viewport.offsetTop));
      if (inset === last) return;
      last = inset;
      setKeyboardInset(inset);
      document.documentElement.style.setProperty("--keyboard-inset", `${inset}px`);
      useGame.getState().chromeLanded();
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--keyboard-inset");
      setKeyboardInset(0);
    };
  }, [phone, open]);

  useEffect(() => {
    const el = sheet.current;
    if (!phone || !open || !el) return;
    let settled: ReturnType<typeof setTimeout>;
    const fit = () => {
      clearTimeout(settled);
      // Rotation and keyboard resize land in several frames. Only a stable, unusable height minimizes chat.
      settled = setTimeout(() => {
        if (!el.isConnected) return;
        if (el.getBoundingClientRect().height < 128) setOpen(false);
      }, 1000);
    };
    window.addEventListener("resize", fit);
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => {
      window.removeEventListener("resize", fit);
      observer.disconnect();
      clearTimeout(settled);
    };
  }, [phone, open, setOpen]);

  // #899: the sheet normally leaves a 40 px band for the seat bubbles under the strip (styles.css --chat-sheet-height). While
  // the keyboard is up, or an offer or a steal prompt shares the screen, it gives that band back so the input and the choice
  // both still fit (and the usability guard above never minimizes the chat on a short phone).
  const tight = phone && open && (keyboardInset > 0 || choiceOpen);
  useEffect(() => {
    if (!tight) return;
    document.documentElement.style.setProperty("--chat-bubble-band", "0px");
    return () => {
      document.documentElement.style.removeProperty("--chat-bubble-band");
    };
  }, [tight]);

  // A remembered open dock must not cover the hand bar when Play starts on a phone. The stored value stays for desktop.
  useEffect(() => {
    if (phone) useGame.setState({ chatOpen: false });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || useGame.getState().mode !== "online") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("button, a, [role=button], [role=radio], input, select, textarea")) return;
      e.preventDefault();
      focusNext.current = true;
      useGame.getState().setChatOpen(true);
      document.getElementById(INPUT_ID)?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open && focusNext.current) {
      focusNext.current = false;
      document.getElementById(INPUT_ID)?.focus();
    }
  }, [open]);

  if (mode !== "online") return null;

  const minimize = (
    <button
      type="button"
      aria-label="Minimize chat"
      onClick={minimizeChat}
      className={cn("flex h-11 min-w-10 cursor-pointer items-center justify-center gap-1 rounded-control bg-glass text-zinc-700 hover:text-zinc-900", phone && open && "px-3 text-sm")}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-minus size-4" aria-hidden="true"><path d="M5 12h14" /></svg>
      {phone && open ? <span>Close</span> : null}
    </button>
  );
  // On a phone the open dock is a bottom sheet. The backdrop catches the tap that closes it, so that tap never reaches the board.
  if (phone && open) {
    return (
      <>
        <div data-testid="chat-backdrop" className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
        <section
          ref={sheet}
          aria-label="Table chat"
          data-testid="chat-sheet"
          data-keyboard-open={keyboardInset > 0 || undefined}
          data-choice-open={choiceOpen || undefined}
          className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2 rounded-t-sheet bg-glass px-safe pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-md"
          style={{ height: "var(--chat-sheet-height)", bottom: "var(--keyboard-inset, 0px)" }}
        >
          <ChatBox
            className="flex-1"
            rows={4}
            game
            onEscape={minimizeChat}
            headerTestId="chat-sheet-header"
            actions={
              <div className="flex shrink-0 items-center gap-1">
                <MuteMenu above={phone} />
                {minimize}
              </div>
            }
          />
        </section>
      </>
    );
  }

  // Closed, only the button shows, in the top row (ChatControls) with its unread badge; a new line bubbles at its sender's seat
  // instead (#899). Open, the panel sits at the top right, clear of the seat rail at the left. It is 300 px, inside the 312 px
  // right rail the island keeps clear (mobile-fit.ts), with 8 px sides so the six 44 px emoji fit; the tabs drop their icons.
  if (!open) return null;

  return (
    <div className={cn("absolute right-safe z-20", phone ? "bottom-[184px]" : "top-16")}>
      <section
        aria-label="Table chat"
        className="flex w-[18.75rem] max-w-[calc(100vw-1.5rem)] flex-col gap-2 rounded-chip bg-glass px-2 py-3 backdrop-blur-md"
        style={{ maxHeight: "min(360px, 50vh)" }}
      >
        <ChatBox
          rows={6}
          game
          narrow
          onEscape={minimizeChat}
          actions={
            <div className="flex shrink-0 items-center gap-1">
              <MuteMenu />
              {minimize}
            </div>
          }
        />
      </section>
    </div>
  );
}
