import { useEffect } from "react";
import { useGame } from "@/lib/game/store";
import { play } from "@/lib/sound";

// Escape, topmost layer first. One press closes exactly one thing:
//   1. TableMenu (and its Leave question): window capture + stopPropagation (it closes whenever HowTo opens, so the two never stack).
//   2. HowTo and the Costs card: modal, so window capture + stopPropagation; nothing behind it hears the key.
//   3. TradePanel (window) and PlayerMenu (document), bubble phase, each closes itself; PlaceChip's pending tap (window) likewise.
//   4. (Was the quick-reaction picker; #899 moved reactions into the chat panel, whose input minimizes itself.)
//   4b. The chat Mute panel (#520): it closes itself on Escape (document capture, after this listener), so this stands down while it is open.
//   5. Disarming a build mode: window capture, but it stands down when 1-4 are open or the key came from a text field
//      (the chat box minimizes itself), because the layers above run later in the same event and must still see their own state.
export function useEscapeDisarm() {
  const setBuildMode = useGame((s) => s.setBuildMode);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const s = useGame.getState();
      if (s.buildMode === "none" || s.tradeOpen || s.menuFor || s.pendingPlace || s.howTo || s.costs) return;
      if ((e.target as HTMLElement | null)?.closest("input, select, textarea")) return;
      if (document.querySelector('[data-testid="table-menu"], [data-testid="chat-mute-panel"]')) return;
      play("ui_back");
      setBuildMode("none");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setBuildMode]);
}
