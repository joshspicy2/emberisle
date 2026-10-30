import { Suspense, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { wayfarerRules } from "@/lib/game/fortunes";
import { victoryTarget } from "@/lib/game/rules";
import { useGame } from "@/lib/game/store";
import { play } from "@/lib/sound";
import { NumberTokensSetting, SetupReference } from "@/components/game/chunks";
import { useViewport } from "@/lib/viewport";

// A modal dialog: focus goes to Close on open and back to whatever opened it on close; Escape closes it (see useEscapeDisarm for the order).
export function HowTo({ onClose }: { onClose: () => void }) {
  const phone = useViewport().phone;
  const mode = useGame(s => s.state?.wayfarerMode ?? "on");
  const target = useGame(s => s.state ? victoryTarget(s.state) : s.screen === "lobby" ? s.tableVictoryTarget : 10);  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    // Safari never focuses a button on click, so the opener comes from the store; activeElement is the fallback.
    const opener = useGame.getState().howToOpener ?? (document.activeElement as HTMLElement | null);
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])].filter(
          (el) => !el.hasAttribute("disabled"),
        );
        if (!items.length) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === -1 || i === items.length - 1 ? 0 : i + 1;
        e.preventDefault();
        items[next]!.focus();
      }
      if (e.key !== "Escape") return;
      e.stopPropagation();
      play("ui_back");
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="howto-title"
      ref={dialogRef}
      className="absolute inset-0 z-30 flex items-end justify-center bg-white/45 p-safe sm:items-center"
    >
      <div className="flex max-h-[80dvh] w-full max-w-md flex-col rounded-sheet border border-white/50 bg-surface">
        <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-1 pt-5">
          <h2 id="howto-title" className="font-display text-2xl">How to play</h2>
          <Button ref={closeRef} variant="ghost" size="icon" className={phone ? "size-11" : undefined} onClick={onClose} aria-label="Close" back>
            <X className="size-4" />
          </Button>
        </div>
        {/* Focusable so the keyboard can scroll it; Close stays above the scroll. */}
        <div
          role="region"
          aria-label="Rules and setup"
          tabIndex={0}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-sheet px-5 pb-5 pt-3 text-sm leading-relaxed text-zinc-600 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ink)]"
        >
          <p>Win at {target} points.</p>
          {/* #1156: the table's number tokens; the lobby host chooses here. */}
          <Suspense fallback={null}><NumberTokensSetting /></Suspense>
          <p>Each turn: roll. Matching numbers pay goods from tiles you touch. {wayfarerRules(mode)}</p>
          <p>Build paths (wood + brick), outposts (wood, brick, sheep, wheat), strongholds (three wheat, two stone). Fortunes cost sheep, wheat, stone.</p>
          <p>Outposts score 1, strongholds 2. Longest path of five and largest army of three wayfarer cards score 2 more. Docks cut bank trade to 3:1 or 2:1.</p>
          <p>Drag to orbit the isle. Tap glowing corners and paths to build.</p>
          <Suspense fallback={null}><SetupReference /></Suspense>
        </div>
      </div>
    </div>
  );
}
