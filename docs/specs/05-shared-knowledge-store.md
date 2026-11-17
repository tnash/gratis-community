# Spec 05: Shared, permissioned knowledge store ("Brain")

Status: draft. Local-only in v1; sharing depends on the team pilot (`packages/team`, `docs/TEAM_PILOT.md`).

## Problem
Memory today is per bot and local (`memory-service.mjs`, `memory-vault.mjs`, `memory-keyring.mjs`, embeddings in `memory-embeddings.mjs`). The team pilot isolates channel conversations from personal memory. Vestra's "Brain" is a shared layer teammates read from, so one teammate's learning (what we sell, who the clients are) helps others. Gratis needs a shared store with explicit permissions so sharing is never accidental.

## Goals
- A separate store of **Knowledge Items** that multiple bots (and, in the team pilot, multiple humans) can read, with per-item and per-space permissions.
- Bots can propose items; the user decides what becomes shared.
- Retrieval uses the existing embedding and context path, with permission filtering applied before ranking.

## Non-goals
- Replacing per-bot private memory. Private memory stays the default; nothing is promoted automatically.
- Document-sync from Drive/Notion in v1 (v2 via connectors, with an ingestion review step).

## Data model
```
KnowledgeItem {
  id, spaceId, title, body (markdown), tags[],
  source: { kind: "user"|"bot"|"import", botId?, ref? },
  visibility: "owner_only" | "selected_bots" | "space",
  allowedBotIds[],            // used when selected_bots
  status: "proposed"|"approved"|"retired",
  version, createdAt, updatedAt, approvedBy
}
Space { id, name, kind: "personal"|"team", memberIds[] }   // reuse packages/team spaces.mjs for team
```
Encryption: items live in a vault separate from private memory but use the same keyring pattern (`memory-keyring.mjs`), so a checkpoint carries them encrypted. Embeddings are stored with the item and re-derived on key rotation.

## Permissions model
- Default visibility on creation is `owner_only`. Promotion to `selected_bots` or `space` is a user action with a confirmation that lists who can read it.
- A bot can read an item only if `status=approved` and its id is allowed. Reads are checked in the store, not in the prompt.
- **Bot-proposed items** are always `proposed` until approved; proposals show source and rationale. Proposals derived from external content (web, email) are flagged.
- **Sensitive content guard:** items detected as credentials or personal identifiers (reuse the redaction heuristics already in the memory path; verify) are refused with an explanation.
- **Team space:** membership and roles come from the team server; the store refuses reads from non-members. Server stores ciphertext only if client-side encrypted per space key (decision below).
- Every read by a bot writes an access record (item id, bot id, time) viewable by the user.

## Behavior
1. **Tools** in `agent-tools.mjs`: `knowledge_search(query)`, `knowledge_get(id)`, `knowledge_propose(title, body, tags)`. No write/update/delete tool for approved items.
2. **Retrieval:** context builder queries private memory plus permitted knowledge; knowledge entries are labeled with source and version in the prompt so the bot can cite them. Cap tokens per source.
3. **UI:** a Knowledge page: list, search, approve/reject proposals, edit with version history, change visibility, retire, and an access log. Phone view read-only.
4. **Conflicts:** edits create a new version; bots reading mid-update get the last approved version.
5. **Retirement** removes from retrieval immediately; deleted items are tombstoned and purged on next checkpoint cycle.
6. **Templates** (`bot-template.mjs`) never include knowledge items; they may list titles as suggested starter topics only with opt-in.

## Phases
1. Personal-space store, approval flow, bot tools, retrieval filter (local only).
2. Access log and versioning.
3. Team spaces over `packages/team` with membership checks.
4. Connector imports with review.

## Acceptance tests
- Item `owner_only` is invisible to every bot; `selected_bots` visible only to the listed bots, verified at the store layer by a bot without access calling `knowledge_get` directly.
- A bot-proposed item cannot be retrieved until approved.
- A credential-shaped string is refused on proposal and on user save with a warning.
- Retiring an item removes it from the next prompt.
- Checkpoint restore keeps items, versions and visibility; a restore on a machine without the key cannot read them.
- Team member removal revokes access on the next request.

## Open questions
- Team-space encryption: server-readable (simpler search) or end-to-end per space key (stronger privacy, harder server-side search). Recommend end-to-end, with client-side retrieval, consistent with PRIVACY.md.
- Whether retrieval from knowledge should be opt-in per bot (recommend yes, default on for the owner's personal space only).
