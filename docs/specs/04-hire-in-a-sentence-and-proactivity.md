# Spec 04: Hire-in-a-sentence and the proactivity loop

Status: draft. Depends on Spec 01 (objectives), Spec 03 (budgets and policies); can ship a reduced v1 without Spec 02.

## Problem
Creating a bot today is a form (`src/create-bot-ui.mjs`, `src/generateBotPrompt`-style helpers; verify exact flow). Vestra lets the user say "I need someone to find us new customers" and get a configured teammate with goals, skills and routines. Vestra also advertises teammates that get "more proactive every week". Gratis bots only act when messaged or scheduled.

## Part A: Hire in a sentence
### Behavior
1. User types one sentence in Create Bot ("Hire").
2. A dedicated drafting run (existing provider, no tools, no external actions) returns a **BotDraft**: name, role, personality, starting objectives (Spec 01), suggested skills/apps (from the Composio list the user already has connected), suggested routines, and suggested budget and policies (Spec 03). It may ask up to two clarifying questions first ("What matters most?").
3. The user sees an editable draft with every field changeable and each suggested app marked "needs connection". Nothing is created or connected until the user clicks Hire.
4. On Hire, create the bot using the same path as the form, then create the objectives, managed schedules, budget and policies.

### Constraints
- The draft is untrusted model output: validate against the existing bot schema (`validateSettings` / `validateTemplate`), cap field lengths, and strip unknown fields.
- Suggested apps are only suggestions; connecting still goes through the existing sign-in flow (`composio-signin.mjs`).
- Reuse the template format (`src/bot-template.mjs`) as the BotDraft serialization so drafts, templates and hires share one validator.

## Part B: Proactivity loop
Goal: an owner bot with objectives can decide what to do next without a user message, within hard limits.

### Loop (runs on each objective cadence tick and on a lightweight "heartbeat" while the runtime is active)
1. **Observe:** gather objective state, recent progress, memory notes, connected-app signals the bot may read, and pending approvals.
2. **Decide:** a planning run returns zero or more **Proposals**: `{action, rationale, expectedImpact, riskLevel, needsApproval}`.
3. **Gate:** each proposal passes Spec 03 policies and budgets. Low-risk read-only proposals may execute; anything external (send, purchase, publish, delete) becomes an approval card. No proposal bypasses approval because it came from the loop.
4. **Act and record:** executed proposals write ActivityEvents and ProgressEntries.
5. **Learn:** user approvals, rejections and edits feed memory extraction (`memory-extract.mjs`) as explicit preference notes ("You cut every sentence with the word 'excited'"), shown in the weekly report as "Learned this week" and deletable by the user.

### Proactivity levels (per bot, user-set; default Low)
- **Off:** only responds.
- **Low:** weekly check-in report; proposes next steps, takes none unprompted.
- **Medium:** also performs read-only research and drafts, with drafts waiting for approval.
- **High:** may execute pre-approved action classes (via policy `allow`) inside budget.
"More proactive each week" is implemented as a **suggestion** to raise the level after N approved proposals with no rejections; it never raises itself.

### Anti-annoyance and safety
- Rate limit: at most one unprompted message per bot per day by default, plus a quiet-hours setting.
- Idempotency: the loop must not repeat a proposal the user already rejected within a cooldown.
- Interrupted or uncertain external actions pause the loop for review (same rule as `SCHEDULES.md`).
- Prompt injection: content read from apps or web is data; proposals derived from it are tagged and always require approval.

## Phases
1. Part A with the form pre-fill (no autonomy).
2. Weekly check-in report on objectives (reuses Spec 01 cadence).
3. Proposals at Low and Medium levels.
4. High level and the suggestion to raise levels.

## Acceptance tests
- One sentence yields a draft that passes the validator; malformed model output is rejected with a retry, not a crash.
- Hire creates exactly what the draft shows, and cancel creates nothing.
- Loop at Low makes no tool calls beyond reads; at Medium, no external sends without an approval.
- A rejected proposal is not re-proposed within the cooldown.
- Injection test: a fetched web page telling the bot to send email produces an approval card only.

## Open questions
- Draft quality depends on the connected-app catalog available offline; fallback is a generic role with no app suggestions.
