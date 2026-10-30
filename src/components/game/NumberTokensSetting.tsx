import { Button } from "@/components/ui/button";
import { useGame } from "@/lib/game/store";
import type { NumberTokens } from "@/lib/game/types";

// #1156: the table's number tokens in How to play, with what the choice means. The lobby host changes it there (the
// lobby's Rules button); guests, watchers and every seat in play (the table menu's How to play) read it. Local games
// always deal the official spiral. Loads with How to play, like the setup reference.
const TOKENS: Record<NumberTokens, [string, string]> = {
  official: ["Official spiral", "Numbers run in the official spiral from an outer corner, skipping the wastes."],
  random: ["Random", "Numbers are shuffled, and no 6 or 8 touches another 6 or 8."],
};

export function NumberTokensSetting() {
  const tokens = useGame((s) => (s.screen !== "title" && s.mode === "online" ? s.tableNumberTokens : "official"));
  const choose = useGame((s) => (s.screen === "lobby" && s.seats.find((x) => x.id === s.seatId)?.host ? s.setNumberTokens : null));
  return (
    <div data-testid="number-tokens" data-value={tokens} className="space-y-1">
      {choose ? (
        <div role="group" aria-label="Number tokens" aria-describedby="number-tokens-help" className="flex flex-wrap items-center gap-2">
          <span className="basis-full">Number tokens</span>
          {(["official", "random"] as const).map((v) => (
            <Button key={v} variant={tokens === v ? "default" : "secondary"} aria-pressed={tokens === v} className="h-11 px-3" onClick={() => choose(v)}>
              {TOKENS[v][0]}
            </Button>
          ))}
        </div>
      ) : (
        <p>Number tokens: {TOKENS[tokens][0]}.</p>
      )}
      <p id="number-tokens-help">{TOKENS[tokens][1]}</p>
    </div>
  );
}
