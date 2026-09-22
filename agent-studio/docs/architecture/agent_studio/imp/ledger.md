# Neryva Agent Studio Implementation Ledger

## Document status

| Field                         | Value                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source of truth               | `agent_studio_architecture.md` (862 lines), `agent_studio_implementation_plan.md` (1632 lines), `../main.md` (444 lines)                                                                                                                                                                                                                                                                                         |
| Companion boundaries          | `../engine/engine_architecture.md`, `../engine/engine_implementation_plan.md`, `../engine/engine_data_and_lifecycle.md`, `../neryva_mcp/neryva_mcp_implementation_plan.md`                                                                                                                                                                                                                                       |
| Canonical contract dependency | `../../neryva_mcp/neryva-mcp-contract` (`buf.yaml:1`, `buf.gen.yaml:1`, `proto/neryva/mcp/*/v1/*.proto` x9, `gen/ts` via `@bufbuild/protobuf` + `@connectrpc/connect`) — Engine + Studio both consume generated clients                                                                                                                                                                                          |
| Scope                         | Agent Studio execution plane — agent kernel, definition compiler, context compiler, model gateway, tool gateway, workflows/activities, memory/retrieval adapters, artifacts, telemetry, security — Engine remains system of record                                                                                                                                                                               |
| Out of scope                  | Engine-owned authority (conversations/messages/runs/billing/audit/retention in `engine/src/modules/*`), provider-owned conversation state as canonical, second billing ledger in Studio                                                                                                                                                                                                                          |
| Ledger type                   | Phase-gated execution tracker — one checkbox = one verifiable deliverable with code + test + CI evidence                                                                                                                                                                                                                                                                                                         |
| Rule                          | No phase may be marked `DONE` without its exit-gate evidence in CI, conformance suite, or operational drill. Do not start a later phase before the previous phase's exit gates are `DONE`. `agent_studio_implementation_plan.md:8-12`                                                                                                                                                                            |
| Date / snapshot               | 2026-09-02 — codebase at `engine@0.1.0`, `products/neryva_mcp@0.1.0` (contract + spike complete), `products/agent-studio` has **no runtime code yet** (`docs/architecture/agent_studio/imp/` empty), `engine/drizzle` at `0028` (assistants `0020`, policy_snapshots `0021`, conversations `0022`, async `0023`, mcp_authority `0024`, outbox `0025`, knowledge `0026`, billing_ledger `0027`, lifecycle `0028`) |

> This ledger **expands** `agent_studio_implementation_plan.md:1324-1552` (Phases 0–11) and
> `agent_studio_architecture.md:672-827` (Phases 0–8) into atomic, checkable tasks grounded against
> the repo as of 2026-09-02. The implementation plan's 12 phases are authoritative for delivery
> order. No task may be marked `DONE` without its cited exit gate.

---

## 1. How to use this ledger

1. Work strictly in phase order. Each task cites the authoritative spec section and the target
   file/package to change. Preserve citations when moving tasks. Directory names are part of the
   implementation contract — rename only via ADR preserving package ownership
   `agent_studio_implementation_plan.md:447`.
2. A task is `DONE` only when **code + test + evidence** land together:
   - `code`: `agent_studio/<path>` + line range (e.g., `packages/agent-kernel/src/transitions.ts`)
   - `test`: unit / contract / Temporal replay / isolation / provider conformance / security —
     whichever the exit gate names
   - `evidence`: CI log (`pnpm typecheck && pnpm lint && pnpm test:contract && pnpm test:workflow`),
     `buf breaking` log, workflow-bundle determinism check, or `infra/observability` dashboard
     screenshot
3. Any new package or route that touches authorization, tenant scope, secrets, or large payloads
   must satisfy the Phase 0 gate before merge: `agent_studio_implementation_plan.md:59-78` (13
   rules) and `engine_architecture.md:570-584` (12 non-weakening decisions) — a PR that violates
   them is blocked even if local tests pass.
4. Treat the following **non-negotiable ownership** as invariant gates from Phase 0 onward
   `agent_studio_implementation_plan.md:50-57` — a PR that violates them is blocked even if local
   tests pass:
   - Engine owns: tenant identity, authorization decisions, canonical conversations/messages,
     business run projection, billing/usage ledger, audit, retention/deletion, and Neryva MCP
     authority side `agent_studio_implementation_plan.md:52`
   - Agent Studio owns: agent execution, model calls, context compilation, tool-loop control,
     temporary execution state, Studio side of Neryva MCP `agent_studio_implementation_plan.md:53`
   - Temporal owns durable execution mechanics `agent_studio_implementation_plan.md:54`
   - Model provider is never canonical conversation store `agent_studio_implementation_plan.md:55`
   - Agent Studio has **no** Engine DB credentials `agent_studio_implementation_plan.md:56`
   - No package may silently add a second durable conversation or billing store
     `agent_studio_implementation_plan.md:57`
   - Forbidden imports `agent_studio_implementation_plan.md:491-503` are enforced by
     `pnpm check:dependencies` (see 0.5)
5. Engine and Neryva MCP are **already end-to-end** (`products/neryva_mcp/neryva-mcp-contract`
   complete, `engine/src/modules/conversations/mcp-authority.service.ts` + `drizzle/0024` live).
   Agent Studio must **consume** them via generated `@neryva/mcp-contract` and workload capability —
   never copy types or open Engine DB credentials. Provider SDKs and Temporal SDK majors must be
   pinned from currently supported ranges at implementation time, not copied as historical numbers
   `agent_studio_implementation_plan.md:77`.

---

## 2. Architecture delta — what the new architecture requires vs what exists

### 2.1 Required Agent Studio components (`agent_studio_architecture.md:42-55`)

| Component                  | New architecture                                                                                                                                                                  | Current `products/agent-studio`                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Agent Authoring / Compiler | Immutable declarative `agent_id/version` `agent_studio_architecture.md:357-405`, Zod/JSON Schema validation `agent_studio_architecture.md:90`                                     | **Absent** — no `packages/agent-definition`                                         |
| Agent Runtime + Kernel     | Bounded `AgentRun` state machine `agent_studio_architecture.md:322-351` + `agent_studio_implementation_plan.md:736-785`                                                           | **Absent** — no `packages/agent-kernel`                                             |
| Temporal durable execution | `AgentRunWorkflow` + Activities, signals, heartbeat, Continue-As-New `agent_studio_architecture.md:98-143`                                                                        | **Absent** — no `packages/workflows`/`activities`, no `apps/runtime-worker`         |
| Model Gateway              | Provider-neutral `NeryvaModelRequest/Response/ToolCall/Usage/ProviderError` `agent_studio_architecture.md:409-444` via Vercel AI SDK Core `agent_studio_architecture.md:18,84`    | **Absent** — no `packages/model-gateway`                                            |
| Tool Gateway               | `READ_ONLY/MUTATING/DESTRUCTIVE` + orthogonal `approval_requirement` `agent_studio_implementation_plan.md:969-1028`, scoped creds + egress `agent_studio_architecture.md:483-511` | **Absent**                                                                          |
| Context Compiler           | Pure module: token budgeting, history/summary/memory/knowledge/tool selection `agent_studio_architecture.md:446-481`                                                              | **Absent**                                                                          |
| Neryva MCP client          | Generated `@neryva/mcp-contract` + interceptors + capability verifier `agent_studio_implementation_plan.md:616-664`                                                               | **Absent** — contract exists in sibling `products/neryva_mcp` but not consumed here |
| Memory & Retrieval workers | Engine-mediated retrieval, hybrid lexical+vector `agent_studio_architecture.md:513-557`, artifact claim-check `agent_studio_architecture.md:584-596`                              | **Absent**                                                                          |
| Observability              | OTel GenAI spans, correlated `run_id/correlation_id`, redaction policy `agent_studio_architecture.md:669`                                                                         | **Absent**                                                                          |
| Persistence                | Engine PostgreSQL authoritative; Temporal bounded refs; object storage claim-check `agent_studio_architecture.md:558-597`                                                         | **Absent** — no artifact/package; Engine side complete (`0020`–`0028`)              |

### 2.2 Current strengths to preserve (do not rewrite)

- **Neryva MCP contract** —
  `products/neryva_mcp/neryva-mcp-contract/proto/neryva/mcp/{common,identity,run,context,event,tool,approval,checkpoint,runtime}/v1/`
  with `buf.yaml:1` (`STANDARD` lint) + `buf.gen.yaml:1` (remote `bufbuild/es` + `connectrpc/es` to
  `gen/ts`). Keep as pinned dependency, verify via
  `buf lint && buf breaking && buf generate && git diff --exit-code gen/ts`.
- **Engine authority** — `engine/src/modules/conversations/*` (conversations/messages/runs `0022`,
  outbox/inbox `0023`, MCP authority `0024`, checkpoints/tool_effects/approvals/memory_proposals
  `0024`) is production-ready for `GetAuthorizedRunContext`/`AppendRunEvents`/`CommitRunResult`.
  Agent Studio must not duplicate it.
- **Engine kernel** — `engine/src/common/infra/db/db.service.ts:1` (`withOrg`/`withBypass` RLS),
  `engine/src/tracing.ts:5` (OTel first), `engine/ownership-map.json:1` (single-owner tables). Agent
  Studio needs analogous `security` + `telemetry` but no DB owner tables.

---

## 3. Current implementation inventory (factual, 2026-09-02)

### 3.1 Filesystem

```
products/agent-studio/
  docs/architecture/agent_studio/
    agent_studio_architecture.md   (862 lines — hybrid TS+Temporal+Vercel AI SDK, 8 phases)
    agent_studio_implementation_plan.md (1632 lines — monorepo layout, 12 phases, dependency rules)
    imp/                           (this ledger only — no code)
products/neryva_mcp/
  neryva-mcp-contract/
    proto/neryva/mcp/*/v1/*.proto  (9 domains)
    buf.yaml / buf.gen.yaml / gen/ts
    package.json  "@neryva/mcp-contract@0.1.0"
  src/{engine,studio,events,artifacts,security,...}  (spike + authority)
  package.json "@neryva/mcp@0.1.0" (ConnectRPC 2.0.3, protobuf 2.14)
engine/
  src/modules/{conversations,assistants,knowledge,billing,lifecycle,...} (17 modules)
  drizzle/ 0001–0028 (0028 = lifecycle: retention_policies/legal_holds/export_requests/purge_tasks/tombstones)
  ownership-map.json  (62 tables, engine-ts owned, assistants/conversations/runs/... since eng-0020)
```

No `agent_studio/package.json`, `pnpm-workspace.yaml`, `apps/`, `packages/`, `contracts/`, `infra/`,
`tests/` exist yet. This ledger's Phase 0 creates them.

### 3.2 Module registry (planned — none live)

| Planned module              | Flag   | Tables owned               | HTTP surface | Completeness vs spec                     |
| --------------------------- | ------ | -------------------------- | ------------ | ---------------------------------------- |
| `common` (non-existent)     | always | none                       | none         | 0% — needs config, clock, error taxonomy |
| `packages/agent-kernel`     | always | none                       | none         | 0%                                       |
| `packages/agent-definition` | always | none                       | none         | 0%                                       |
| `packages/context-compiler` | always | none                       | none         | 0%                                       |
| `packages/model-gateway`    | always | none                       | none         | 0%                                       |
| `packages/tool-gateway`     | always | none                       | none         | 0%                                       |
| `packages/memory-retrieval` | always | none                       | none         | 0%                                       |
| `packages/workflows`        | always | none — Temporal state only | none         | 0%                                       |
| `packages/activities`       | always | none                       | none         | 0%                                       |

### 3.3 Naming / collision notes

- Engine's legacy satellite product had `studio_project_keys` (`drizzle/0006`,
  `ownership-map.json:118`) — unrelated to new Agent Studio runtime. No rename needed in Agent
  Studio; just avoid importing satellite tables. The Engine ledger's planned
  `src/modules/agent-studio -> studio-furniture` rename is an Engine concern, not an Agent Studio
  blocker.
- Workspace package name must be distinct (e.g., `@neryva/agent-studio`) to avoid collision with
  `@neryva/mcp-contract` (`products/neryva_mcp/neryva-mcp-contract/package.json:2`).

### 3.4 Tech divergence register (decide once, enforce via ledger)

| Decision          | Spec says                                                                                        | Current reality                                                                       | Verdict for this ledger                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language          | TypeScript on Node.js LTS `agent_studio_architecture.md:81-96`                                   | Engine is NestJS/Node 22, MCP contract is TS                                          | **Keep TypeScript/Node LTS** per `agent_studio_implementation_plan.md:77` — select one pinned LTS line + TS compiler version, record in `package.json:engines` + `.nvmrc`  |
| SQL builder       | Not owned by Studio (Engine owns PG) `agent_studio_architecture.md:21-27`                        | Engine uses `drizzle-orm` (ADR-011)                                                   | **Studio has no Engine DB driver** — `agent_studio_implementation_plan.md:493` forbids `pg`/drizzle in Studio; all data via `neryva-mcp-client`                            |
| Transport         | Protobuf + ConnectRPC `agent_studio_architecture.md:24`, `neryva_mcp_implementation_plan.md:194` | `products/neryva_mcp` uses `buf.build/bufbuild/es` + `connectrpc/es` `buf.gen.yaml:1` | **Keep Buf + ConnectRPC** — pin `@bufbuild/protobuf@2.14.x` + `@connectrpc/connect@2.x` compatible majors via lockfile, CI `buf format --diff && buf lint && buf breaking` |
| Model abstraction | Vercel AI SDK Core + official provider SDKs `agent_studio_architecture.md:84,428`                | none yet                                                                              | **Adopt Vercel AI SDK Core behind `model-gateway`** `agent_studio_implementation_plan.md:902-905`, but never expose its types as `NeryvaModelRequest`                      |
| Durable execution | Temporal `agent_studio_architecture.md:21-22,35-37`                                              | Engine has `bullmq` for Engine jobs, not Studio workflows                             | **Adopt Temporal TypeScript SDK** `agent_studio_implementation_plan.md:77` — pin supported runtime range at implementation time, don't copy historical version numbers     |

---

## 4. Phase overview (12 phases — same critical path as implementation plan `agent_studio_implementation_plan.md:1324-1552`)

| Phase  | Name                                         | Goal                                                      | Depends on | New code boundary                                                                                                                |
| ------ | -------------------------------------------- | --------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **0**  | Repository & contract foundation             | Enforceable repo rules before any runtime                 | —          | `package.json`, `pnpm-workspace.yaml`, `tsconfig`, `contracts/mcp/dependency.md`, `packages/testkit`, `infra/temporal`, `tests/` |
| **1**  | Kernel & definition compiler                 | Pure bounded state machine + immutable definition         | 0          | `packages/agent-kernel`, `packages/agent-definition`, `contracts/agent-definition`, `contracts/tool`                             |
| **2**  | Neryva MCP client & admission                | Generated client, capability, run admission               | 1          | `packages/neryva-mcp-client`, `packages/security`                                                                                |
| **3**  | Temporal workflow & worker                   | Deterministic `AgentRunWorkflow` + worker                 | 2          | `packages/workflows`, `packages/activities`, `apps/runtime-worker`, `apps/runtime-control`                                       |
| **4**  | Model Gateway + one provider                 | Provider-neutral gateway, one adapter passing conformance | 3          | `packages/model-gateway`                                                                                                         |
| **5**  | Context Compiler                             | Deterministic authorized context assembly                 | 4          | `packages/context-compiler`                                                                                                      |
| **6**  | Tool Gateway & approval                      | Policy boundary + approval bridge                         | 5          | `packages/tool-gateway` (+ `apps/tool-worker` optional)                                                                          |
| **7**  | Memory, knowledge & artifacts                | Retrieval + claim-check, citation                         | 6          | `packages/memory-retrieval`, `packages/artifacts`                                                                                |
| **8**  | Streaming & operational observability        | Durable events + ephemeral deltas + OTel                  | 7          | `packages/telemetry`, `apps/runtime-control` streaming                                                                           |
| **9**  | Provider expansion & failure matrix          | Second+ provider(s), fallback audited                     | 8          | `packages/model-gateway/providers/*`                                                                                             |
| **10** | Hardening, evaluation & production readiness | Isolation, chaos, SBOM, SLOs, runbooks                    | 9          | `tests/isolation`, `tests/chaos`, `tests/load`, `infra/observability`                                                            |
| **11** | Authoring & evaluation product surface       | Editor + draft/publish + trace viewer                     | 10         | `apps/eval-worker`, `contracts/events`, `docs/adr`                                                                               |

> Mapping to `agent_studio_architecture.md:672-827`: Arch Phase 0 (spike) = Ledger Phase 0 slice,
> Arch Phase 1 (contract) = Ledger Phase 0–1, Arch Phase 2 (core runtime) = Ledger Phases 1–5, Arch
> Phase 3 (durable) = Phase 3, Arch Phase 4 (security/tools) = Phase 6, Arch Phase 5
> (memory/knowledge) = Phase 7, Arch Phase 6 (providers) = Phases 4+9, Arch Phase 7 (enterprise
> hardening) = Phase 10, Arch Phase 8 (authoring) = Phase 11.

Critical path:
`kernel/definition -> MCP client -> Temporal -> Model Gateway -> Context Compiler -> Tool Gateway -> memory/artifacts -> observability -> provider expansion -> hardening -> authoring`
`agent_studio_implementation_plan.md:1615-1632`.

### 4.1 Persistent enterprise invariants (must hold from Phase 0 onward)

**Product model** `main.md:11-19,22-33`: multi-tenant, provider-agnostic org-branded AI assistant
platform —
`Engine = control plane and system of record, Agent Studio = execution plane/runtime, LLM = reasoning engine`
`main.md:13-15`. Each org configures
`brand identity, support/internal behavior, private documents/knowledge, tools/integrations, allowed models/providers, guardrails/escalation, handoff, channels (web, mobile, Slack, WhatsApp, API)`
`main.md:25-33`. Engine manages product/business domain; Studio executes reasoning/tool workflow;
Studio is not the brain — model is `main.md:38-41`. Frontend communicates with Engine only
`main.md:48,76`.

**Persistence design** `agent_studio_architecture.md:558-598` +
`agent_studio_implementation_plan.md:1118-1133`:

| Owner               | Stores                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Engine (PostgreSQL) | conversations, messages, assistant versions, policies, memories, knowledge metadata, usage ledger, audit events `agent_studio_architecture.md:565-573` |
| Temporal            | workflow execution history, run refs, retry state, timers, approval waits, bounded checkpoint metadata `agent_studio_architecture.md:575-581`          |
| Object storage (S3) | files, large tool results, transcripts, diagnostic artifacts, optional prompt snapshots `agent_studio_architecture.md:583-588`                         |
| Transient           | NATS JetStream durable cross-service events when replay needed, Redis/Valkey cache/rate-limit/ephemeral fan-out `agent_studio_architecture.md:590-592` |

Agent Studio has three kinds of local state only `agent_studio_implementation_plan.md:1118-1125`:
`1 Workflow state` (bounded refs in Temporal), `2 Activity-local state` (ephemeral),
`3 Claim-check artifacts` (Engine-authorized refs). Must **not** create
`agent_studio_implementation_plan.md:1126-1133`: Agent Studio conversation DB, parallel message ID
allocator, billing ledger, unbounded checkpoint DB, authorization cache as only decision, provider
session as canonical history. Keep workflow inputs small, references not full docs
`agent_studio_architecture.md:595`.

**Multi-tenant scaling** `main.md:371-392` + `agent_studio_architecture.md:376-393`: shared
stateless workers, queue by `conversation_id`, enforce one active run per conversation
`main.md:377`, scale horizontally, org-level quotas/rate limits `main.md:379`, tenant-scoped queries
or RLS `main.md:380`, vector collections namespaced by `organization_id` `main.md:381`
`agent_studio_architecture.md:381`, dedicated pools only for expensive/privileged tools
`main.md:382`, stronger isolation tiers for enterprise `main.md:383`. Example
`100 orgs / 10k conversations / many workers / one Engine data layer`
`agent_studio_architecture.md:387-392`. Do **not** create one worker per organization
`agent_studio_implementation_plan.md:547`.

**Guardrails** `main.md:397-407`: Engine (auth, quotas, tenant isolation, data access, retention) +
Agent Studio (prompt rules, workflow limits, model output validation) + Tool Gateway (permission,
arg validation, rate limits, approval) + Provider Gateway (allowlists, credentials, redaction,
usage) + Frontend (display). System prompt is not security boundary `main.md:406`.

**Three-way verification** `agent_studio_architecture.md:623-671` — must be green before production:

- Functional `agent_studio_architecture.md:625-639`: multi-turn, multi-org, multi-provider, tool
  use, human approvals, long-running jobs, streaming, resumption, agent versioning, multiple
  channels
- Operational `agent_studio_architecture.md:641-652`: worker crashes, provider timeouts, retry
  policies, horizontal scaling, backpressure, cancellation, durable approval waits, replay/debugging
- Enterprise `agent_studio_architecture.md:653-667`: tenant isolation, scoped credentials,
  auditability, retention/deletion, provider portability, allowlists, usage accounting, regional
  deployment, independent security boundaries. OTel GenAI conventions basis
  `agent_studio_architecture.md:668` — keep mapping in one module, coalesce equivalent spans not sum
  tokens `agent_studio_architecture.md:670`.

**Open-source vs custom ownership** `agent_studio_architecture.md:599-621` — Adopt: Temporal,
provider SDKs/AI SDK, OTel, pgvector initially, sandbox isolation, Engine SSE/WebSocket. Build:
kernel, Neryva MCP, tenant auth (Engine), conversation state (Engine), billing/usage
(Engine/gateway), context compiler, tool gateway, memory policy, agent definitions. Rule: adopt
generic infra; own what differentiates Neryva or protects data `agent_studio_architecture.md:621`.

**Responsibility split** `main.md:86-110` — Engine owns
`User authentication, Organization/membership authorization, Conversation/message IDs, Agent configuration/versions, Brand rules/tenant policies, Billing/quotas/usage ledger, Audit/retention, Canonical history`
`main.md:88-97`; Studio owns
`LLM calls/model behavior, Tool-call loops/workflow, Temporary context, Runtime checkpoints (schema, persisted via Engine), Long-term memory proposals`
`main.md:98-102`; Engine owns
`Long-term memory approval/storage, Final assistant message, Streaming transport` `main.md:103-105`;
kernel: Studio may own execution logic but Engine owns durable business state `main.md:109`.

**Security invariants** `agent_studio_implementation_plan.md:1162-1205`:

- Workload identity `agent_studio_implementation_plan.md:1164-1173`: each deployment distinct
  workload identity; runtime-worker receives only Neryva MCP execution access, Temporal
  namespace/task-queue permissions, secret-manager access to assigned provider/tool creds, artifact
  claim-check path — no Engine DB, broad object-store, billing, or admin creds.
- Capability enforcement per operation `agent_studio_implementation_plan.md:1177-1192`: verify
  `signature/key version`, `expiration`, `not-before`, `organization_id`, `conversation_id`,
  `run_id`, `assistant/agent version`, `actor/service identity`, `allowed method/capability set`,
  `replay protection`; mismatch = terminal authorization error, do not repair scope from Studio
  request.
- Prompt-injection boundary `agent_studio_implementation_plan.md:1194-1205`: treat all model output,
  retrieved docs, tool output, user input, external MCP content as untrusted data — may propose
  actions but cannot change tenant scope, change auth policy, choose unallowlisted model/tool, issue
  Engine persistence commands, retrieve hidden credentials/system prompts, bypass approval, alter
  budgets/terminal state. Retrieval filtering in query not post-filter `main.md:189`
  `agent_studio_architecture.md:556`.

**State separation** `main.md:114-190` — Engine stores: conversation history `main.md:117-133`
(conversation_id, organization_id, end_user_id, channel refs, messages, tool calls/results,
attachments/citations, sequence, timestamps, redaction), execution state separately
`main.md:135-148` (run_id, step, in-progress tools, approvals, retries, graph state, provider
request IDs, cancellation, checkpoint version), long-term memory with 8 fields `main.md:164-172`
(owner scope, source, timestamps, expiry, deletion, access policy, confidence), knowledge data
separate `main.md:176-190` (files, metadata, chunks, embeddings, version, ACL, citations). Context
window is temporary projection `main.md:191-207`, not stored; provider-managed conversation IDs are
optimization not canonical `main.md:226-235`.

**Frontend contract** `main.md:409-432` — Frontend receives stable
`organization_id, assistant_id, assistant_version_id, conversation_id, message_id, run_id, event_id, sequence_number`
`main.md:411-420` from Engine only `main.md:76,408`. Frontend: send messages to Engine, subscribe
via SSE/WebSocket, render run progress, reconnect with last `event_id`, use idempotency keys, never
owns authoritative history, never stores provider keys, never decides access `main.md:422-432`.
Neryva MCP flow `main.md:242-255` (1 Frontend→Engine, 2 auth, 3 store user msg, 4 create run/durable
job, 5 claim, 6 request context, 7 model/tool, 8 runtime events, 9 Engine persists canonical, 10
Engine streams). Token deltas via Redis/ephemeral, final message durable `main.md:304`; every Neryva
MCP request includes `organization_id, conversation_id, run_id` + authorized + idempotent +
sequence/concurrency + single active turn per conversation + tool idempotency `main.md:294-303`;
capability token 5 fields `main.md:308-309`.

**Neryva MCP vs External MCP** `main.md:77-85,315-349` — Neryva MCP is custom internal Engine↔Studio
protocol (`neryva.mcp.v1`, not external Model Context Protocol). External MCP if later = separate
Tool Gateway adapter via Activity, session state not run state, still authorized/redacted/idempotent
`agent_studio_architecture.md:303` `main.md:319-348`. Sensitive writes (`append assistant message`,
`charge usage`, `refund`) remain explicit Neryva MCP ops, not model tools `main.md:349`.

---

## 5. Phased ledger — atomic tasks

> Each task line is `checkbox` + **bold ID** + spec citation + scope → `files` → exit signal. Check
> a box only when the signal is in `main`.

### Phase 0 — Repository and contract foundation

_Objective: turn architecture decisions into enforceable repository rules before any business
feature `agent_studio_implementation_plan.md:1326-1347`._

- [ ] **0.1** Create monorepo skeleton — `agent_studio_implementation_plan.md:18-46` tree →
      `package.json` (workspace root), `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
      `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`, `prettier.config.js`,
      `vitest.workspace.ts`, `.env.example`, `.npmrc`, `.gitignore` →
      `pnpm install --frozen-lockfile` green.

- [ ] **0.2** Pin toolchain — `agent_studio_implementation_plan.md:77-78` → select Node.js LTS
      line + TypeScript compiler version + pnpm + formatter/linter + Temporal SDK + Protobuf/Connect
      generators + provider SDK majors, pin in `package.json:engines` + lockfile + CI →
      `pnpm typecheck` green, CI fails on floating major.

- [ ] **0.3** Define 13 implementation rules before coding —
      `agent_studio_implementation_plan.md:59-79` (1 MCP contract range, 2 Node/TS versions, 3
      package manager/workspace/formatter/linter/CI, 4 Temporal namespace/task queues/worker
      identity/payload codec/retention, 5 credential ownership/redaction, 6 tool effect
      classes/approval/timeout/idempotency, 7 max sizes for MCP/workflow/tool/artifact/event, 8
      capability-token claims + key rotation, 9 agent-definition schema v1, 10 provider feature
      matrix streaming/tools/structured-output/usage/cancellation/context-limits, 11 allowed
      trace/log/history content, 12 minimum failure-injection + tenant-isolation suite per merge, 13
      encrypted payload codec + claim-check thresholds for non-public workflow/activity payloads) →
      `docs/development.md` + `docs/adr/*` → reviewed.

- [ ] **0.3a** Cut ADRs for architecture decisions that must not be weakened —
      `agent_studio_implementation_plan.md:447` +
      `agent_studio_architecture.md:14-15,145-191,619-622` →
      `docs/adr/adr-001-hybrid-temporal-vercel.md` (adopt Temporal + Vercel AI SDK Core, build
      kernel/MCP yourself), `adr-002-no-langgraph-dual-durability.md` (do not run LangGraph +
      Temporal together for same run; LangGraph only bounded inside Activity if ever
      `agent_studio_architecture.md:156-168`), `adr-003-no-mastra-agents-sdk-core.md` (Mastra/OpenAI
      Agents SDK/Microsoft Agent Framework not core foundation
      `agent_studio_architecture.md:170-191`), `adr-004-node-temporal-workers.md` (Node.js LTS for
      workers, model adapters avoid Node-only assumptions, edge optional
      `agent_studio_architecture.md:37`), `adr-005-durable-constraints.md` (heartbeat
      `RecordHeartbeat`, claim-check, Continue-As-New, retry ownership, idempotent tools
      `agent_studio_architecture.md:133-143`), `adr-006-littlm-optional-gateway.md` (LiteLLM only
      behind Model Gateway contract for separate network boundary, not core
      `agent_studio_architecture.md:444`) → reviewed.

- [ ] **0.4** Wire **Neryva MCP contract as pinned dependency** —
      `agent_studio_implementation_plan.md:616-630`
      (`neryva-mcp-contract/proto/neryva/mcp/... -> generated @neryva/mcp-contract`) →
      `contracts/mcp/dependency.md` records selected version + compatibility range;
      `package.json:dependencies` pins `@neryva/mcp-contract` (file: or registry); CI fails when
      pinned version / generated API / conformance baseline inconsistent. Never hand-copy generated
      types `agent_studio_implementation_plan.md:631`.

- [ ] **0.5** Establish package dependency rules — `agent_studio_implementation_plan.md:447-503` DAG
      (`contracts / generated MCP types ^ domain kernel/definition ^ context/compiler/model/tool/artifact ^ activities ^ Temporal workflows ^ apps`
      `agent_studio_implementation_plan.md:451-470`) + `eslint` import-boundary rules + CI check →
      `pnpm check:dependencies` green.

  **Allowed dependencies** `agent_studio_implementation_plan.md:472-489`:

  | Package             | May depend on                                                        | Must NOT depend on                                              |
  | ------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
  | `agent-kernel`      | `contracts`, pure validation                                         | Temporal, provider SDKs, network, filesystem                    |
  | `agent-definition`  | `contracts`, JSON Schema validator                                   | provider credentials, database, Temporal                        |
  | `context-compiler`  | `contracts`, definition, token counter, pure selectors               | direct Engine DB, provider SDK internals                        |
  | `model-gateway`     | provider-neutral contracts, provider adapters, telemetry ports       | Engine database, public API, workflow code                      |
  | `tool-gateway`      | tool contracts, security ports, activity ports                       | unrestricted model output, direct Engine DB                     |
  | `memory-retrieval`  | Neryva MCP client, artifact refs, retrieval contracts                | direct PostgreSQL/vector credentials                            |
  | `neryva-mcp-client` | generated MCP code, transport, security, telemetry                   | Temporal workflow code, provider SDKs                           |
  | `workflows`         | agent kernel, contracts, activity interfaces, Temporal workflow APIs | Node APIs, network, provider SDKs, `fs`, secrets                |
  | `activities`        | gateways, MCP client, artifacts, telemetry, Node APIs                | public HTTP handlers, workflow-only code                        |
  | `artifacts`         | object-store SDK, checksum/encryption libs, artifact contracts       | Engine database, provider SDKs, unrestricted object-store creds |
  | `security`          | capability/JWT libs, secret-manager ports, policy contracts          | raw secret values, provider business logic, workflow code       |
  | `telemetry`         | OTel APIs/SDK                                                        | business decisions based on span names                          |
  | `testkit`           | public package interfaces, test-only deps                            | production secrets, live customer data                          |
  | `apps`              | all approved runtime packages                                        | ad hoc domain logic outside packages                            |

  **Forbidden imports** `agent_studio_implementation_plan.md:491-503` — CI must fail if found:
  1. PostgreSQL drivers, Engine ORM, Engine migration code
  2. Browser/frontend packages inside worker
  3. Provider SDK imports from workflow files
  4. `fetch`, filesystem, random UUID, current time, or environment reads inside workflow except via
     deterministic Temporal APIs
  5. `setTimeout`, `setInterval`, `process.env`, process-global mutable config inside workflow
  6. Raw provider response types escaping `model-gateway`
  7. Generic `any`, unvalidated JSON, or unbounded `Record<string,unknown>` at authorization
     boundaries
  8. Logging raw prompts, credentials, tokens, full documents, or unrestricted tool results
  9. Package-local "temporary database" that becomes second source of truth

  **Infrastructure rule**: Adopt generic infra; own what differentiates Neryva or protects customer
  data `agent_studio_architecture.md:619-622`; vector search `pgvector initially` with measured
  migration triggers `agent_studio_architecture.md:27`.

- [ ] **0.6** Implement error & identifier conventions —
      `agent_studio_implementation_plan.md:1342` + `neryva_mcp_implementation_plan.md:322-344` →
      `packages/testkit/src/fixtures.ts` (UUIDv7 helpers for
      `organization_id`/`run_id`/`event_id`/etc per RFC 9562) +
      `packages/agent-kernel/src/errors.ts` (stable codes) → unit test.

- [ ] **0.7** Bootstrap telemetry — `agent_studio_implementation_plan.md:1344` +
      `agent_studio_architecture.md:668` → `packages/telemetry/src/bootstrap.ts` (OTel bootstrap
      before app imports,
      `traces.ts`/`metrics.ts`/`attributes.ts`/`redaction.ts`/`sampling.ts`/`semantic-conventions.ts`)
      → no raw prompts/creds in logs by default `agent_studio_implementation_plan.md:1153-1160`.

- [ ] **0.8** Create `testkit` skeleton — `agent_studio_implementation_plan.md:371-381`
      (`fake-mcp-engine.ts`, `fake-model.ts`, `fake-tools.ts`, `temporal-test-env.ts`,
      `fault-injection.ts`, `fixtures.ts`, `assertions.ts`) + local Temporal + fake Engine/MCP
      harness → `pnpm test:unit` can run without live deps.

- [ ] **0.9** Scaffold `infra/` + `tests/` trees — `agent_studio_implementation_plan.md:39-45`
      (`infra/{docker,kubernetes,temporal,policies,observability}`,
      `tests/{contract,integration,temporal,security,isolation,property,load,chaos,evaluation}`,
      `docs/{adr,runbooks,threat-model}`) +
      `infra/temporal/{namespaces.md,task-queues.md,retention.md}` → READMEs with owners.

- [ ] **0.10** Enforce startup fail-closed + typed configuration schema —
      `agent_studio_implementation_plan.md:549-615` → `apps/runtime-worker/src/config.ts`
      (loaded/validated once at startup, explicit env names, safe defaults
      `agent_studio_implementation_plan.md:550`).

  **Required configuration groups** `agent_studio_implementation_plan.md:553-603`:

  | Group           | Keys                                                                                                                   |
  | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
  | `runtime`       | `service_name`, `build_version`, `environment`, `shutdown_deadline`                                                    |
  | `temporal`      | `address`, `namespace`, `task_queue`, `worker_identity`, `workflow_bundle_path`, `payload_codec_mode`                  |
  | `neryva_mcp`    | `endpoint`, `protocol_major`, `minimum_minor`, `connect_timeout`, `request_timeout`, `capability_issuer/key reference` |
  | `model_gateway` | `enabled providers`, `model catalog source`, `provider timeout defaults`, `concurrency limits`, `redaction mode`       |
  | `tool_gateway`  | `registry source`, `effect policy`, `approval policy`, `sandbox endpoint`, `egress mode`                               |
  | `artifacts`     | `claim-check mode`, `max inline bytes`, `max artifact bytes`, `allowed purposes`                                       |
  | `telemetry`     | `exporter endpoint`, `sampling policy`, `content capture policy`, `metrics namespace`                                  |

  Secrets are references to secret manager/workload identity, never values in `.env.example`;
  provider credentials never in workflow input/logs/agent definitions/MCP capability claims
  `agent_studio_implementation_plan.md:605`. Fail closed if: Temporal endpoint/namespace missing,
  MCP protocol incompatible, provider enabled without credential ref, unsafe content-capture in
  prod, tool allows egress without policy, workflow+activity versions incompatible
  `agent_studio_implementation_plan.md:607-614` → boot test fails closed.

- [ ] **0.11** Prove architecture spike (minimal PoC) — `agent_studio_architecture.md:674-694` → one
      Engine endpoint + one Neryva MCP connection + one Temporal workflow + one model provider + one
      read-only tool + one streamed response + one simulated worker crash. Success criteria
      `agent_studio_architecture.md:686-693`: run resumes after worker failure, frontend receives
      final response, no duplicate assistant message, Engine remains canonical, workflow
      inputs/events bounded (large via claim-check), model/workflow/tool spans exported with
      correlated `run_id`.

#### Exit gates — Phase 0

- [ ] Packages build with **no runtime feature code**;
      `pnpm lint && pnpm format:check && pnpm typecheck && pnpm build` green
      `agent_studio_implementation_plan.md:1342`.
- [ ] Generated MCP types are reproducible:
      `pnpm --filter @neryva/mcp-contract generate && git diff --exit-code gen/ts` +
      `buf lint && buf breaking` in CI `agent_studio_implementation_plan.md:1343`.
- [ ] Deterministic workflow bundle check exists (`pnpm check:generated` validates bundle contains
      only deterministic imports `agent_studio_implementation_plan.md:1316-1322,1344`).
- [ ] Worker startup fails closed on every invalid config per 0.10 (exercises
      `apps/runtime-worker/src/config.ts` `agent_studio_implementation_plan.md:1345`).
- [ ] No Agent Studio package has Engine DB dependency (`pg`/Engine ORM import scan green
      `agent_studio_implementation_plan.md:1346`).
- [ ] ADR directory + threat-model placeholder exist (`docs/adr/`, `docs/threat-model/`
      `agent_studio_implementation_plan.md:1338`) and spike PoC passes 6 criteria
      `agent_studio_architecture.md:686-693`.

---

### Phase 1 — Kernel and definition compiler

_Objective: pure bounded state machine + immutable definition
`agent_studio_implementation_plan.md:1348-1367`._

- [ ] **1.1** Implement run identity & scope model — `agent_studio_implementation_plan.md:1352` →
      `packages/agent-kernel/src/agent-run.ts`, `packages/agent-kernel/src/state.ts`
      (`run identity + scope + agent version/policy version + step ID/attempt + budgets + checkpoint refs + terminal intent`
      `agent_studio_implementation_plan.md:756-772`) → unit test.

- [ ] **1.2** Define agent-definition schema v1 — `agent_studio_architecture.md:357-395` +
      `agent_studio_implementation_plan.md:688-724` → `contracts/agent-definition/v1.schema.json`
      (immutable fields: `agent_id`, `version`, `instructions`, `model_policy.allowed_models`
      referencing Model Gateway capability registry `agent_studio_architecture.md:406`,
      `context_policy {history_limit, summary_enabled, knowledge_sources, memory_scope}`,
      `tools[] {name, access: read|write, approval: required}`
      `agent_studio_architecture.md:375-389`,
      `guardrails {input_policy, output_policy, pii_redaction}`
      `agent_studio_architecture.md:386-390`), `contracts/compatibility.md`,
      `contracts/tool/{descriptor,effect-policy,compatibility.md}` → JSON Schema validated, Zod
      cross-check. Every run pinned to one immutable agent version; current run continues with
      original version if admin changes assistant `agent_studio_architecture.md:394`.

- [ ] **1.3** Implement definition parser/validator/compiler —
      `agent_studio_implementation_plan.md:165-178`, `692-724` →
      `packages/agent-definition/src/{schema,parser,validator,compiler,capability-checker,versions}.ts`
      (parse schema version → structural constraints → resolve capability IDs → policy combination →
      compile to runtime definition pinned to run) →
      `tests: schema.test.ts, validation.test.ts, compatibility.test.ts`.

- [ ] **1.4** Compile output contract — `agent_studio_implementation_plan.md:703-722` (11 fields:
      `agent_version_id`, `definition_schema_version`, `instructions ref`,
      `model/context/tool/guardrail/budget/retrieval policy`, `compiled tool schemas`,
      `compiler version`, `policy snapshot ref`) — must not contain secrets/mutable org
      pointers/executable code → snapshot test.

- [ ] **1.5** Validation rejections — `agent_studio_implementation_plan.md:725-732` (unknown
      capability, disallowed tool, effectful without approval/idempotency, limits exceed
      entitlement, unsupported context/output, unbounded recursion, instructions attempting Engine
      authority) → negative test matrix.

- [ ] **1.6** Build `contracts/tool` + read-only tool-registry interface —
      `agent_studio_implementation_plan.md:1354-1355` → `contracts/tool/descriptor.ts`,
      `packages/tool-gateway/src/registry.ts` interface used for definition validation + context
      planning (execution stays unimplemented until Phase 6) → unit test.

- [ ] **1.7** Implement kernel state machine — `agent_studio_architecture.md:322-351` →
      `packages/agent-kernel/src/{transitions,outcomes,errors}.ts`
      (`Admission -> LoadContext -> PolicyCheck -> ModelStep -> InterpretModelResult{FinalAnswer->Finalize, ReadOnlyTool->ExecuteTool->ModelStep, EffectfulTool->RequestApproval->ExecuteTool->ModelStep, UserInput->WaitForSignal, Handoff->Escalate} -> BudgetCheck -> CommitResult`
      `agent_studio_implementation_plan.md:738-754`) → `transitions.test.ts`.

- [ ] **1.8** Implement budgets + step IDs — `agent_studio_implementation_plan.md:1355` →
      `packages/agent-kernel/src/{budgets,step-id}.ts` (max model calls / tool calls / wall-clock /
      token / cost / recursion per `agent_studio_architecture.md:338-351`; stable
      `run_id + workflow generation + step path` for idempotency
      `agent_studio_implementation_plan.md:773-783`) → `budgets.test.ts`, `step-id.test.ts`.

#### Exit gates — Phase 1

- [ ] Kernel can simulate a **bounded read-only run without network effects**
      `agent_studio_implementation_plan.md:1364`.
- [ ] Invalid transitions + budget exhaustion are deterministic (pure unit/property tests)
      `agent_studio_implementation_plan.md:1365`.
- [ ] One immutable definition produces **one stable compiled representation** (hash + snapshot)
      `agent_studio_implementation_plan.md:1366`.
- [ ] Definition validation rejects all 7 invalid classes (1.5) with typed errors.

---

### Phase 2 — Neryva MCP client and admission

_Objective: generated protocol client with scope safety + idempotency
`agent_studio_implementation_plan.md:1368-1386`._

- [ ] **2.1** Generate + consume MCP client — `agent_studio_implementation_plan.md:622-629` →
      `packages/neryva-mcp-client/src/generated.ts` from `@neryva/mcp-contract` (`buf.gen.yaml:1`
      remotes `bufbuild/es` + `connectrpc/es` target `ts`), CI fails on drift
      (`pnpm check:generated`) → import test.

- [ ] **2.2** Build client layers — `agent_studio_implementation_plan.md:632-636` →
      `packages/neryva-mcp-client/src/{client,interceptors,capability,idempotency,retry,error-mapping,claim-check}.ts`
      (generated transport → protocol interceptors → scope/capability verifier → retry/idempotency →
      bounded claim-check adapter → domain-facing client) → never allow caller to override
      `organization_id`/`conversation_id`/`run_id`/`agent_version_id` scope fields
      `agent_studio_implementation_plan.md:662`.

- [ ] **2.3** Map domain methods to RPCs — `agent_studio_implementation_plan.md:644-661` →
      `claimRun -> AcquireOrRenewRunLease`, `getAuthorizedRunContext -> GetAuthorizedRunContext`,
      `appendRunEvents -> AppendRunEvents`, `createApprovalRequest -> CreateApprovalRequest`,
      `submitMemoryProposal -> SubmitMemoryProposal`, `authorizeToolCall -> AuthorizeToolCall`,
      `recordToolOutcome -> RecordToolOutcome`, `saveCheckpointRef -> SaveCheckpointRef`,
      `commitRunResult -> CommitRunResult`, `failRun -> FailRun`,
      `releaseRunLease -> ReleaseRunLease` (plus
      `GetAgentVersion`/`GetPolicySnapshot`/`SearchKnowledge`/`GetMemories` as
      `GetAuthorizedRunContext` sub-operations `agent_studio_implementation_plan.md:659`) →
      conformance test.

- [ ] **2.4** Attach envelope — `agent_studio_architecture.md:305-319` +
      `neryva_mcp_implementation_plan.md:292-306` → every request carries 8 fields: `request_id`,
      `organization_id`, `conversation_id`, `run_id`, `agent_version_id`,
      `actor_id/service_identity`, `correlation_id`, `protocol_version`, `idempotency_key`. Engine
      issues short-lived run-scoped capability token; Studio must not alter tenant/conversation/user
      scope `agent_studio_architecture.md:318-319` → interceptor test.

- [ ] **2.4a** Define four Neryva MCP area semantics (for client mapping) —
      `agent_studio_architecture.md:232-286` + `main.md:257-291`: Run control
      (`CreateRun`/`ClaimRun`/`ResumeRun`/`PauseRun`/`CancelRun`/`FailRun`/`CompleteRun` arch;
      `claimRun→AcquireOrRenewRunLease` impl `agent_studio_implementation_plan.md:645`), Context
      access
      (`GetConversationContext`/`GetAgentVersion`/`GetPolicySnapshot`/`SearchKnowledge`/`GetMemories`/`GetAttachment`
      arch → `GetAuthorizedRunContext` sub-ops `agent_studio_implementation_plan.md:659`), Runtime
      events
      (`RunStarted`/`ModelCallStarted`/`Completed`/`ToolCallProposed`/`Approved`/`Completed`/`ApprovalRequested`/`AssistantDelta`/`RunWarning`/`RunFailed`
      arch `agent_studio_architecture.md:263-276`), Persistence
      (`AppendRunEvent`/`SaveCheckpoint`/`SubmitMemoryProposal`/`CommitAssistantMessage`/`RecordUsage`
      arch `agent_studio_architecture.md:278-286` → `commitRunResult→CommitRunResult` etc).
      Language-neutral Protobuf, TypeScript types generated `agent_studio_architecture.md:299` →
      documented in `contracts/mcp/dependency.md`.

- [ ] **2.5** Implement capability + retry policy — `agent_studio_architecture.md:308-314` +
      `agent_studio_implementation_plan.md:665-672` (retry only idempotent; never blindly retry tool
      effects/finalization without stable key; respect deadline + retry-after; bound attempts; map
      `capability expiry`/`stale run`/`terminal run`/`authorization denial`/`protocol mismatch` to
      non-retryable; emit metrics) → `retry.test.ts`, `capability.test.ts`.

- [ ] **2.6** Implement claim-check policy — `agent_studio_implementation_plan.md:674-688` (inline
      only below threshold/classification; larger/sensitive uses Engine-authorized
      `artifact_id`/`organization_id`/`run_id`/`purpose`/`content-type`/`byte length`/`sha256`/`expiry`
      ref, fresh auth on read, ref != bearer token) → `claim-check.test.ts`.

- [ ] **2.7** Implement workload identity + redaction —
      `agent_studio_implementation_plan.md:356-364` + `agent_studio_architecture.md:228-230`
      (`packages/security/src/{workload-identity,capabilities,scope,secret-provider,egress}.ts`,
      secret references not values, payload codec/claim-check thresholds
      `agent_studio_implementation_plan.md:13`) → `scope.test.ts`, `redaction.test.ts`.

- [ ] **2.8** Wire `GetAuthorizedRunContext` types + `AppendRunEvents`/`CommitRunResult` adapters
      via Activities (no workflow direct call) — `agent_studio_implementation_plan.md:1373-1379` →
      `packages/activities/src/mcp-activities.ts` → integration test against fake Engine.

#### Exit gates — Phase 2

- [ ] Fake Engine **conformance suite passes**
      (`packages/neryva-mcp-client/tests/conformance.test.ts`)
      `agent_studio_implementation_plan.md:1383`.
- [ ] **Scope immutability**: injected wrong `organization_id`/`run_id`/`agent_version_id` via
      caller input is rejected (no override) `agent_studio_implementation_plan.md:1384`.
- [ ] **Duplicate calls produce one Engine effect** (idempotency key dedup,
      `neryva_mcp_implementation_plan.md:106` duplicate returns original, conflicting key rejected).
- [ ] Capability expiry + terminal-run rejection are tested (non-retryable mapping)
      `agent_studio_implementation_plan.md:1386`.

---

### Phase 3 — Temporal workflow and worker

_Objective: deterministic `AgentRunWorkflow` + Activities + worker admission
`agent_studio_implementation_plan.md:1388-1407` + `agent_studio_architecture.md:98-143`._

- [ ] **3.1** Create `AgentRunWorkflow` — `agent_studio_implementation_plan.md:289-305`
      (`packages/workflows/src/agent-run-workflow.ts`, `signals.ts`, `queries.ts`, `updates.ts`,
      `workflow-state.ts`, `continue-as-new.ts`, `workflow-timeouts.ts`, `workflow-versioning.ts`) —
      deterministic orchestration only: validate run, call Activities with explicit timeout/retry,
      track budgets, wait on Signals for approval/cancellation/user-input, `Continue-As-New` on
      measured growth `agent_studio_implementation_plan.md:798-806`.

- [ ] **3.2** Enforce determinism rules — `agent_studio_implementation_plan.md:826-838` (no provider
      SDK / MCP network / env `process.env` / `Date`/`Math.random`/UUID / mutable global / unordered
      iteration in workflow; use Temporal deterministic APIs, Activities for effects) →
      `pnpm check:generated` + bundle import scan `agent_studio_implementation_plan.md:1319`.

- [ ] **3.3** Implement Activity interfaces — `agent_studio_implementation_plan.md:808-824` →
      `packages/activities/src/{context-activities,model-activities,tool-activities,mcp-activities,artifact-activities,memory-activities,approval-activities,usage-activities,heartbeat}.ts`
      (all non-deterministic work: MCP, model, tool, artifact, retrieval) →
      `tests: retry-safety.test.ts, heartbeat.test.ts, dependency-failure.test.ts`.

- [ ] **3.4** Declare timeout/retry per Activity class —
      `agent_studio_implementation_plan.md:813-825` (`schedule-to-start` + `start-to-close` +
      `heartbeat` where progress, distinct policies for
      provider/read-only/effectful/approval/artifact/MCP finalization; no blanket retry) → config
      test.

- [ ] **3.5** Implement Temporal payload protection —
      `agent_studio_implementation_plan.md:839-848` +
      `agent_studio_architecture.md:133-143,558-598`:
  - Default: IDs/refs/bounded metadata + Engine artifact references only; never raw
    prompts/documents/credentials/full provider responses in workflow inputs
    `agent_studio_architecture.md:138,595`
  - If bounded non-public value required, use configured **encrypted Temporal payload codec** with
    documented classification, key source, rotation, access policy
    `agent_studio_implementation_plan.md:844`
  - Apply tested `max inline payload size` and reject oversized before scheduling
    `agent_studio_implementation_plan.md:845`
  - Claim-check for large/sensitive/long-retained: tenant/run scoped, purpose-bound,
    checksum-verified, expiring, re-authorized on read `agent_studio_implementation_plan.md:846`
  - CI and tests prove secrets/prohibited classes cannot enter workflow args/activity
    results/logs/default traces `agent_studio_implementation_plan.md:847`
  - Codec does not make Temporal canonical customer-data store and does not replace Engine
    retention/deletion `agent_studio_implementation_plan.md:848` → redaction + size tests.
  - Durable-execution invariants: heartbeat for long activities `agent_studio_architecture.md:137`,
    bounded history via `Continue-As-New` at tested threshold not hard-coded count
    `agent_studio_architecture.md:139`, retry ownership explicit (provider hints but workflow
    applies one bounded policy, respect retry-after, never blindly retry effectful tool
    `agent_studio_architecture.md:140`), tool side effects idempotent
    `agent_studio_architecture.md:141`.

- [ ] **3.6** Wire `RuntimeControlService` admission + Signals/Updates —
      `neryva_mcp_implementation_plan.md:348-366` + `agent_studio_implementation_plan.md:1102-1117`
      (`StartRun` deterministic Workflow ID from `run_id` → no duplicate workflow; `CancelRun`;
      `DeliverRunInput` → Temporal **Signal** by default, **Update** only when sync
      validation/tracking needed; drain pending signals at safe points) →
      `packages/workflows/tests/cancellation.test.ts`.

- [ ] **3.7** Implement heartbeat + Continue-As-New — `agent_studio_architecture.md:134-140` (long
      Activities `RecordHeartbeat` + checkpoint ref, used for Studio's own progress;
      `Continue-As-New` when history approaches tested threshold, never hard-coded event count, keep
      margin) → `tests/heartbeat.test.ts`, `tests/continue-as-new.test.ts`.

- [ ] **3.8** Compose `runtime-worker` + `runtime-control` apps —
      `agent_studio_implementation_plan.md:98-127`
      (`apps/runtime-worker/src/{main,worker,workflow-bundle,activity-registry,dependencies,config,shutdown}.ts`,
      `apps/runtime-control/src/{main,server,routes/{health,readiness,internal-control},auth,config}.ts`)
      — `runtime-control` is stateless, no public customer API, any operational command maps to
      audited MCP/Temporal op `agent_studio_implementation_plan.md:523-525` →
      `tests/startup.test.ts`, `tests/routes.test.ts`.

- [ ] **3.9** Configure Temporal topology — `agent_studio_architecture.md:28,198,242-246` +
      `agent_studio_implementation_plan.md:79`
      (`infra/temporal/{namespaces.md,task-queues.md,retention.md}`, task queues
      `agent-run-default`/`agent-run-long`/`tool-read-only`/`tool-effectful`/`retrieval-indexing`/`evaluation`
      `agent_studio_implementation_plan.md:539-545`, `worker_identity`, `payload_codec_mode`) →
      deployed namespaces documented.

- [ ] **3.10** Add workflow versioning strategy — `agent_studio_implementation_plan.md:850-853`
      (Temporal-compatible version markers, keep old paths until executions finish, no
      replay-breaking deploys without migration) → ADR.

#### Exit gates — Phase 3

- [ ] Simulated **worker crash resumes** or terminates safely without duplicate business effect
      `agent_studio_implementation_plan.md:1403`.
- [ ] **No provider/tool/network imports** exist in workflow bundle (static scan)
      `agent_studio_implementation_plan.md:1404`.
- [ ] **Approval + cancellation are durable** (Signal/Update survives restart, cancel propagates
      Engine→Studio→Temporal→provider/tool) `agent_studio_architecture.md:145-152`,
      `agent_studio_implementation_plan.md:1405`.
- [ ] **Finalization retry cannot duplicate** assistant message (`CommitRunResult` idempotent,
      `neryva_mcp_implementation_plan.md:448-449` epoch fencing)
      `agent_studio_implementation_plan.md:1406`.
- [ ] Workflow replay + `Continue-As-New` tests pass (`packages/workflows/tests/replay.test.ts`,
      `continue-as-new.test.ts`).

---

### Phase 4 — Model Gateway and one provider

_Objective: provider-neutral gateway with one adapter passing the full conformance matrix
`agent_studio_implementation_plan.md:1408-1428` + `agent_studio_architecture.md:409-444`._

- [ ] **4.1** Define Neryva-owned contracts — `agent_studio_architecture.md:432-439` +
      `agent_studio_implementation_plan.md:862-886` →
      `contracts/provider/{model-request,model-response,tool-call,usage,errors}.ts`
      (`NeryvaModelRequest`, `NeryvaModelResponse`, `NeryvaStreamEvent`, `NeryvaToolCall`,
      `NeryvaStructuredOutput`, `NeryvaUsage`, `NeryvaProviderError`, `NeryvaModelCapabilities`) +
      `packages/model-gateway/src/capabilities.ts` — provider types never escape
      `packages/model-gateway` `agent_studio_implementation_plan.md:885`.

- [ ] **4.2** Implement Model Gateway — `agent_studio_architecture.md:409-426` →
      `packages/model-gateway/src/{model-gateway,model-catalog,routing,retry-policy,usage,errors,redaction}.ts`
      (provider adapters + capability registry + org allowlist `agent_studio_architecture.md:413` +
      credentials + failover + rate limits + usage normalization + cost + redaction + tracing +
      error normalization) → `tests/contract.test.ts`.

- [ ] **4.3** Implement provider adapter contract — `agent_studio_implementation_plan.md:890-905` +
      `agent_studio_architecture.md:428` (Vercel AI SDK Core or official SDK behind
      `packages/model-gateway/src/adapters/ai-sdk-adapter.ts`, pin tested major, upgrade via
      conformance) → `packages/model-gateway/src/providers/provider.ts` interface →
      `packages/model-gateway/tests/contract.test.ts`.

- [ ] **4.4** Build first provider adapter (e.g., OpenAI) — `agent_studio_architecture.md:772-790`
      per-provider checklist (streaming, tool calls, structured output, usage, context limits,
      timeout, error normalization, retention) → `packages/model-gateway/src/providers/openai.ts` +
      `tests/providers/openai.test.ts` (11 conformance cases: text, streaming termination, tool
      round-trip, structured success/refusal, timeout, rate-limit+retry-after, invalid request, auth
      failure, usage, cancellation, redaction) `agent_studio_implementation_plan.md:890-903`.

- [ ] **4.5** Implement streaming + usage normalization + structured-output path —
      `agent_studio_architecture.md:84,412-442` →
      `packages/model-gateway/src/adapters/ai-sdk-adapter.ts` (chunks/finish reasons/tool
      args/provider IDs/structured-output success+refusal/usage cache tokens/rate
      limits/retry-after/safety refusals/cancellation `agent_studio_implementation_plan.md:877-886`;
      usage `NeryvaUsage` normalized, cost calculated, redaction applied, request traced) → provider
      usage recorded through Engine/MCP, not local ledger `agent_studio_architecture.md:422`,
      `agent_studio_implementation_plan.md:1427`. Pin AI SDK to tested major, upgrade via adapter
      conformance `agent_studio_architecture.md:442`.

- [ ] **4.5a** Evaluate optional LiteLLM self-hosted gateway route —
      `agent_studio_architecture.md:444` (behind Model Gateway contract for customers requiring
      separate network boundary, must not become core dependency; Python operational dependency) →
      ADR + spike evaluation only; remains `agent_studio_architecture.md:444` optional.

- [ ] **4.6** Implement routing — `agent_studio_architecture.md:909-918`
      (`Engine policy snapshot -> org allowlist -> assistant model policy -> capability -> budget/latency -> health -> adapter`;
      fallback explicit, auditable, never bypasses retention/residency) →
      `packages/model-gateway/src/routing.ts` + `tests/routing.test.ts`.

- [ ] **4.7** Gate providers by capability registry — `agent_studio_architecture.md:405-414`
      (`allowed_models` must reference Model Gateway capability registry, agent cannot select
      arbitrary provider string) → `packages/agent-definition/src/capability-checker.ts` cross-check
      → negative test.

#### Exit gates — Phase 4

- [ ] **One provider can complete a read-only agent run** (no tools or read-only tools, bounded
      loop) `agent_studio_implementation_plan.md:1424`.
- [ ] **Provider types do not escape** gateway (import scan: no raw provider response outside
      `model-gateway`) `agent_studio_implementation_plan.md:1425`.
- [ ] **Credentials only to Activities** (no workflow/provider cred in logs, `packages/security`
      secret-provider port consumed only in `activities`)
      `agent_studio_implementation_plan.md:1426`.
- [ ] **Usage sent through Engine/MCP** (`RecordUsage`/`CommitRunResult`), not a local ledger
      `agent_studio_implementation_plan.md:1427`.
- [ ] First provider passes all 11 conformance cases; `pnpm check:container` clean.

---

### Phase 5 — Context Compiler

_Objective: pure planning/assembly from authorized Engine data
`agent_studio_implementation_plan.md:1429-1448` + `agent_studio_architecture.md:446-481`._

- [ ] **5.1** Model context inputs — `agent_studio_architecture.md:448-462` →
      `packages/context-compiler/src/{compiler,context-inputs,provider-format,citations}.ts`
      (definition + policy snapshot + user message + history + summary + memories + knowledge +
      tools + output schema + provider capabilities + budget) → `tests/budgeting.test.ts`.

- [ ] **5.2** Selectors — `agent_studio_implementation_plan.md:1434` →
      `packages/context-compiler/src/{history-selector,summary-selector,memory-selector,knowledge-selector,tool-selector,token-budget,truncation}.ts`
      (history by `conversation sequence` not timestamp, summaries with `source_range/version`
      `agent_studio_architecture.md:212-218`, approved memories with visibility/expiry, authorized
      knowledge refs, tool schema from `contracts/tool`) → `tests/ordering.test.ts`.

- [ ] **5.3** Budget + truncation — `agent_studio_architecture.md:463-477` (token budgeting, message
      ordering, tool selection, provider conversion, citation tracking) +
      `agent_studio_implementation_plan.md:935-956` (validate scope, load immutable def, select
      history, add summaries, select memories, retrieve via MCP, select tools, reserve budget,
      deterministic ordering/truncation, map to provider, produce citations) → `tests/truncation` +
      provider-format test.

- [ ] **5.4** Invariants (fail-closed) — `agent_studio_implementation_plan.md:957-965` (never
      retrieve-then-authorize `958`, never include expired/deleted/quarantined/unauthorized source
      `959`, never let truncation remove system/policy constraints without safe failure `960`, never
      treat model "memory" as approved `961`, never depend on provider-managed conversation ID
      `962`, record source IDs/versions not just prompt `963`; final rendered prompt is derived
      artifact `agent_studio_architecture.md:479`) → `tests/authorization.test.ts`. Safe failure
      when required policy context cannot be loaded `agent_studio_implementation_plan.md:1440` →
      `MaxAttempts` or `InsufficientContext` error, not truncated unsafe prompt.

- [ ] **5.5** Hybrid retrieval note — `agent_studio_architecture.md:556` +
      `agent_studio_implementation_plan.md:938` (vector + lexical where it improves recall,
      filtering **in query** via `WHERE organization_id` + tenure scope, not post-filter
      `main.md:189`) → documented; enforced in `packages/memory-retrieval` but planned here for
      compiler integration.

- [ ] **5.6** Context stages 11 steps — `agent_studio_implementation_plan.md:943-955` (1 validate
      scope, 2 load immutable def/snapshot, 3 select history by `conversation sequence` not
      timestamp, 4 add summaries with `source_range/version`, 5 select approved memories with
      visibility/expiry, 6 retrieve knowledge via MCP, 7 select tools allowed for step+policy from
      `contracts/tool`, 8 reserve token/cost budget, 9 deterministic ordering/truncation, 10 map to
      provider format, 11 produce citation/source mapping + context diagnostics
      `agent_studio_implementation_plan.md:955`) → integration test; token budgeting
      `agent_studio_architecture.md:466` + message ordering `467` + prompt-cache prep `476`
      included.

- [ ] **5.7** Responsibilities coverage — `agent_studio_architecture.md:464-477` (token budgeting
      `466` + message ordering `467` + summary insertion `468` + memory selection `469` + retrieval
      filtering `470` + hybrid retrieval `471` + tool schema selection `472` + provider format
      conversion `473` + context truncation `474` + prompt-cache prep `476` + citation tracking
      `477`) → checklist header in `packages/context-compiler/src/compiler.ts`.

#### Exit gates — Phase 5

- [ ] Context **rebuildable from Engine references** (prompt is derived, canonical stays in Engine
      `agent_studio_architecture.md:479-481`) `agent_studio_implementation_plan.md:1444`.
- [ ] **No unauthorized retrieval** reaches model (tenant/scope predicate test)
      `agent_studio_implementation_plan.md:1445`.
- [ ] **Long conversations remain bounded** (truncation + summary insertion, history limit, token
      budget) `agent_studio_implementation_plan.md:1446`.
- [ ] Compiler **diagnostics identify omitted/truncated sources** without leaking content
      (hashes/sizes, not raw text) `agent_studio_implementation_plan.md:1447`.
- [ ] Provider-format mapping tested for first provider (`tests/provider-format.test.ts`).

---

### Phase 6 — Tool Gateway and approval

_Objective: policy enforcement boundary + human bridge
`agent_studio_implementation_plan.md:1449-1468` + `agent_studio_architecture.md:483-512`._

- [ ] **6.1** Tool registration — `agent_studio_implementation_plan.md:970-987` →
      `packages/tool-gateway/src/{registry,schema-validation,effect-policy,approval-policy}.ts`
      (fields: `tool_id/version`, `input/output schema`,
      `effect_class: READ_ONLY|MUTATING|DESTRUCTIVE` `agent_studio_implementation_plan.md:975-977`
      (note: `WRITE` in arch `482-487` is split to `MUTATING`/`DESTRUCTIVE` here),
      `approval_requirement: NONE|REQUIRED`, credential ref, org/agent scopes, egress class,
      timeout, idempotency, redaction, audit event, `execution mode: in-process|activity|sandbox`
      `agent_studio_implementation_plan.md:986`).

- [ ] **6.2** Enforce separation — `agent_studio_implementation_plan.md:989` (`effect_class` vs
      `approval_requirement` orthogonal; read-only can require approval, mutating can be
      pre-approved only under explicit policy) → policy matrix test.

- [ ] **6.3** 10-step tool-call flow — `agent_studio_implementation_plan.md:992-1006` →
      `packages/tool-gateway/src/tool-gateway.ts` (model proposal → parse+schema-validate → resolve
      version → capability/tenant scope → org/agent policy → budget/rate/timeout → approval if
      required → derive `run_id+step_id` idempotency → execute with scoped credential + egress →
      redact+bound result → persist via Engine/MCP → return to kernel).

- [ ] **6.4** Side-effect safety — `agent_studio_architecture.md:507-510` +
      `agent_studio_implementation_plan.md:1008-1017` (Temporal at-least-once: stable
      `run_id+step_id+tool_version` key, persist before ack, query/reconcile by key on lost
      response, `UNKNOWN_OUTCOME` when unprovable, never blindly retry) →
      `tests/idempotency.test.ts`.

- [ ] **6.5** Tool isolation — `agent_studio_architecture.md:400-405,584-596` +
      `agent_studio_implementation_plan.md:1018-1029` (`executors/{in-process,activity,sandbox}.ts`,
      sandbox for customer code / untrusted parsers / broad network / sensitive creds / high CPU,
      with workload identity, FS isolation, CPU/mem/time limits, restricted egress, no ambient
      creds, audit) → `tests/sandbox-boundary.test.ts` + optional
      `apps/tool-worker/src/{main,worker,sandbox,config}.ts`.

- [ ] **6.6** Gateway checks 1–10 — `agent_studio_architecture.md:486-506` (1 validate tool name, 2
      args schema, 3 tenant/user scope, 4 org policy, 5 rate/cost limits, 6 human approval, 7
      execute with scoped credential, 8 record request+result, 9 idempotency, 10 return only
      permitted result `agent_studio_architecture.md:495-506`) + scoped credential
      `packages/tool-gateway/src/credentials.ts` + egress `egress-policy.ts` + redaction
      `result-redaction.ts` + `packages/tool-gateway/src/tool-context.ts`; Engine never exposes raw
      DB access as model tool `agent_studio_architecture.md:508` → `tests/authorization.test.ts`.

- [ ] **6.7** Approval bridge — `agent_studio_implementation_plan.md:1102-1117` +
      `agent_studio_architecture.md:328-336` (`CreateApprovalRequest` → Engine persists + outbox →
      `WAITING_APPROVAL` → human via Engine API → decision with one-time ID → `DeliverRunInput` via
      outbox → Temporal **Signal** default, **Update** only when sync validation needed → workflow
      validates correlation, `RequestApproval` → `ExecuteTool` → `ModelStep`) →
      `tests/approval.test.ts`.

- [ ] **6.8** One mutating tool with idempotent fake — `agent_studio_implementation_plan.md:1457`
      (e.g., `create_ticket` `agent_studio_architecture.md:373-389` with `approval: required`, fake
      external system supports idempotency lookup) → activity test proves duplicate delivery safe.

#### Exit gates — Phase 6

- [ ] **Model cannot self-authorize** an effectful action (policy/approval enforced after proposal,
      prompt injection attempt ignored) `agent_studio_implementation_plan.md:1464`.
- [ ] **Duplicate activity delivery does not duplicate** fake external effect (stable idempotency
      key, downstream dedup before ack) `agent_studio_implementation_plan.md:1465`.
- [ ] **Lost response → `UNKNOWN_OUTCOME` / reconciliation path** (not silent success)
      `agent_studio_implementation_plan.md:1466`.
- [ ] **Approval is auditable** + correlated to one logical `tool_call_id`/`step_id` (idempotent,
      scoped to `org/run/tool_call/approval_id/policy_version`
      `agent_studio_implementation_plan.md:1116`) `agent_studio_implementation_plan.md:1467`.

---

### Phase 7 — Memory, knowledge, and artifacts

_Objective: Engine-authorized retrieval + claim-check, citation
`agent_studio_implementation_plan.md:1469-1487` + `agent_studio_architecture.md:513-597`._

- [ ] **7.1** Memory/retrieval clients — `agent_studio_implementation_plan.md:1034-1055` →
      `packages/memory-retrieval/src/{memory-client,knowledge-client,retrieval-policy,query-planner,citation-mapper,result-limits}.ts`
      (calls `GetAuthorizedRunContext`/`SearchKnowledge`/`GetMemories` via MCP, never direct
      PG/vector creds `agent_studio_implementation_plan.md:486`) → `tests/tenant-filter.test.ts`.

- [ ] **7.2** Retrieval contract — `agent_studio_implementation_plan.md:1042-1055` (per result:
      `source_id/document_version_id/chunk_id`, `organization/visibility scope`, `relevance`,
      `bounded content` or `artifact ref`, `citation`, `policy version`; fail-closed if Engine omits
      scope/provenance) → `tests/citation.test.ts`.

- [ ] **7.3** Artifact claim-check — `agent_studio_implementation_plan.md:325-340` +
      `engine/drizzle/0026` (`artifacts` `organization_id`+`purpose` enum+`object_key`
      tenant-bound+`sha256`/`byte_length`/`encryption_key_ref`/`retention_class`) →
      `packages/artifacts/src/{references,reader,writer,checksums,size-policy,encryption,retention}.ts`
      (max inline bytes + max artifact bytes per `agent_studio_implementation_plan.md:589-594`) →
      `tests/authorization.test.ts`, `checksum.test.ts`.

- [ ] **7.4** Size/checksum/purpose enforcement — `agent_studio_implementation_plan.md:341-352`
      (reject oversized workflow args, checksum-mismatch, sensitive-classification oversize;
      artifact ref = tenant/run scoped, purpose-bound, checksum-verified, expiring, re-authorized on
      read) → `tests/size-policy.test.ts`.

- [ ] **7.5** Memory proposal flow — `agent_studio_architecture.md:522-554` (Agent proposes → Engine
      validates scope/policy → optional approval → stored with
      `provenance/confidence/expiry/visibility/deletion/embedding_ref`
      `agent_studio_architecture.md:309-318,535-553`; agent never treats `"remember this"` as truth)
      → `packages/memory-retrieval` submits `SubmitMemoryProposal`, Engine decides → property test.

- [ ] **7.6** Knowledge split — `agent_studio_architecture.md:536-544` (original files in object
      store, metadata in Engine, parsed text/chunks/embeddings/version/ACL in derived index; vector
      search tenant-authorized **before** retrieval; initial `pgvector`
      `agent_studio_architecture.md:27`, measured migration trigger, hybrid retrieval optional) →
      documented; Studio filters only return `READY`, non-expired, non-deleted.

- [ ] **7.7** Long-result + citation handling — `agent_studio_architecture.md:477` +
      `agent_studio_implementation_plan.md:1478` (long tool results/transcripts via artifact
      `artifact_id/organization_id/run_id/purpose/content-type/byte length/sha256/expiry`
      `agent_studio_implementation_plan.md:674`; citation tracking from retrieval
      `agent_studio_architecture.md:477` with source document/version/chunk provenance
      `agent_studio_implementation_plan.md:1042`) → `tests/result-limit.test.ts` +
      `citation.test.ts`.

#### Exit gates — Phase 7

- [ ] **Only authorized/ready sources** reach context (tenant predicate + `READY` + non-expired +
      visibility check) `agent_studio_implementation_plan.md:1483`.
- [ ] **Large data never enters workflow args** (claim-check threshold + size-policy tests)
      `agent_studio_implementation_plan.md:1484`.
- [ ] **Artifact substitution + cross-tenant tests pass** (ref tamper → rejected, other org artifact
      unreadable) `agent_studio_implementation_plan.md:1485`.
- [ ] **Deletion/expiry makes stale refs unusable** (artifact deleted/quarantined → `GetRunArtifact`
      denied, context excludes it) `agent_studio_implementation_plan.md:1486`.

---

### Phase 8 — Streaming and operational observability

_Objective: durable semantic events + resumable frontend observation via Engine
`agent_studio_implementation_plan.md:1488-1505` + `agent_studio_architecture.md:258-278`._

- [ ] **8.1** Durable semantic events — `agent_studio_implementation_plan.md:1063-1076` →
      `contracts/events/runtime-events.ts` via `AppendRunEvents`/`CommitRunResult`
      (`RunStarted/ContextPrepared/ModelCallStarted/Completed/ToolCallProposed/Approved/Completed/ApprovalRequested/Received/MemoryProposed/RunWarning/RunCompleted/RunFailed`)
      → `packages/activities` emits after step outcome known, stable `event_id`/`idempotency key`,
      payload bounded else artifact ref `agent_studio_implementation_plan.md:1080-1089`.

- [ ] **8.2** Event emission rules — `agent_studio_implementation_plan.md:1080-1089` (idempotency
      key, emit after outcome, bound size, artifact ref for large, Engine sequence authoritative,
      retry only idempotent appends, don't block workflow on best-effort) → `packages/telemetry`
      metric `run_events_appended_total`.

- [ ] **8.3** Ephemeral delta path (optional transient) —
      `agent_studio_implementation_plan.md:1091-1101` → Redis/Valkey
      scoped/TTL/bounded-buffer/backpressure (`max fan-out consumers per run`, `drop oldest deltas`
      while retaining terminal/semantic), no creds, never assumed delivered, reconciled via Engine
      `agent_studio_architecture.md:304` → documented; feature-flagged.

- [ ] **8.4** Engine streaming contract — `main.md:104-105,408-431` (frontend subscribes to
      **Engine** SSE/WebSocket via `request_id`/`run_id`/`sequence_number`/`event_id`, reconnects
      with last event ID; Engine owns canonical history, token deltas via Redis/ephemeral, final
      message durable) → `apps/runtime-control` exposes health but **not** customer streaming;
      Engine's `WatchRunEvents`/`ListRunEvents` remains transport → integration test via Engine.

- [ ] **8.5** OTel spans + metrics — `agent_studio_implementation_plan.md:1137-1162` →
      `packages/telemetry/src/{traces,metrics,attributes,redaction,sampling,semantic-conventions}.ts`
      (span hierarchy
      `Engine MCP -> workflow run -> context/model->provider/tool->external/approval->finalization`
      `agent_studio_implementation_plan.md:1139-1150`, W3C context propagation across
      MCP/Temporal/provider/tool, low-cardinality attrs + `run/correlation` refs, coalesce duplicate
      GenAI convention generations not sum tokens `agent_studio_architecture.md:670`) →
      `tests/redaction.test.ts`.

- [ ] **8.6** Telemetry data policy — `agent_studio_implementation_plan.md:1153-1161` (default: no
      prompts/full docs/tool args/credentials; store hashes/sizes/classifications/artifact IDs;
      diagnostic content only under expiring authorized mode; usage from Engine ledger not span
      sums; no high-cardinality labels like raw user IDs) → audit + metric exposition test.

#### Exit gates — Phase 8

- [ ] **Frontend observation survives disconnect/reconnect through Engine** (cursor replay via
      Engine `ListRunEvents`/`WatchRunEvents`, `main.md:408-431`)
      `agent_studio_implementation_plan.md:1501`.
- [ ] **Durable final result does not depend on delta delivery** (ephemeral path loss still yields
      `CommitRunResult` durable message) `agent_studio_implementation_plan.md:1502`.
- [ ] **Trace correlation works** Engine→MCP→Temporal→provider→tool (single `trace_id` + `run_id` +
      `correlation_id`) `agent_studio_implementation_plan.md:1503`.
- [ ] **Sensitive content absent** from default logs/traces (redaction test)
      `agent_studio_implementation_plan.md:1504`.

---

### Phase 9 — Provider expansion and failure matrix

_Objective: add providers one-by-one only after common adapter stable
`agent_studio_implementation_plan.md:1506-1516` + `agent_studio_architecture.md:772-791`._

- [ ] **9.1** Add second provider (Anthropic) — `agent_studio_implementation_plan.md:777` →
      `packages/model-gateway/src/providers/anthropic.ts` + `tests/providers/anthropic.test.ts`
      (same 11 conformance cases as 4.4, plus `context limits`/`retention configuration`
      `agent_studio_architecture.md:789`).

- [ ] **9.2** Add third provider (Google) — `agent_studio_architecture.md:778` →
      `packages/model-gateway/src/providers/google.ts` + adapter tests.

- [ ] **9.3** Per-provider matrix published — `agent_studio_implementation_plan.md:1511-1513`
      (streaming, tools, structured output, usage, context limits, timeout, error normalization,
      retention, cancellation) per provider, with `unsupported → clear failure` not silent degrade
      `agent_studio_implementation_plan.md:1513` → `contracts/provider/*.md` matrix +
      `packages/model-gateway/src/capabilities.ts`.

- [ ] **9.4** Fallback policy tested — `agent_studio_architecture.md:785` +
      `agent_studio_implementation_plan.md:1515` (fallback explicit/auditable, preserves
      output/tool/schema compat, never bypasses org retention/residency) → `tests/routing.test.ts`
      covers fallback paths.

- [ ] **9.5** Usage reconciliation — `agent_studio_implementation_plan.md:1515` (provider-normalized
      `NeryvaUsage` matches Engine `usage_ledger_entries` `drizzle/0027`; ceiling span-sum vs ledger
      not summed) → `tests/usage.test.ts` + billing ledger join test (requires Engine test env).

#### Exit gates — Phase 9

- [ ] **Provider matrix is explicit and visible** (docs + capability registry)
      `agent_studio_implementation_plan.md:1512`.
- [ ] **Unsupported features fail clearly** (typed error, no silent degrade)
      `agent_studio_implementation_plan.md:1513`.
- [ ] **Fallback is policy-controlled and auditable** (Engine snapshot + gateway log)
      `agent_studio_implementation_plan.md:1514`.
- [ ] **Usage normalization reconciled** with Engine records (ledger vs gateway metric delta within
      policy) `agent_studio_implementation_plan.md:1515`.

---

### Phase 10 — Hardening, evaluation, and production readiness

_Objective: `agent_studio_architecture.md:793-807` + `agent_studio_implementation_plan.md:1518-1536`
Enterprise verification. Do not enter without Phases 0–9 green._

- [ ] **10.1** Tenant isolation + RLS-equivalent tests — `agent_studio_architecture.md:659-666`
      (rows/objects/vectors/cache all scoped) + `agent_studio_implementation_plan.md:1266-1276`
      (every repo/MCP query requires tenant scope or is global-reviewed; RLS on new
      `agent_definition` storage if any, object keys namespaced by `organization_id`, vector
      collections namespaced `agent_studio_architecture.md:381-383`, `packages/security` scope
      check) → `tests/isolation/*.test.ts`.

- [ ] **10.2** Secrets + encryption — `agent_studio_architecture.md:803` +
      `agent_studio_implementation_plan.md:1296-1322` (provider creds via workload secret provider,
      encrypted payload codec/claim-check `agent_studio_architecture.md:137-140`,
      `engine/src/.../secrets` referenced but Studio holds no plaintext in history/logs; key
      rotation without downtime `agent_studio_architecture.md:308-314`) →
      `packages/security/src/secret-provider.ts` + distribution test.

- [ ] **10.3** Prompt-injection + tool misuse suites —
      `agent_studio_implementation_plan.md:1194-1205,1521` (all model/retrieved/tool/external
      content as untrusted `agent_studio_implementation_plan.md:1196-1204`; cannot change tenant
      scope/policy/tool allowlist/persistence; retrieval-injection
      `agent_studio_implementation_plan.md:1270`) → `tests/security/*.test.ts` + red-team fixtures.

- [ ] **10.4** Load & tenant-skew tests — `agent_studio_architecture.md:804-805` +
      `agent_studio_implementation_plan.md:1522` (horizontal worker scaling
      `agent_studio_architecture.md:376-394`, per-org quotas/rate limits
      `agent_studio_architecture.md:384`, `agent-run-default` queue
      `agent_studio_implementation_plan.md:539-547`; measure
      `100 orgs / 10k conversations / many stateless workers`
      `agent_studio_architecture.md:385-394`) → `tests/load/*.test.ts` (tenant-skew, long
      conversations, event reconnects).

- [ ] **10.5** Chaos / failure-injection — `agent_studio_implementation_plan.md:1523` +
      `agent_studio_architecture.md:1555-1573` failure matrix (worker crash before/after claim,
      model timeout, tool ambiguous timeout, MCP response lost, approval before/after wait,
      capability expiry, version unpublished, artifact expiry, Redis/broker down, Temporal down,
      deploy workflow change, cancellation) each with Recovery path + test
      `agent_studio_implementation_plan.md:1555-1573` → `tests/chaos/*` using
      `testkit/fault-injection.ts`.

- [ ] **10.6** History growth + `Continue-As-New` — `agent_studio_architecture.md:135-140,646-648`
      (measure payload codec + event shape + workload to pick tested safety threshold, never copy
      `75000` folklore) → `tests/temporal/continue-as-new.test.ts` + load result with `p50/p95/p99`
      and config.

- [ ] **10.7** Sandbox / `tool-worker` deployment where required —
      `agent_studio_architecture.md:400-405,636-644` +
      `agent_studio_implementation_plan.md:1525,536-547` (isolated network/CPU/FS, dedicated pools
      for expensive/privileged tools) → `infra/kubernetes/*`,
      `infra/policies/{network-egress,workload-identity,sandbox}`,
      `infra/docker/tool-worker.Dockerfile` → deploy test.

- [ ] **10.8** Supply chain — `agent_studio_implementation_plan.md:1526,1322` (lockfiles pinned,
      SBOM, signed artifacts, `pnpm check:dependencies`, `pnpm check:container`, SAST/dependency
      scanning, code signing) → CI artifacts + `ops/runbooks/security-incident.md`.

- [ ] **10.9** Dashboards / SLOs / alerts — `agent_studio_architecture.md:24,32` (OTel) +
      `agent_studio_implementation_plan.md:1527`
      (`infra/observability/{dashboards,alerts,service-level-objectives.md}`: workflow
      start/completion, activity retries, provider latency/errors, tool denials, approval age,
      budget exhaustion, MCP errors, event lag, artifact failures
      `agent_studio_implementation_plan.md:1160`) → SLOs measured, not copied
      `agent_studio_architecture.md:772`.

- [ ] **10.10** Evaluation datasets — `agent_studio_implementation_plan.md:1278-1291,1528`
      (brand/policy adherence, refusal/escalation, tool selection/args, citation grounding,
      isolation/redaction, injection resistance, provider compat, regression of published versions;
      each result carries
      `agent_version`/`model`/`definition hash`/`dataset version`/`evaluator version`/`thresholds`;
      eval never bypasses security/transaction tests) → `tests/evaluation/*` +
      `packages/eval-worker` (flagged).

- [ ] **10.11** Restore/replay + incident drills — `agent_studio_architecture.md:798-805` (worker
      crash, provider timeout, cancellation, worker failover, replay debugging) +
      `agent_studio_implementation_plan.md:1529` (restore/replay drills, quarantining run without
      DB) → runbook + drill evidence.

#### Exit gates — Phase 10

- [ ] **Definition of done holds** (`agent_studio_implementation_plan.md:1594-1611` — pinned version
      execution, bounded/authorized context, idempotent scoped tools, durable approval/cancellation,
      replay-safe activities, claim-check large payloads, Engine-authoritative final message, no DB
      access, no provider type leakage, isolation/redaction/injection tests, OTel correlation,
      build/container/SBOM/load/chaos/evaluation gates) `agent_studio_implementation_plan.md:1533`.
- [ ] **All high-risk threat-model items have evidence** (scoped per
      `agent_studio_implementation_plan.md:1534` + STRIDE from Engine
      `docs/architecture/engine/threat-model.md`).
- [ ] **On-call can diagnose/replay/quarantine** a run without direct DB access (trace viewer +
      `runtime-control` internal + `GetRun`/`ListRunEvents`)
      `agent_studio_implementation_plan.md:1535`.
- [ ] **Declared SLOs + capacity limits are measured** (load/chaos results stored with
      version/hardware) `agent_studio_implementation_plan.md:1536`.

---

### Phase 11 — Authoring and evaluation product surface

_Objective: UI/API that **produces** immutable versions, never mutates live workflow
`agent_studio_implementation_plan.md:1539-1552` + `agent_studio_architecture.md:808-827`. Only after
runtime correctness._

- [ ] **11.1** Agent configuration editor — `agent_studio_architecture.md:813-817` (brand/config,
      prompt editor, tool permission editor, knowledge-source selector, model selector
      `agent_studio_architecture.md:364-372` `allowed_models` from capability registry, guardrail
      config) → `apps/runtime-control/src/routes/internal-control.ts` (audited, scope-tight) or
      separate console app.

- [ ] **11.2** Validation + version comparison — `agent_studio_architecture.md:392-395` +
      `agent_studio_implementation_plan.md:1542-1548` (draft validation via
      `packages/agent-definition`, publish/rollback through Engine `assistants` API `drizzle/0020`,
      `policy_snapshots` `0021`; version comparison + rollback `agent_studio_architecture.md:825`) →
      `contracts/agent-definition/examples/` + integration test.

- [ ] **11.3** Test conversations — `agent_studio_architecture.md:819` +
      `agent_studio_implementation_plan.md:1546` (isolated budget, marked `test data`, never mixes
      canonical trail) → `apps/eval-worker/src/{main,worker,config}.ts` (synthetic data, not
      production content `agent_studio_implementation_plan.md:533`).

- [ ] **11.4** Trace viewer (redacted) — `agent_studio_architecture.md:820` +
      `agent_studio_implementation_plan.md:1547` (`artifact IDs`/hashes not raw prompts; uses
      `packages/telemetry` + Engine `ListRunEvents`) → viewer integration test.

- [ ] **11.5** Evaluation runner + reports — `agent_studio_architecture.md:822,834` +
      `agent_studio_implementation_plan.md:1548` (offline/controlled, recorded fixtures, thresholds)
      → `apps/eval-worker` + `contracts/events/evaluation-events.ts` + `tests/evaluation/*`.

- [ ] **11.6** Editors for tool/knowledge/model policy — `agent_studio_implementation_plan.md:1549`
      (permission matrix, allowed model/policy, retrieval scope) → must round-trip through Engine
      validation (approval path `engine/src/modules/assistants/*`).

#### Exit gates — Phase 11

- [ ] **Authoring produces Engine-owned immutable versions**; never mutates live workflow
      (`published_configs` analogue `engine/drizzle/0016` shows pattern)
      `agent_studio_implementation_plan.md:1551`.
- [ ] **Draft/publish/rollback + version comparison** pass
      (`export/import deterministic + schema_version` `engine/imp/ledger.md:238` analogue).
- [ ] **Trace/eval never expose secrets** (redaction sample + approval-gated diagnostic mode
      `agent_studio_implementation_plan.md:1157`).

---

## 6. Cross-phase verification (must stay green from Phase 0 onward)

### Unit tests `agent_studio_implementation_plan.md:1212-1223`

- [ ] Kernel transitions + terminal-state rules, budget/cost reservations, definition version
      compat, context ordering/truncation/budgeting, provider error classification, tool
      effect/approval combos, step ID derivation, artifact size/checksum/purpose, telemetry
      redaction

### Neryva MCP contract tests `agent_studio_implementation_plan.md:1224-1235`

- [ ] Generated client/server compat, required envelope
      (`request_id`/`organization_id`/`conversation_id`/`run_id`/`agent_version_id`/`correlation_id`/`protocol_version`/`idempotency_key`
      `agent_studio_architecture.md:315-324`), version negotiation, scope immutability, capability
      expiry/revocation, idempotent retries (only idempotent methods, never blind retry tool
      effects/finalization without stable key `agent_studio_implementation_plan.md:665`), error
      mapping, claim-check auth, event payload bounds (`max inline bytes`
      `agent_studio_implementation_plan.md:594`)

### Temporal tests `agent_studio_implementation_plan.md:1236-1247`

- [ ] Workflow replay from recorded histories, worker crash at every activity boundary, activity
      retry and heartbeat behavior (`RecordHeartbeat` `agent_studio_architecture.md:137`), signal
      delivery before/after workflow wait, duplicate approval/input, cancellation during
      model/tool/approval waits, `Continue-As-New` state carry-over with measured threshold not
      hard-coded `agent_studio_architecture.md:139`, workflow version compatibility (Temporal
      versioning `agent_studio_implementation_plan.md:851`), terminal finalization retry (idempotent
      `CommitRunResult`)

### Provider tests `agent_studio_implementation_plan.md:1248-1251`

- [ ] Fake providers for deterministic unit tests; provider sandbox/fixture conformance for real
      adapters (11 cases per provider `agent_studio_implementation_plan.md:890-903`); live contract
      tests only in protected scheduled pipeline with synthetic data and spending limits; do not
      copy vendor latency/package-size claims without Neryva benchmarks
      `agent_studio_architecture.md:442`

### Tool tests `agent_studio_implementation_plan.md:1252-1264`

- [ ] Schema rejection, tenant/scope mismatch, approval requirement, credential scoping, egress
      policy (restricted egress `agent_studio_implementation_plan.md:1028` +
      `infra/policies/network-egress/`), timeout/cancellation, duplicate execution (stable
      `run_id+step_id+tool_version` `agent_studio_implementation_plan.md:1012`),
      lost-response/`UNKNOWN_OUTCOME` `agent_studio_implementation_plan.md:1016`, redaction/size
      limits, sandbox escape attempts

### Security tests `agent_studio_implementation_plan.md:1265-1276`

- [ ] Cross-tenant capability confusion, model/tool policy bypass, prompt injection with retrieved
      content `agent_studio_implementation_plan.md:1269`, secret exfiltration attempts, artifact
      reference substitution `agent_studio_implementation_plan.md:1271`, replay of expired/reused
      capability `agent_studio_implementation_plan.md:1272`, malicious provider/tool response
      `agent_studio_implementation_plan.md:1273`, log/trace redaction
      `agent_studio_implementation_plan.md:1274`, dependency/container scanning
      `agent_studio_implementation_plan.md:1275` — plus capability fields
      `signature/key version, expiration, not-before, org/conversation/run/agent version, actor identity, allowed capabilities, replay protection`
      `agent_studio_implementation_plan.md:1177-1190`

### Property & concurrency tests `agent_studio_implementation_plan.md:1236-1247 + engine analogs`

- [ ] Property: arbitrary duplicate/reordered event delivery, repeated idempotent command with lost
      response, concurrent publish/cancellation/completion, lease epoch fencing, cursor replay with
      gaps/duplicates → invariant: retries/duplicates/worker replacements cannot produce conflicting
      canonical business state

### Evaluation tests `agent_studio_implementation_plan.md:1277-1291`

- [ ] Brand/policy adherence, refusal/escalation, tool selection correctness, citation grounding,
      isolation/redaction, injection resistance, provider compatibility, regression of published
      versions (each report carries
      `agent_version`/`model`/`definition hash`/`dataset version`/`evaluator`/`thresholds`;
      favorable eval never bypasses security/transaction tests
      `agent_studio_implementation_plan.md:1291`)

---

## 7. Development and CI commands `agent_studio_implementation_plan.md:1292-1323`

Required gates (names may follow repo tooling, semantics must match):

```
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test:unit
pnpm test:contract
pnpm test:workflow
pnpm test:integration
pnpm test:isolation
pnpm test:security
pnpm test:property
pnpm build
pnpm check:generated       # buf generate + git diff --exit-code gen/ts + bundle determinism
pnpm check:dependencies    # package DAG + forbidden-import scan
pnpm check:container       # Dockerfile + image scan + SBOM
```

CI must verify `agent_studio_implementation_plan.md:1314-1322`:

- [ ] generated Protobuf output is current
- [ ] workflow bundle contains only deterministic imports
- [ ] package dependency direction is valid
- [ ] no forbidden DB/provider imports exist in restricted packages
- [ ] all supported providers pass conformance matrix
- [ ] test fixtures contain no production customer data
- [ ] lockfile + SBOM updated consistently

---

## 8. Failure matrix to implement before production `agent_studio_implementation_plan.md:1553-1573`

| Failure                                   | Expected behavior                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Worker crashes before MCP run claim       | Engine run remains dispatchable; redelivery safe (deterministic Workflow ID)                       |
| Worker crashes after claim                | Lease epoch fences stale worker; renewed or expired via `AcquireOrRenewRunLease`/`ReleaseRunLease` |
| Model response times out                  | Activity classifies (`NeryvaProviderError`), bounded retry/fallback or terminal failure            |
| Provider response lost after generation   | Do not duplicate effectful op blindly; use provider/request identity where supported               |
| Tool effect occurs + activity times out   | Reconcile by `run_id+step_id` key; `UNKNOWN_OUTCOME` if unresolved                                 |
| MCP response lost after `AppendRunEvents` | Retry idempotently; Engine sequence remains canonical                                              |
| Approval arrives before workflow waits    | Signal durable + correlated; workflow consumes once (drain at safe points)                         |
| Approval after cancellation               | Engine/Studio rejects as stale without resuming canceled run                                       |
| Capability expires mid-run                | Refresh only via authorized Engine path; otherwise fail safely                                     |
| Assistant version unpublished             | Existing run continues pinned unless policy explicitly cancels                                     |
| Knowledge source deleted during retrieval | Result rejected/marked stale; never included in future context                                     |
| Artifact reference expires                | Typed `unavailable` error; workflow handles                                                        |
| Redis/broker unavailable                  | Durable result path continues; ephemeral deltas may drop                                           |
| Temporal unavailable                      | Engine keeps `ACCEPTED/PENDING`; dispatcher/claim retries                                          |
| Process receives cancellation             | Stop new effects, heartbeat/close, emit terminal outcome                                           |
| Deploy changes workflow code              | Versioned workflow path preserves replay                                                           |

---

## 9. Operational runbooks required `agent_studio_implementation_plan.md:1574-1592`

- [ ] Worker crash + task-queue backlog (`agent-run-default` / `tool-*` pools)
- [ ] Stuck or expired run claim / lease epoch conflict
- [ ] MCP capability/key rotation (`kid` overlap, `exp` handling)
- [ ] Protocol incompatibility (`protocol_version` negotiation)
- [ ] Provider outage / rate limit / credential failure
- [ ] Tool side effect `UNKNOWN_OUTCOME` reconciliation (stable idempotency key, downstream dedup,
      `neryva_mcp_implementation_plan.md:609-616`)
- [ ] Approval signal not received / duplicated
- [ ] Workflow replay / version failure
- [ ] History growth + `Continue-As-New`
- [ ] Artifact/claim-check access failure (7-check facade)
- [ ] Retrieval outage / stale index
- [ ] Cross-tenant isolation incident (scope-forgery response)
- [ ] Prompt injection / tool misuse incident
- [ ] Secret exposure / provider credential rotation
- [ ] Trace/log redaction failure
- [ ] Noisy-neighbor throttling per organization
- [ ] Emergency provider/model/tool disablement (allowlist flip + audit)

---

## 10. Definition of done for Agent Studio implementation `agent_studio_implementation_plan.md:1594-1611`

Agent Studio is ready for production integration **only when all true**:

- [ ] Runtime worker executes a **pinned** agent version through Neryva MCP + Temporal
- [ ] Model Gateway supports the tested **provider feature matrix** (streaming, tools, structured
      output, usage, cancellation, context limits)
- [ ] Context compilation is deterministic, bounded, authorized, reproducible from Engine data
- [ ] Tool execution is policy-controlled, scoped, auditable, idempotent for supported effects
- [ ] Human approval + cancellation survive **worker/process restarts**
- [ ] Workflow code is **replay-safe** + Activity retry tested
- [ ] Large/sensitive payloads use **authorized claim-check refs** (not inline unbounded)
- [ ] Durable semantic events + final message reach Engine; token streaming is optional +
      recoverable (`main.md:304`)
- [ ] **No** Agent Studio package has direct Engine DB access
      (`agent_studio_implementation_plan.md:493`)
- [ ] **No** provider SDK type/credential escapes Model Gateway boundary
      (`agent_studio_implementation_plan.md:485,875`)
- [ ] Tenant, capability, artifact, prompt-injection, secret-redaction tests pass
- [ ] OTel traces/metrics correlate workflows, MCP calls, providers, tools, Engine runs
      (`agent_studio_architecture.md:669`)
- [ ] Build, dependency, container, SBOM, load, chaos, evaluation gates pass
- [ ] Runbooks + on-call ownership complete

> Plus the 8 enterprise verifications `agent_studio_architecture.md:653-667` (tenant-isolated,
> scoped creds, auditable, deletable, provider-portable, allowlisted, metered, regionally
> deployable).

---

## 11. Final implementation recommendation `agent_studio_implementation_plan.md:1613-1632`

Start coding only after the team accepts this shape:

```
TypeScript + Node.js LTS
pnpm workspace monorepo
Temporal TypeScript SDK
Neryva MCP generated client (@neryva/mcp-contract)
custom agent kernel + Context Compiler + Tool Gateway + provider-neutral Model Gateway
Engine-authorized memory/retrieval/artifacts (pgvector initially, NATS JetStream when durable fan-out required)
OpenTelemetry
separate runtime-worker + internal runtime-control deployments
optional isolated tool-worker / eval-worker
```

Adopt generic infrastructure; own everything that differentiates Neryva or protects customer data
`agent_studio_architecture.md:619-622`.

---

## Verification sources `agent_studio_architecture.md:35-36,669`

Temporal docs + TypeScript SDK (`agent_studio_architecture.md:35-36`), Vercel AI SDK
(`agent_studio_architecture.md:84`), Protobuf/gRPC (`agent_studio_architecture.md:24`), OTel GenAI
conventions (`agent_studio_architecture.md:669`, `agent_studio_implementation_plan.md:670`),
`main.md:189-223` (OWASP/RBAC/NATS), `neryva_mcp_implementation_plan.md:13,194,232,292,292,566,682`
(ConnectRPC/Buf/Protovalidate/tenant WHERE/capability).

## Companion ledgers

- Engine: `../../engine/imp/ledger.md` (12 phases, Phases 0–2 substantially complete)
- Neryva MCP: `../../neryva_mcp/ledger.md` (9 phases, contract `v1` authoritative; Agent Studio
  consumes via `contracts/mcp/dependency.md`)

## Change log

- 2026-09-02 (triple-check pass): Verified against `agent_studio_architecture.md:1-862`,
  `agent_studio_implementation_plan.md:1-1632`, `main.md:1-444`, `neryva_mcp/ledger.md`,
  `engine/imp/ledger.md`, `buf.yaml`, `buf.gen.yaml`, `engine/drizzle/0020-0028`,
  `engine/ownership-map.json`. Added: product model, frontend contract, Neryva MCP 4-area mapping,
  LiteLLM optional ADR, spike PoC criteria, full allowed/forbidden dependency tables, typed config
  groups, payload protection invariants, hybrid retrieval, tool DB tool forbidden, three-way
  verification, guardrails, responsibility split, frontend contract, state separation, security
  invariants (workload/capability/prompt-injection), long-result handling, structured-output path,
  safe context failure, UNKNOWN_OUTCOME typo fix, and persistence design details. No task omitted;
  gaps closed.
- 2026-09-02: Initial ledger. Mirrors `engine/imp/ledger.md` granularity. Pending work: none — ready
  for `Phase 0.1` workspace bootstrap.
