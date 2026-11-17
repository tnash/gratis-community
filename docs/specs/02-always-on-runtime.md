# Spec 02: Always-on runtime (local machine or cloud)

Status: draft.

## Problem
Schedules run only while Gratis is open and the Mac is awake (`SCHEDULES.md`). Teammates that "work toward a goal and reach out only when needed" require an agent runtime that keeps running without the desktop window.

## Goals
- Split "the app" (UI, user decisions) from "the runtime" (runs bots, schedules, tools).
- The same runtime binary runs in three places: inside the desktop app (today's behavior), as a headless daemon on any machine the user owns (a home Mac mini, a VPS), or in a container on a cloud host the user controls.
- The user can move a workspace between runtimes without losing chats, memory or credentials.

## Non-goals
- A Gratis-operated hosted service. Per AGENTS.md and `PRIVACY.md`, the community edition ships no hosted infrastructure; the user supplies their own machine or cloud account (as `docs/CLOUD.md` already does for the browser service).
- Multi-tenant hosting of several users on one runtime (see Spec 03 for accounts).

## Architecture
```
Desktop UI  <--authenticated channel-->  Runtime
Phone UI    <--existing mobile relay-->  Runtime (via desktop or direct)
```
- **Runtime core** extracted from `src/main.cjs`: `chat-service.mjs`, `schedules.mjs`, `memory-service.mjs`, `agent-tools.mjs`, provider backends (`claude-backend.mjs`, `codex-backend.mjs`), `run-limits.mjs`. Today these are wired to Electron IPC through `preload.cjs`; the extraction replaces IPC with an RPC interface (same method set, transport-agnostic). Verify how much of `main.cjs` mixes Electron-only concerns (windows, dock, Keychain) with runtime logic; this is the largest unknown.
- **Transports:** in-process (desktop default), local socket, and TLS/WebSocket for remote runtimes. Reuse the token and enrollment pattern from `packages/cloud/src/http.ts` and the pairing crypto in `packages/mobile/src/crypto.ts`.
- **Packaging:** `gratis-runtime` CLI (Node 22.16+, like `scripts/workspace-recovery.mjs`) and a `Dockerfile` modeled on `packages/cloud/Dockerfile`.

## Credentials and provider auth (the hard part)
- Claude and Codex accounts are subscription logins tied to the OS keychain (`secure-storage.mjs`). Credentials do not move to another machine by copying a checkpoint (see `docs/RELIABILITY.md`).
- Each runtime holds its own provider login, established by a one-time device flow run on that machine. Spec must confirm provider terms allow headless use of the user's subscription before shipping; if not, remote runtimes must use API keys or a local OpenAI-compatible endpoint (`store.mjs` already supports `baseUrl`).
- Runtime secrets are encrypted at rest with a key from the host's keystore, or a user passphrase on headless Linux.

## Behavior
1. **Enroll:** `gratis-runtime init` creates a data directory and prints a one-time enrollment code. Desktop Settings > Runtime accepts the code and stores a scoped token.
2. **Source of truth:** the active runtime owns workspace state. The desktop becomes a client. Switching runtimes is an explicit export, import and restore using the existing checkpoint format, followed by the old runtime going read-only.
3. **Schedules and objectives** (Spec 01) run on the active runtime regardless of whether the desktop is open. The sleeping-Mac caveat in `SCHEDULES.md` is replaced by a runtime health indicator.
4. **Approvals** that need the user queue on the runtime and notify through the desktop, the phone relay, or Slack (`slack-transport.mjs`). Queued approvals never auto-expire into approval.
5. **Updates:** runtime and desktop negotiate a protocol version; mismatch shows a clear upgrade prompt.
6. **Observability:** status metadata logs only (`diagnostic-log.mjs` rules); no message content in logs.

## Security
- All remote transports authenticated and encrypted; tokens scoped (read, run, admin) and revocable.
- Runtime exposes no unauthenticated port; default bind is loopback.
- Tool execution is gated by the same approval rules as local, plus per-runtime allow lists for filesystem paths.
- A remote runtime has a smaller blast radius if it runs unprivileged in a container; document that as the recommended cloud path.

## Phases
1. Extract the runtime core behind an RPC interface; desktop uses it in-process (no user-visible change).
2. Local daemon plus desktop client over a local socket.
3. Remote transport, enrollment, and checkpoint-based move between runtimes.
4. Docker image and a deployment guide for one VPS provider.

## Acceptance tests
- Phase 1: the existing test suite and `npm run check` pass unchanged.
- A schedule fires with the desktop quit and the daemon running.
- Revoking a token disconnects the client within one request.
- Moving a synthetic workspace between runtimes preserves chats, memory and schedules; credentials must be re-established, and the UI says so.

## Open questions
- Provider terms for headless subscription use (blocking decision).
- Is the phone relay pointed at the runtime directly, or still at the desktop?

## Implementation status
Phase 2 core, built beside the desktop app rather than by refactoring `main.cjs` (83 IPC handlers; the extraction stays unstarted to protect the working app):
- `src/runtime-core.mjs`: Electron-free chat service, schedules, objectives, controls, proactivity and knowledge.
- `src/runtime-crypto.mjs`: passphrase keystore (scrypt + AES-256-GCM) in place of the OS keychain.
- `src/runtime-server.mjs`: loopback HTTP API, protocol version check, read/run/admin tokens, instant revoke.
- `scripts/gratis-runtime.mjs`: `init`, `run`, `token`. Passphrase comes from `GRATIS_RUNTIME_PASSPHRASE`.

Not done: desktop as a client, local socket, remote TLS and enrollment code, checkpoint move between runtimes, Docker image, approval notifications (approvals queue but nothing notifies), memory, computer, Gmail, T3 and phone relay on the runtime, and the provider-login device flow (a headless runtime has no Claude or Codex login until the terms question is settled).
