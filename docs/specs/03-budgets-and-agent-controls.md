# Spec 03: Budgets and per-agent controls

Status: draft. (Numbered 03 here because requests 1 and 3 were merged into Spec 01.)

## Problem
Gratis has per-run limits (`src/run-limits.mjs`: 10 min, 100 tool calls, 5 failures, 1M output chars) and approval prompts, but no spend caps, no policy rules such as "never offer more than 10% off", no pause switch per bot, and no single activity feed. Vestra shows a per-teammate budget, limits, Pause, and a step log.

## Goals
- Per-bot budgets (in money where measurable, otherwise in usage units), with warn and hard-stop thresholds.
- User-defined policy rules that gate specific tool actions.
- A per-bot Pause/Resume and a unified activity feed.

## Non-goals
- Enforcing a budget on spend Gratis cannot see (subscription usage is flat-rate; remote T3 or cloud-provider billing is outside the app, as `docs/RELIABILITY.md` already states). The UI must say which spend is counted.

## What counts as spend
| Source | Measurable? | Unit |
|---|---|---|
| API-key or OpenAI-compatible provider | Yes, from token usage times configured price | currency |
| Claude/Codex subscription | No | runs, tool calls, minutes |
| Composio/app actions | Count only | actions |
| Cloud computer minutes | Count only (provider bills separately) | minutes |
Budgets are therefore `{unit, period, limit}` where unit is `currency|runs|toolCalls|minutes`. Verify what token usage the backends currently expose.

## Data model
```
Budget  { botId, unit, period: "day"|"week"|"month"|"total", warnAt: 0.8, limit, spent, resetsAt }
Policy  { id, botId|null (null = all bots), tool, condition, action: "require_approval"|"deny"|"allow",
          note }       // condition: simple field comparisons on tool arguments, e.g. discountPercent > 10
ActivityEvent { id, at, botId, kind: run|tool|approval|policy|budget|pause, summary, refs, outcome }
BotControl { botId, paused: bool, pausedBy, pausedAt }
```
Stored in the encrypted store; ActivityEvents hold metadata only (no message bodies), following the diagnostic log rules.

## Behavior
1. **Budget check** runs in the same place run limits are created (`createRunBudget`) and before each tool call: a hard-stop aborts the run with a `RunLimitError`-style pause that preserves partial work (existing recovery path), and the UI offers Raise limit, Wait for reset, or Stop.
2. **Warn threshold** posts a notice in the chat and the activity feed once per period.
3. **Policies** are evaluated in `agent-tools.mjs` before executing a tool. Precedence: bot-specific deny > global deny > require_approval > allow. `require_approval` reuses the existing approval flow and shows the policy note ("Your limit is 10%").
4. **Pause** stops new runs and schedules for the bot, cancels the active run cleanly, and keeps queued messages. Resume clears it. Scheduled and objective check-in runs (Spec 01) skip while paused and are recorded as skipped.
5. **Defaults:** new bots get conservative defaults visible in Create Bot, not hidden: a daily run cap and a rule requiring approval for any external send or purchase (already today's behavior, made explicit as policies).
6. **Activity feed** per bot and global, filterable, with deep links to the chat message or approval. Mirror in the phone UI.
7. **Agents cannot edit their own budgets, policies or pause state.** Tools exposing these are not provided; the same rule `SCHEDULES.md` applies to schedules.

## Edge cases
- Concurrent runs racing on one budget: reserve before the call, settle after; overshoot bounded by one call.
- Clock and timezone for period resets: use the user's timezone from settings.
- Budget raised mid-run: applies to next check only.
- Failed tool calls are charged if the provider charged for them.

## Acceptance tests
- Hard stop at the limit preserves partial output and offers retry after raising the limit.
- A policy with `discountPercent > 10` forces approval at 15 and passes at 5.
- Paused bot: the schedule skips, the chat message queues, and the feed shows both.
- A bot-initiated attempt to alter policy/budget fails (no such tool; prompt injection test via tool output text).
- Checkpoint restore keeps budgets and `spent`.

## Open questions
- Whether a group chat's cost is charged to the primary or the contributing bot (recommend: the contributing bot).
