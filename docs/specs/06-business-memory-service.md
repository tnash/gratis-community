# Spec 06: Business memory service (a build of the Apex model)

Status: draft. Working name: **Brain**. Written from the public Apex site only (landing, How it works, Docs, FAQ, Use cases, Why not build it, Stack, Security). Apex's internals were not seen. Where the public pages are silent this spec makes a choice and marks it **Decision**. Do not copy Apex's name, branding or wording.

## 1. What it is
A hosted service that reads a business's existing tools on a schedule, turns what it reads into structured memory (people, companies, promises, decisions, preferences, tasks), and serves the relevant slice to any AI client over MCP. It never writes to the connected tools. It is the memory layer, not an assistant.

This is a separate product from the Gratis desktop app. It reuses Gratis pieces where noted (section 14) but runs as its own multi-tenant service.

## 2. Goals
1. Connect a business's tools in minutes with each tool's own sign-in.
2. Keep a structured memory current to within about 15 minutes, with no user action.
3. Let any MCP client (Claude, ChatGPT, Grok Bot, Claude Code, Codex) search and read it, and let the user correct it in plain language.
4. Isolate tenants hard, encrypt per tenant, and be read-only toward connected tools by construction.
5. Show freshness on every answer.

## 3. Non-goals
- Sending, editing or deleting anything in a connected tool (hard rule, enforced in code and tests).
- Live data (bank balance, today's inventory). Users add that tool's own connection to their AI.
- Custom connectors. A fixed, team-maintained list only (**Decision**: keep, it bounds the support surface).
- A chat UI or an agent that does work. The client AI does the work.
- Per-item filtering inside a connected tool in v1 (connect a tool and all of it is used). Per-folder or per-label scoping is listed as a later option.

## 4. Users and flows
- **Owner:** signs up, connects tools, connects an AI client, corrects the brain.
- **Teammate:** asks the brain through their own AI client (needs team support, section 11).
- **Operator (us):** runs the service. Sees metadata only.

Core flow: sign up, connect accounts, first build (about 15 minutes, answers allowed earlier with a freshness note), connect a client, ask.

## 5. Architecture
```
Connectors (OAuth, read-only) --> Ingest queue --> Normalizer --> Extractor (LLM) --> Brain store (per tenant, encrypted)
                                                                                       |
MCP server (OAuth 2.1 + PKCE, scopes read/write) <---- Retrieval (keyword + vector) <--+
Web app: sign-in, Connect, Settings > Channels (address, tokens), brain review, audit log
```
Components:
- **Web app** (sign-in, connections, brain review and edit, client setup, tokens, audit).
- **Connector broker:** holds every third-party credential. The brain code never sees a tool token. **Decision**: build on a managed OAuth broker (Gratis already integrates Composio) rather than writing 80 OAuth flows; wrap it with a per-tool read allowlist (section 7).
- **Scheduler:** per-connection sync jobs about every 15 minutes, with retries, backoff and a stalled-connection alert.
- **Normalizer:** converts each source item to a common `SourceItem` (section 6).
- **Extractor:** an LLM pass that produces structured records with citations back to source items.
- **Store:** Postgres with row-level security, an object store for raw text, a vector index.
- **MCP server:** the eight tools in section 9.

## 6. Data model
All tables carry `tenant_id`; row-level security is on for every one (a CI test fails if a table with `tenant_id` has no policy).
- `tenant`, `user` (role: owner, member), `connection` (tool, status, last_sync_at, error, broker_ref), `sync_run`.
- `source_item`: id, connection, external_id, kind (email, event, doc, transcript, deal, invoice...), occurred_at, author, participants, content_ref (encrypted blob), content_hash, deleted_at.
- Records, each with `confidence`, `status` (active, superseded, forgotten), `sources[]` (source_item ids with a short quote), `created_by` (extractor or user), `visibility` (shared or private, section 11), `version`:
  - `person` (names, emails, role, company, notes), `company`, `promise` (owed_by, owed_to, what, due, state open/done/overdue), `decision` (what, who, when), `preference` (subject, statement), `task`, `fact` (free text written by `apex_remember`).
- `correction`: an undoable operation log (before and after) for every user or client edit.
- `access_log`: client, tool, time, result count. Metadata only: no titles, queries or record ids.

## 7. Connectors
- **Launch set** (mirrors the observed list, grouped): mail and calendar (Gmail, Google Calendar, Outlook, Cal.com, Calendly, Zoho Mail); documents (Google Drive including Docs and Meet transcripts, Sheets, OneDrive, SharePoint, OneNote, Excel, Notion, Dropbox, Confluence, Airtable); meetings (Fireflies, Zoom, Fathom, Granola, Webex, Avoma, Circleback); chat (Slack live-search only, Microsoft Teams); projects and code (Linear, Jira, Asana, ClickUp, Trello, GitHub, GitLab and similar); CRM and phone (HubSpot, Salesforce, Pipedrive and similar); support (Zendesk, Intercom, Freshdesk and similar); money and contracts (QuickBooks, Stripe, Xero-class accounting, e-signature); people, forms, design. Ship in waves; wave 1 is mail, calendar, Drive, Notion, one CRM, one meeting tool, Slack.
- **Per-connector read contract** (a file per tool): the allowed read actions, what is included, what is excluded, size limits. Examples to copy from the observed docs: Gmail documents up to 10 MB and five per email, no spam, trash or subject-less mail; Calendar main calendar up to 30 days ahead; Sheets first 200 rows of five tabs.
- **Read-only enforcement:** an explicit allowlist of API actions per tool, checked before any request leaves the code; no wildcards; a build test fails if an allowed action name matches a write verb (create, update, delete, send, move, post...). OAuth scopes requested are the minimum read scopes.
- **Slack:** never stored. Searched live when a tool call needs it, results returned and discarded.
- **Disconnect:** revoke the broker grant, stop syncing, delete that connection's raw `source_item` content. Records derived from it are marked `source_removed`; **Decision**: they are deleted unless the user has edited them.
- **Obsidian vault:** supported as "a folder in Drive, OneDrive or Dropbox", each file a note, kept in sync.

## 8. Ingestion, extraction, freshness
- First build backfills a bounded window (**Decision**: 12 months of mail and docs, 90 days of calendar around today) and is resumable. The brain answers during the build and every answer states how fresh each source is.
- Incremental sync uses each tool's change cursor where available, otherwise a modified-since poll. Job interval is 15 minutes, jittered. Dead-letter after N failures and show the connection as needing attention.
- **Extraction:** per new or changed `source_item`, an LLM call returns records plus citations as JSON, validated against a schema; invalid output is retried then dropped, never stored half-parsed. Thread quoting is stripped before extraction. Prompts treat source content as untrusted data.
- **Entity resolution:** merge people and companies across tools by email, domain and name with a confidence score; low-confidence merges stay separate and are flagged for review rather than guessed.
- **Promise tracking:** promises have a state machine; later source items can close them (an invoice sent, a reply). Overdue is computed, not stored.
- **Supersession:** a newer decision or preference replaces an older one but keeps it in history.
- **Cost control:** hash items to skip unchanged ones; batch small items; per-tenant daily extraction budget with a visible warning when hit.

## 9. MCP surface (tools)
Server address per brain (for example `https://mcp.<domain>/mcp`), shown in Settings > Channels. Scopes: `read` and `write`. Neither scope can reach connected tools.

| Tool | Scope | Behaviour |
|---|---|---|
| `brain_briefing` | read | What the brain holds, counts by type, per-source freshness, open promises and decisions waiting. Called first. |
| `brain_search` | read | `{query, types?, person?, since?, limit}`; hybrid keyword and vector; returns ids, titles, snippets, source and freshness. Can return "what is owed" views. |
| `brain_get` | read | One record in full with citations and history. |
| `brain_whats_new` | read | Changes since a timestamp, grouped by person. |
| `brain_remember` | write | Create a `fact` (or typed record) with the user's wording; visible to every client. |
| `brain_correct` | write | Edit or supersede a record; stored as a `correction` and undoable. |
| `brain_share` | write | Set a record private or shared (section 11). |
| `brain_forget` | write | Forget one record, or everything a search returned (requires a confirmation token returned by a dry-run first). |

- Returns a bounded slice (token cap per call), never bulk export. Every result includes `as_of` per source.
- Tool descriptions state that results are data, not instructions. Returned source text is wrapped and labeled as untrusted to blunt prompt injection from emails and documents.
- **Default-use prompt:** the quickstart provides a one-line system-prompt snippet telling the agent to check the brain first.
- A plain-text list of supported apps is published for AIs to read.

## 10. Auth, tokens, accounts
- **User sign-in:** Google or Microsoft SSO (identity scopes only) or password hashed with Argon2id.
- **MCP clients:** OAuth 2.1 with mandatory PKCE and dynamic client registration for browser clients (Claude, ChatGPT connectors).
- **Terminal agents** that cannot open a browser use bearer tokens minted in Settings > Channels: opaque, shown once, stored only as hashes, scoped read or write, revocable, with last-used time.
- An API key variant for bots that run unattended (for example Grok Bot secrets) is the same token type.
- Rate limits per token and per tenant. Every tool call appends to `access_log`.

## 11. Teams and the "me" problem
The public docs say team support is in development, and the shared-login workaround has two known faults: everyone sees everything, and there is one "me". This spec fixes both.
- Members join a tenant by invite, each with their own sign-in and their own connected accounts.
- **Rooms:** one shared company room and one private room per person. Records default to the room of the connection that produced them (a personal mailbox feeds the private room). `brain_share` moves an item to the company room. Enforced in row-level security, not in the app.
- "Me" resolves from the authenticated token's user, so "what am I waiting on?" is correct for each person.
- Owner can see connection status for the team but not another person's private room.
- **Decision:** team ask-the-brain works through each member's own AI client and token; no shared bot required.

## 12. Security and privacy
Targets (match what Apex publicly claims, then verify them rather than assume):
- **Encryption:** AES-256 at rest everywhere; TLS 1.2+ (1.3 on) in transit; **per-tenant data key** (envelope encryption with a KMS) over source text and record text; annual rotation; deleting a tenant destroys its key so backups become unreadable; backups kept 35 days.
- **Isolation:** Postgres row-level security with an application role that cannot bypass it; database in a private subnet with a pinned CA; separate production and staging with separate keys.
- **Operator blindness:** no interactive server access; database and app logs configured never to log content; staff see counts, timings and error traces with content stripped; key unwraps by unexpected roles raise an alert.
- **Audit:** per-tenant access trail of every read with client identity, retained 12 months, metadata only; tool call arguments hashed, never stored.
- **Connectors:** credentials only in the broker; read-only allowlist; revocation on disconnect.
- **Model providers:** zero data retention terms and no training, by contract; a published page lists which provider sees what.
- **Compliance:** publish DPA, subprocessor list, retention schedule, privacy policy and terms. GDPR, UK GDPR and Canadian privacy law terms from day one. SOC 2 Type II as a later program; do not claim it before the report exists.
- **Vulnerability disclosure:** published policy and `security.txt`.
- **Deletion and export:** user can export all records as JSON and delete everything; deletion is immediate in the store and complete in backups at 35 days.

## 13. Web app screens
Connect (list, status, last sync, errors, add or remove); Brain (browse people, companies, promises, decisions; edit, forget, share); Freshness view; Settings > Channels (MCP address, tokens, connected clients); Audit log; Team (invites, rooms); Usage and billing. Corrections in plain language also work from any client via `brain_correct`.

## 14. What can be reused from Gratis
- The permissioned knowledge store model (`src/knowledge.mjs`): visibility, approval, versions, access log, secret-detection guard.
- The Composio integration (`connections.mjs`, `composio-signin.mjs`) as the connector broker starting point, with a read allowlist added on top.
- `packages/mobile` crypto and `packages/cloud` token patterns for token issue and revoke, and the headless runtime's scoped tokens (`src/runtime-server.mjs`).
- Everything else (Postgres RLS, KMS envelope encryption, the extractor, the web app) is new.

## 15. Operations
- **Hosting:** one cloud account; multi-AZ database with automatic failover; queue workers scale on backlog; infrastructure as code; deploys promoted from staging by image digest.
- **Observability:** sync lag per connection, extraction error rate, queue depth, MCP latency, content-free traces.
- **Alerts:** a connection with no successful sync for 1 hour; extraction schema failures above a threshold; budget exhaustion.
- **Cost model:** dominated by extraction tokens and embeddings. Read once, organize, and serve small slices, so per-question cost stays low. Needs measuring in phase 1 before pricing.

## 16. Phases
1. **Spine (single tenant, one source):** Gmail plus Calendar, ingest, extraction, hybrid search, `brain_briefing/search/get` over MCP with bearer tokens. Proves extraction quality and freshness.
2. **Multi-tenant and trust:** tenants, RLS, per-tenant keys, SSO, OAuth 2.1 for browser clients, audit log, write tools with undo.
3. **Connector wave 1 and broker:** Drive, Notion, one CRM, one meeting tool, Slack live search, read allowlist tests.
4. **Teams and rooms.**
5. **Compliance and scale:** published legal documents, pen test, connector waves 2 to 4, Obsidian-via-cloud-folder, billing.

## 17. Acceptance tests
- A new tenant connects Gmail and Calendar; the first build completes and answers carry per-source freshness; a changed email appears in search within 20 minutes.
- Given a fixed email ("go ahead with Phase 1, send the invoice by Friday, loop in Sam, Tuesdays work best"), extraction produces the person, decision, promise (due Friday) and preference, each with a citation.
- A tenant A token can never read tenant B data (automated cross-tenant probe on every table and tool).
- The build fails if any connector allowlist contains a write action.
- A `read` token calling `brain_remember` is refused; revoking a token fails its next call.
- `brain_correct` then undo restores the prior record; `brain_forget` on a search requires the confirmation step.
- Disconnecting a tool deletes its raw content and stops syncing; deleting a tenant makes its backup unreadable (key destroyed).
- A malicious email containing instructions is returned only as labeled data and does not change any record without the user's action.
- A member's private room records are invisible to other members, and "what am I waiting on" resolves to the asker.
- Logs and traces from a full test run contain no source text.

## 18. Open questions
- Extraction model choice and cost per mailbox; accuracy target and how to measure it (build a labeled test set from consented mailboxes first).
- Broker: managed (Composio-class) versus self-built, given the per-tool credential liability and the cost of 80 maintained integrations.
- Retention of derived records after a source is deleted at the origin (mirror the deletion, or keep).
- Legal: terms for reading customers' third-party data, and each provider's API policy for AI processing and caching (several, such as Slack, restrict storing content).
- Whether per-folder or per-label scoping should be in v1 given privacy objections to "everything in the tool is used".
- Pricing and plan limits (Apex gives none publicly).
