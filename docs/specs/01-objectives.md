# Spec 01: Objectives (first-class entity with ownership)

Status: draft. Covers requests 1 and 3 (same feature).

## Problem
Gratis bots run prompts and schedules (`src/schedules.mjs`). A user cannot say "this bot owns the goal *grow LinkedIn to 10,000 followers by March*" and see progress, cadence and ownership. Vestra's landing page treats this as its core idea: teammates own objectives, report weekly, and ask only when blocked.

## Goals
- An Objective is stored data, not a prompt. It has one owner bot, a target, a deadline, a progress metric and a check-in cadence.
- The owner bot is given its objectives in context on every run and can propose progress updates through a tool.
- The user sees all objectives, status and history in one place and keeps final say.

## Non-goals
- Automatic metric collection from third-party APIs (v1 is bot-reported or user-entered; connector-fed metrics are v2).
- Multi-owner objectives, dependencies between objectives, OKR hierarchies.

## Data model (stored in the encrypted workspace store, `src/store.mjs`; verify the migration path in `validState`)
```
Objective {
  id, title, description,
  ownerBotId,               // exactly one; reassignable by user only
  metric: { name, unit, start, target, current, source: "bot"|"user" } | null,
  deadline: ISO date | null,
  cadence: { kind: "weekly"|"daily"|"none", dayOfWeek?, time?, timezone },
  status: "active"|"at_risk"|"paused"|"done"|"dropped",
  createdAt, updatedAt
}
ProgressEntry { id, objectiveId, at, value|null, note, author: botId|"user", evidenceRef? }
```
Rules: `current` is derived from the latest ProgressEntry. `status` may be set by the bot to `at_risk` only with a note; `done` and `dropped` require user confirmation.

## Behavior
1. **Create.** From the bot's page ("Objectives" tab) or by asking the bot; the bot proposes an Objective and the user confirms (never silently created).
2. **Context injection.** When a run starts for the owner bot, active objectives (title, target, current, deadline, last note) are added to its prompt context (extend the memory-context path, `src/memory-context.mjs`, or the equivalent of the prompt builder in `src/claude-backend.mjs`; verify which).
3. **Tools** (added to `src/agent-tools.mjs`): `objective_list`, `objective_report_progress(value, note)`, `objective_flag_risk(note)`, `objective_propose(...)`. Tools only act on objectives owned by the calling bot.
4. **Check-ins.** The cadence creates a managed schedule via the existing `Schedules` class, labeled as an objective check-in, whose prompt asks the bot to review progress and write a short report into its chat. Editing or deleting the Objective updates or removes that schedule. Existing rules still apply: no overlap, pause on failure, approvals required for external actions.
5. **UI.** List with progress bar, deadline, status chip and last report. Detail view shows the ProgressEntry timeline, linked check-in runs and edit/pause/reassign/drop controls. Mirror a read-only view in the phone UI (`src/mobile-ui.mjs`, `packages/mobile`).

## Edge cases
- Owner bot deleted: objectives become `paused` and unowned; user is prompted to reassign.
- Metric with no start/target: show note-only timeline, no bar.
- Deadline passed and not done: mark `at_risk` automatically and surface on next open.
- Bot-reported values are untrusted: keep the author on every entry; the user can edit or delete entries.

## Privacy and safety
Objectives live only in the local encrypted store and in checkpoints. Templates (`src/bot-template.mjs`) must exclude objectives by default, or export only titles with an explicit user opt-in.

## Acceptance tests
- Create, edit, pause, drop and reassign persist across restart; checkpoint restore keeps them.
- Cadence creates and removes the managed schedule; missed runs coalesce into one.
- A bot can report progress only on its own objectives; a foreign `objectiveId` is rejected.
- `done` and `dropped` cannot be set by a bot call.
- Templates exclude objectives; `npm run check` passes.

## Open questions
- Should group chats show objectives of every member, or only the primary's?
- Is the check-in report posted into the existing chat or a dedicated "reports" thread?
