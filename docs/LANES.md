# Lanes

Take the top line in **Next up (auto)** that your tier allows. Helpers: only `helper-ok` lines.

Several AIs can work on Emberisle at once. Lanes sort work by code area; **they do not lock an
entire area**. Several issues in the same lane may be active at once when their claimed files do
not overlap. Claims reserve files, including while a PR waits for review.

| Label | Files |
|---|---|
| `lane:board` | `src/lib/scene/**`, `src/components/scene/**`, the hex, terrain, ocean, camera and 3D pieces, and board-look proofs |
| `lane:net` | `server/**`, `src/lib/net/**`, `Lobby.tsx`, `Chat.tsx`, `Reactions.tsx`, `online.ts`, `src/lib/sound.ts` and `public/audio/` |
| `lane:hud` | `src/components/game/**` (except the net files above), `src/styles.css` and `src/lib/viewport.ts` |
| `lane:rules` | `src/lib/game/**` (`rules.ts`, `store.ts`, `ai.ts`, `types.ts`) |
| `lane:docs` | `docs/**` only: research and design notes |

## Picking an issue

1. **Find eligible work:** an open `status:todo` issue with a lane label, every `Depends on` issue
   closed, no active claim, and no open PR for it (drafts count). Order: priority first (see
   [Tier and priority](#tier-and-priority)), then `docs/FRAMEWORK.md` section 7's earliest milestone, lowest step. Helpers additionally require `helper-ok` and must respect
   their open-PR limit in [`HELPERS.md`](HELPERS.md).
2. **Check files across all lanes:** read active claims and their open PRs, including work In Review.
   A `claimed:` remains active until that agent posts a later pause, or its PR merges or closes.
   Historical same-agent `paused:` comments also release claims; new pauses must include `/paused`.
   Ignore released historical claims. If your planned files overlap another active claim's files or
   PR changes, pick a different issue. A shared lane alone is not a conflict. Neither are the shared
   registration files `package.json`, `.github/workflows/ci.yml` and `scripts/size-prove.mjs`: almost
   every PR adds a line there, and the second PR to merge fixes the small conflict. Editing a different
   function in a busy file is fine too, if you name the overlapping PR in your claim and keep your hunks small.
3. **Re-check immediately before claiming:** re-read the issue and all comments, not a cached list.
   Do this again after any user wait, thinking break or check-in. Recheck eligibility and file
   ownership; if someone has claimed it, pick another. Post the claim before research or design:

   ```
   /claim
   claimed: <agent name>, <YYYY-MM-DD>
   files: <paths you expect to touch, or none>
   ```

   The agent name is required: different agents often post through the same GitHub account.
4. **Re-read immediately after posting:** first active claim wins. If another agent's active claim
   has an earlier timestamp, release only your own claim with a new comment and pick another issue:

   ```
   /paused
   paused: <your agent name>, <YYYY-MM-DD>
   lost the claim to <winning agent name>
   ```

   Compare agents, not GitHub account names. A loser's pause never releases the winner's claim.
   For equal timestamps, the earlier comment in the issue timeline wins. No fixed wait is needed.
5. **Keep the file list current:** before adding files, recheck other active claims/PRs and update
   `files:`. If the added files conflict, post `/paused` identifying your agent and pick another issue.
6. **Keep going:** never stop while eligible work exists. A busy file means choose different work,
   not reserve its entire lane. If none is eligible, follow the applicable workflow's idle guidance;
   helpers use the Timing block in [`HELPERS.md`](HELPERS.md).

An issue with no lane label isn't ready. Skip it; the orchestrator labels it.

Your claim and its file reservations release when your PR merges or closes, or when you post
`/paused` identifying your own agent. Pausing does not make an issue eligible until it is open
`status:todo` again; do not claim paused In Progress work as a shortcut around the eligibility check.

## Tier and priority

When told "next", pick in this order:

1. Highest priority first: `prio:p0`, then `prio:p1`, then `prio:p2`, then no `prio:` label.
2. Within a priority, the earliest milestone and lowest step (`docs/FRAMEWORK.md` section 7).
3. If several still tie, prefer your own tier.

You may take work at your own tier or below, never above it. An issue with no `tier:` label is open
to any tier. Helpers don't use this list: they follow the queue in [`HELPERS.md`](HELPERS.md).

| Label | Kind of work | Models |
|---|---|---|
| `tier:1-deep` | Hours-long research and architecture carried through to a finished document | Claude Fable 5.1, GPT-6 Astra |
| `tier:1` | Security, server, protocol and cross-area changes | Claude Opus 5.5, GPT-6.1 Sol, and the `tier:1-deep` models |
| `tier:2` | Everyday features with real proofs | Claude Sonnet 5.5, Gemini 3.8 Flash (thinking HIGH), Grok 4.7, GLM 5.3 and Kimi K3 (the last two provisional, see below), and every `tier:1` model |
| `tier:3` | Small single-purpose fixes, docs and screenshot QA | Claude Haiku 5.5, GPT-6 Luna, and every model above |

**Tier and model labels.** Every issue carries a `tier:` label. Any model at that tier or below may take it. Nobody assigns builders.

A `model:` label is optional. It narrows the tier: only that model, or a subagent on it, may claim the issue. It never widens the tier.

- **Why a pin exists:** to keep an issue for the model that already started it, or for a model that is known to do well on that kind of work. A pin is not a work assignment. Builders still claim with `/claim`.
- **Resuming:** an agent that pauses work it means to finish adds `model:<its model>` and a `resume: <agent name>` line to its `/paused` comment. Nobody else claims the issue.
- **Expiry:** a pin lapses after 48 hours with no claim or PR activity. The first builder to notice removes it and says so in one line. The issue is then open to its tier again. Anyone may remove a pin that has no `/claim` or `resume:` behind it.
- **Names:** short, with no version number: `model:fable`, `model:opus`, `model:sonnet`, `model:haiku`, `model:sol`, `model:astra`, `model:luna`, `model:gemini`, `model:grok`, `model:kimi`, `model:glm`. Only `model:opus`, `model:sonnet` and `model:gemini-ok` exist today. The first builder or desk to need another creates it. Versions live in the tier table.
- **`model:gemini-ok`** marks issues kept for Gemini. It is a hint, not a pin: other models at the tier may still claim them.

**Gemini takes clearly defined work with hard checks.** It is good at:

- UI audits: check that a card or panel works and chat overlaps nothing. Screenshot set viewports and flag anything odd.
- Minor design fixes, such as "make X fit at this viewport", with a pixel proof.
- Small defined coding, docs and scripts.

Gemini never builds a new look, animation or layout that needs taste. Split such an issue: another builder takes the design part, and Gemini takes the audit or the defined part. `model:gemini-ok` marks issues kept for Gemini.

**Big design work needs Claude Opus 5.5 or stronger.** Big design work means a new look, a layout, an animation, or a visual spec in an issue. Fable and Astra count. Any model, helpers included, may do small design that the issue text already defines, such as an icon swap or a spacing fix. Any model may also build to an approved mock.

**Design issues start in backlog.** The desk files an issue that changes a layout, a look or an animation as `tier:1` and `status:backlog`. Backlog is not eligible. The desk moves it to `status:todo` only when the issue links an Astra or Opus spec or an approved mock that settles the exact sizes, states and wording. A proof-only issue that measures the current screen (no change to `Hud.tsx`, `styles.css` or any visible look) is not design and may be `tier:2`.

**Only listed models claim.** The tier table lists every model that may take issues. A model that is not in it, including Claude Sonnet 4.6 and earlier Claude models, claims nothing, at any tier. A claim names its model and version in the agent name (`claimed: Claude Sonnet 5.5, 2026-10-22`); Cursor, which picks its model per run, names it in the PR body (`Model: ...`). The label bot cannot check this, so the desk does. A claim by an unlisted or unnamed model, or on an issue above its tier, is void: the desk releases it with `/paused`, says why on the issue, and puts the issue back where it belongs.

Grok's usage limits are low, so give it one `tier:2` or `tier:3` issue at a time.

**Bedrock models (Jarrod, 2026-10-21):** GLM 5.3 and Kimi K3 are provisional `tier:2`. Each takes one issue at a time until two of its PRs have merged after a clean review by a different model. Then it is simply `tier:2`. Neither takes `tier:1` work, design that needs taste, or a review of a `tier:1` PR. gpt-oss is not used. Setup: [`setup-bedrock-agents.md`](setup-bedrock-agents.md).

**Abilities within a tier.** Nobody assigns these builders to issues, and the desk adds no new tier labels for them. A `model:` pin is optional (see Tier and model labels). Each model looks up its own tier in the table above and takes the top eligible issue at or below it. The table below is for self-checking: if an eligible issue sits in the "Avoid" column for your model, skip it and take the next.

| Model | Good at | Avoid |
|---|---|---|
| Kimi K3 | Well-defined features with hard proofs, long unattended runs, multi-file changes | Quick turnarounds: it is slow, about 44 minutes a ticket on one private benchmark ([Superconductor](https://www.superconductor.com/blog/kimi-k3-benchmark)). That never lets it skip a `prio:p0` issue. |
| GLM 5.3 | Defined coding, terminal and script work, reviewing Kimi K3's PRs | Design that needs taste |
| Grok 4.7 | Everyday `tier:2` features and fixes | More than one issue at once (low usage limits) |

Until two of its PRs have merged, a provisional model takes no second issue. Each posts `<agent name>: started #N` and `<agent name>: PR #M for #N` on #854, like every builder. Say your model name in the PR body.

**The builders (Jarrod, 2026-10-20):**

| Builder | Models | Takes |
|---|---|---|
| Codex | GPT-6.1 Sol | Server, net, rules and bots (`tier:1`) |
| Cursor | Any model it picks, Opus included | Any lane, at the tier of the model it uses |
| Josh's agent | Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5, free to use any of them | Any lane, as a full builder. It follows AGENTS.md, not HELPERS.md, and works from Josh's fork. |
| Jarrod's Claude | Opus and Sonnet subagents | UI builds from approved mocks, defined fixes and docs |
| Fable and Astra | Fable 5.1, GPT-6 Astra | Design passes and research only (`tier:1-deep`) |
| Gemini | Gemini 3.8 Flash | Audits and defined checks only |

Every builder names the model that wrote each PR in the PR body, and says so again if a later push used a different model. The reviewer differs from every model named.

Other agents, Copilot included, take one small issue at a time until a review shows their work holds up.

### Sub-agents and usage limits

An agent may spawn cheaper or stronger sub-agents if its platform allows it. For example, Opus can
hand a `tier:3` issue to Haiku. An agent that can't spawn stronger models, such as Gemini, stays at
its own tier or below. Pick the sub-agent by how clear the task is:

- **Fable 5.1** when the goal is unclear: open research, design, or a problem with no set answer.
- **Sonnet 5.5** for clearly defined coding. With a precise issue and completion test, it codes as well as the larger models.
- **Haiku 5.5** for small, focused fixes and checks.

Stop starting new work when your 5-hour or weekly usage limit has 5% or less left. Finish or pause
the current step, post `/paused` saying where you stopped, and leave the rest.

## When nothing is eligible

An empty ready list is not a reason to stop or to ask the desk. Work down this ladder yourself and take the first rung that has anything. Claim as usual. Post on #854 only if all five rungs are empty.

1. **Adopt a finished-but-stuck PR.** Built PRs whose builders went quiet are listed under "Stale" in #916. Any PR with no push for 24 hours counts as stale. Comment `/claim adopt PR #N` on its issue, merge current main into its branch (a merge commit; never rebase or force-push), fix conflicts, get CI green, run the focused proof, then say on the PR it is ready for review. Don't widen its scope. It counts toward your open-PR limit (AGENTS.md rule 4).
2. **Promote a backlog issue.** A `status:backlog` issue with every `Depends on` issue closed, a lane label and a clear scope is eligible. Not eligible: a design issue held for a spec or mock (layout, look or animation, see "Design issues start in backlog"), whatever its tier label says. Re-read it, `/claim`, and set it to `status:claimed`. No desk permission is needed.
3. **Finish the head of a chain.** A chain is blocked by its first issue. If the head is claimed but its PR has been silent for 24 hours, post `Question: still working?`. With no reply in 2 hours it counts as free and you may adopt it.
4. **Always-useful work.** Write the missing test for a recently merged feature. Split an oversized issue into small, fully labelled ones. Close duplicates with a one-line reason.
5. **Research gaps.** Read `docs/research/` and the #903 review notes. File 1 to 3 well-scoped issues (all four labels, a completion test, `Depends on`) for work nobody has listed.

Every issue carries a status, lane, tier and prio label. Never leave one unlabelled.
