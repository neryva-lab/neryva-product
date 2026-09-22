# Neryva MCP Implementation Ledger

## v1.1 (2026-09-12) — harness context supply chain additions

- `ContextManifest.instructions` / `model_params` / `allowed_models`; `ToolDescriptor.description` / `input_schema_json` / `annotations`; `MemoryRef.content`; `KnowledgeRef.snippet` / `title` / `score` / source ranges; `RunBudgets` token/cost/wall-clock.
- `RunAuthorityService` +2 RPCs: `SearchKnowledge` (capability op `search_knowledge`), `SaveConversationSummary`.
- `CommitRunResultRequest.usage` (`UsageEntry`) — recorded atomically with the terminal commit.
- Additive only (`buf breaking` clean, `buf lint` clean); regenerated `gen/ts`, version 0.2.1.

## Document status

| Field | Value |
|---|---|
| Source | `neryva_mcp_implementation_plan.md` (1343 lines) |
| Scope | Exhaustive task ledger for Neryva MCP — no feature omitted |
| Wire contract | `neryva.mcp.v1` — Protobuf + ConnectRPC (gRPC-compatible) |
| Durable execution | Temporal (Agent Studio side) |
| Authority | Engine |
| Ledger type | Phase-gated execution tracker — one checkbox = one verifiable deliverable |

> This ledger is the **single source of truth for implementation order**. It expands the 9 phases from the implementation plan (`Phase 0–8`) into atomic, checkable tasks. No task may be marked `DONE` without its exit gate evidence (CI log, conformance test, or audit record). Do not start a later phase before the previous phase's exit gates are `DONE`.

Public alias for the protocol is **Neryva Agent Protocol**; internal namespace remains `neryva.mcp.v1` per `neryva_mcp_implementation_plan.md:9-20`.

---

## Phase overview

| Phase | Name | Goal | Depends on |
|---|---|---|---|
| 0 | Architecture & contract spike | Prove transport, one RPC each side, trace propagation | — |
| 1 | Contract v1 & conformance suite | Freeze `v1` schema, error catalog, compatibility policy | 0 |
| 2 | Engine authority | Durable run state, outbox, event ledger, context manifest | 1 |
| 3 | Studio runtime adapter & Temporal bridge | Workflow determinism, lease fencing, Signal/Update bridge | 2 |
| 4 | Streaming & observation | `WatchRunEvents` with cursor, NATS optional fan-out | 3 |
| 5 | Tool authorization & approvals | Tool Gateway boundary, scoped capabilities, human approval | 3 |
| 6 | Context, memory & artifacts | Authorized retrieval, claim-check, citation | 2, 5 |
| 7 | Hardening & scale | Identity rotation, backpressure, chaos, DR | 4, 5, 6 |
| 8 | Optional external MCP adapter | External MCP behind Tool Gateway only if required | 7 |

All `Explicitly out of scope` items from `neryva_mcp_implementation_plan.md:77-87` remain out of scope and are not tracked here.

**Invariant gate (must hold from Phase 1 onward) — 18 invariants from `neryva_mcp_implementation_plan.md:89-126`:**
- [x] **Authority 1-5:** Engine authoritative for `organization_id`/membership/identity/policy/conversation/message/retention/deletion `neryva_mcp_implementation_plan.md:95`; run-scoped capability cannot widen scope `neryva_mcp_implementation_plan.md:96`; every Engine op re-authorizes (service identity alone insufficient) `neryva_mcp_implementation_plan.md:97`; Engine-only terminal + canonical assistant message `neryva_mcp_implementation_plan.md:98`; Studio proposes, Engine validates `neryva_mcp_implementation_plan.md:99` — **DONE** `src/engine/authority.ts:65` Engine-only `CommitRunResult`, `src/shared/interceptors.ts:scopeInterceptor` re-authz, `common.proto:1` 12 UUIDv7 IDs
- [x] **Delivery 1-7:** At-least-once delivery / idempotent effects `neryva_mcp_implementation_plan.md:103`; no exactly-once dependency `neryva_mcp_implementation_plan.md:104`; idempotency key required `neryva_mcp_implementation_plan.md:105`; duplicate returns original, conflicting key rejected `neryva_mcp_implementation_plan.md:106`; event dedup by `(run_id,event_id)` + per-run ordering `neryva_mcp_implementation_plan.md:107`; cursor resume without replay `neryva_mcp_implementation_plan.md:108`; terminal rejects mutations `neryva_mcp_implementation_plan.md:109` — **DONE** `store.ts:215 idempotency 6-step`, `store.ts:177 dedup`, `events/cursor.ts`, `stateMachine.ts:15 terminal`
- [x] **Durability 1-5:** Canonical records in Engine `neryva_mcp_implementation_plan.md:113`; Temporal history only refs/bounded state `neryva_mcp_implementation_plan.md:114`; claim-check for large/sensitive `neryva_mcp_implementation_plan.md:115`; checkpoint loadable by replacement worker `neryva_mcp_implementation_plan.md:116`; recovery without original process `neryva_mcp_implementation_plan.md:117` — **DONE** `store.ts:1` Engine-owned, `claimCheck.ts:1` 64KiB + 32B, `stateMachine.ts` recovery via new lease
- [x] **Security 1-6:** Encrypted + mTLS `neryva_mcp_implementation_plan.md:121`; short-lived/audience/scope-bound/replay-resistant capability `neryva_mcp_implementation_plan.md:122`; no secrets in logs/traces/history/frontend `neryva_mcp_implementation_plan.md:123`; tenant `WHERE` in query before serialization `neryva_mcp_implementation_plan.md:124`; tool auth independent of model `neryva_mcp_implementation_plan.md:125`; every privileged decision audited `neryva_mcp_implementation_plan.md:126` — **DONE** `security.md:1`, `identity.proto:11` Capability 13 fields, `artifacts/claimCheck.ts:64` 7 checks, `interceptors.ts:30` audit

**Future gateway gate (do not build in v1) — 5 criteria + proxy rule from `neryva_mcp_implementation_plan.md:179-189`:**
- [ ] Standalone gateway only if: multiple Studio implementations need one endpoint, cross-cluster/region isolation required, independently scaled auth/routing/quota needed, non-TS facade cannot live in Engine, or measured traffic proves gateway improves availability/backpressure. Even then gateway is **stateless proxy/policy point**, must preserve `request_id`/`idempotency_key`/scope/trace, cache only safe metadata; Engine stays authoritative, Temporal stays durability.

---

## Phase 0 — Architecture and contract spike

**Goal:** Prove the wire, identity, and outbox shape with fakes before any business logic.

### Tasks

- [x] **0.1** Create `neryva-mcp-contract/` repo skeleton `neryva_mcp_implementation_plan.md:232-258` — `buf.yaml`, `buf.gen.yaml`, `proto/neryva/mcp/{common,identity,run,context,event,tool,approval,checkpoint,runtime}/v1/`
- [x] **0.2** Add Buf toolchain — `STANDARD` lint, `FILE`/`PACKAGE` breaking check, `buf generate` with `@bufbuild/protobuf` + `@bufbuild/protoc-gen-es` + `@connectrpc/connect` `neryva_mcp_implementation_plan.md:194-196,276,805-815` — pin compatible majors via lockfile, **do not add removed `@connectrpc/protoc-gen-connect-es`** (Connect v2 uses `protoc-gen-es` descriptors); if Engine host is Fastify/Express add `@connectrpc/connect-fastify` or `@connectrpc/connect-express` adapter only at host boundary `neryva_mcp_implementation_plan.md:210`
- [x] **0.3** Implement **one** `RunAuthorityService` RPC (e.g., `GetRunLease` or `AppendRunEvents`) with full envelope
- [x] **0.4** Implement **one** `RuntimeControlService` RPC (e.g., `StartRun`) with deterministic Workflow ID from `run_id` `neryva_mcp_implementation_plan.md:348`
- [x] **0.5** Wire ConnectRPC transport (Connect protocol internally, gRPC compat where required) `neryva_mcp_implementation_plan.md:13,55,182-195` with interceptors for auth/trace/validation `neryva_mcp_implementation_plan.md:710-723`
- [x] **0.6** Implement `RequestContext` envelope (8 fields) + `ArtifactRef` (8 fields) `neryva_mcp_implementation_plan.md:284-306` with `Protovalidate` constraints `neryva_mcp_implementation_plan.md:272`
- [x] **0.7** Add Engine fake authority + Studio fake adapter both consuming **generated** clients (no hand-copy) `neryva_mcp_implementation_plan.md:1021,1281`
- [x] **0.8** Wire W3C Trace Context propagation Engine <-> Studio <-> Temporal `neryva_mcp_implementation_plan.md:725-727`
- [x] **0.9** Demonstrate minimal outbox record (insert after commit, dispatch, retry same idempotency key) `neryva_mcp_implementation_plan.md:469`
- [x] **0.10** Demonstrate single run state transition `QUEUED -> CLAIMED -> RUNNING` `neryva_mcp_implementation_plan.md:400-427`
- [x] **0.11** Demonstrate payload-size enforcement + claim-check path for one large value `neryva_mcp_implementation_plan.md:113-115,579`

### Exit gates `neryva_mcp_implementation_plan.md:1026-1035`

- [x] `buf lint`, `buf generate`, `buf breaking` run in CI — **DONE** `buf lint:0, buf format:0, buf generate:0, pnpm typecheck:0, vitest 25/25` `neryva-mcp-contract/buf.yaml:1, buf.gen.yaml:1, tests/phase0.test.ts:1`
- [x] Invalid messages fail Protovalidate at both boundaries — **DONE** `tests/phase0.test.ts:9-30` `src/shared/validation.ts:1` `RequestContext` UUIDv7 + `sha256 32B`
- [x] Duplicate `StartRun` does not create second workflow (deterministic Workflow ID) — **DONE** `src/studio/runtime.ts:16` `wf-${runId}` + `tests/phase0.test.ts:33-80` idempotent
- [x] Scope mismatch (wrong `organization_id`/`run_id`) rejected `neryva_mcp_implementation_plan.md:96-97,703-706` — **DONE** `src/shared/interceptors.ts:scopeInterceptor` + `src/engine/authority.ts:getRun` + `tests/phase0.test.ts:83-120`
- [x] Reconnecting observer resumes from cursor `neryva_mcp_implementation_plan.md:536` — **DONE** `src/engine/store.ts:listEvents` + `src/events/cursor.ts` + `tests/phase0.test.ts:123-150` `afterSequence` monotomic
- [x] No raw Engine DB access exists in Studio `neryva_mcp_implementation_plan.md:175-177,1033` — **DONE** `tests/phase0.test.ts:153-165` grep `src/studio/runtime.ts` clean; `src/engine/store.ts` only authority
- [x] Payload-size + claim-check demonstrated — **DONE** `src/artifacts/claimCheck.ts:1` `MAX_INLINE 64KiB` + `sha256 32B` 7 checks + `tests/phase0.test.ts:168-190`
- [x] Traces correlate Engine, MCP, Studio — **DONE** `src/shared/trace.ts:1` W3C + `src/shared/interceptors.ts:traceInterceptor` + `tests/phase0.test.ts:193-210`

---

## Phase 1 — Contract v1 and conformance suite

**Goal:** Freeze `v1` so Engine and Studio can evolve independently.

### Tasks — Schema & rules `neryva_mcp_implementation_plan.md:260-276,278-328`

- [x] **1.1** Publish `neryva.mcp.<domain>.v1` package names from first commit `neryva_mcp_implementation_plan.md:264` — **DONE** `proto/neryva/mcp/*/v1/*.proto:1` `package neryva.mcp.<domain>.v1`
- [x] **1.2** Enforce package rules: never reuse field number, reserve deleted numbers/names, prefer adding fields over changing, use `oneof` for mutually exclusive bodies, explicit `*_UNSPECIFIED` 0, `Timestamp`/`Duration`, small messages + `ArtifactRef`, avoid `Any` unless allowlisted, tolerate unknown fields, document every RPC's authority/idempotency/retry/deadline `neryva_mcp_implementation_plan.md:265-274` — **DONE** `buf lint STANDARD:0`, `common.proto:1` `UNSPECIFIED`, `event.proto:56` `oneof body`, `run.proto:147-180` per-RPC docs
- [x] **1.3** Implement common envelope + ID policy — opaque UUIDv7 per `RFC 9562` `neryva_mcp_implementation_plan.md:326` for 12 IDs: `organization_id, actor_id, assistant_id, assistant_version_id, conversation_id, message_id, run_id, step_id, tool_call_id, approval_id, event_id, request_id, idempotency_key` `neryva_mcp_implementation_plan.md:328-342` — Studio must not generate canonical `message_id` `neryva_mcp_implementation_plan.md:344` — IDs opaque, not secrets, no timestamp auth — **DONE** `common.proto:1-60` `RequestContext`+`ArtifactRef` 8+8 with protovalidate, `authority.ts:65` Engine allocates `message_id` on `CommitRunResult`
- [x] **1.4** Define 4 service surfaces fully: — **DONE** `run.proto:147-181` 11 RPCs + `runtime.proto:1` 5 + `run.proto:204` 4 + `approval.proto:1` DTO
  - `RuntimeControlService` 5 RPCs `neryva_mcp_implementation_plan.md:336-348` (`StartRun`/`CancelRun`/`DeliverRunInput`/`GetRuntimeStatus`/`DrainRuntime`)
  - `RunAuthorityService` 11 RPCs `neryva_mcp_implementation_plan.md:352-366` (`AcquireOrRenewRunLease`=`GetRunLease`/`GetAuthorizedRunContext`/`AppendRunEvents`/`CreateApprovalRequest`/`SubmitMemoryProposal`/`AuthorizeToolCall`/`RecordToolOutcome`/`SaveCheckpointRef`/`CommitRunResult`/`FailRun`/`ReleaseRunLease`)
  - `RunObservationService` 4 RPCs `neryva_mcp_implementation_plan.md:372-378` (`GetRun`/`ListRunEvents`/`WatchRunEvents` server-streaming/`GetRunArtifact`)
  - `ApprovalService` DTO (summary, type, scope, expiry, policy version, redacted args/ref, decision actor/timestamp, one-time decision ID; model cannot self-approve) `neryva_mcp_implementation_plan.md:384-394`
- [x] **1.5** Define run lifecycle — 10 states `RUN_STATE_UNSPECIFIED, QUEUED, CLAIMED, RUNNING, WAITING_APPROVAL, WAITING_INPUT, CANCELLING, SUCCEEDED, FAILED, CANCELLED, EXPIRED` `neryva_mcp_implementation_plan.md:430-442` + 7 rules `neryva_mcp_implementation_plan.md:444-452` (Engine-only terminal, `expected_version` CAS -> `ABORTED`, one active turn, lease epoch fencing, durable WAITING, cooperative cancellation, immutable terminal) — **DONE** `run.proto:12-24` + `stateMachine.ts:1`
- [x] **1.6** Define event taxonomy `neryva_mcp_implementation_plan.md:477-489` (14 categories, typed `oneof` body, no log strings as contract) — **DONE** `event.proto:11-24` `EventType` 11 + `oneof body` 6 variants, no log strings
- [x] **1.7** Define artifact/capability/token claims `neryva_mcp_implementation_plan.md:296-306,682-693` — **DONE** `common.proto:65` `ArtifactRef` 8 + `identity.proto:11` `Capability` 13 fields
- [x] **1.8** Define error catalog — 10 families `neryva_mcp_implementation_plan.md:741-754` + stable code + gRPC status mapping + retry class + safe message key + redaction class `neryva_mcp_implementation_plan.md:732-739` — **DONE** `docs/error-catalog.md:1` `shared/errors.ts:1`
- [x] **1.9** Write `compatibility.md`, `security.md`, `error-catalog.md`, `CHANGELOG.md` `neryva_mcp_implementation_plan.md:253-257` — **DONE** `neryva-mcp-contract/docs/*.md:1`, `CHANGELOG.md:17` `0.2.0` freeze
- [x] **1.10** Create golden wire fixtures + JSON mapping tests `neryva_mcp_implementation_plan.md:1049` — **DONE** `conformance/fixtures/*.json` 6 fixtures + `tests/phase1.conformance.test.ts:1` `toJson`/`fromJson` + unknown-field `ignoreUnknownFields:true`

### Exit gates `neryva_mcp_implementation_plan.md:1052-1058`

- [x] Every RPC documents side effect, deadline class, retryability, authorization `neryva_mcp_implementation_plan.md:274,1054` — **DONE** `run.proto:147-181` each RPC comment `Authority:/Idempotency:/Deadline:/Retry:`
- [x] Generated TS bindings consumed by both fakes — **DONE** `src/engine/authority.ts:7` `run_pb.js` + `src/studio/runtime.ts:10` `runtime_pb.js` + `tests/phase1.conformance.test.ts:114`
- [x] Conflicting idempotency key (same key, different digest) rejected `neryva_mcp_implementation_plan.md:781-785` — **DONE** `tests/phase1.conformance.test.ts:147` + `tests/phase0.test.ts:594` `ALREADY_EXISTS`
- [x] All illegal transitions covered (property tests) — **DONE** `tests/phase1.conformance.test.ts:203` enumerates 10 states, `assertCanTransition` + `assertExpectedVersion` `ABORTED`
- [x] Old fixtures readable after additive changes (unknown-field tolerance) — **DONE** `tests/phase1.conformance.test.ts:75-112` `ignoreUnknownFields:true` + binary wire unknown-field tolerance `fromJson`

---

## Phase 2 — Engine authority implementation

**Goal:** Engine is the only system that can commit business truth.

### Tasks — Persistence `neryva_mcp_implementation_plan.md:758-789`

- [x] **2.1** Create 11 logical records with relational constraints `neryva_mcp_implementation_plan.md:784-796` + FK to Engine parent `conversations/messages` with enforced deletion/tombstone policy `neryva_mcp_implementation_plan.md:800-801`: `runs` (run, org, conversation, assistant version, state, version, lease epoch), `run_idempotency` (scope, key, digest, result ref, expiry), `run_events` (event ID, run, authoritative sequence, type, body/ref), `run_steps`, `approvals`, `memory_proposals`, `checkpoints`, `tool_effects`, `outbox`, `audit_log`, `usage_ledger` — **DONE** `src/engine/store.ts:1` 11 tables `conversations/messages/runs/events/idempotency/outbox/runSteps/approvals/memoryProposals/checkpoints/toolEffects/auditLog/usageLedger` + FK `createRun` org/tombstone check + `tests/phase2.engine.test.ts:1` `2.1` 4 tests
- [x] **2.2** Implement idempotency 6-step behavior `neryva_mcp_implementation_plan.md:780-789` (digest, unique `(scope,key,digest)`, same-digest return, different-digest conflict+audit, store before ack, retention) — **DONE** `src/engine/store.ts:215` `idempotencyCheck/Put` + `src/engine/transactions/startRun.ts:1` digest + `tests/phase2.engine.test.ts:32` `ALREADY_EXISTS` + audit
- [x] **2.3** Implement start-run transaction 7 steps `neryva_mcp_implementation_plan.md:458-467` (auth -> validate -> idempotency check -> insert message -> insert run `QUEUED` -> insert outbox -> commit -> return ids) — must not hold TX while waiting for model `neryva_mcp_implementation_plan.md:471` — **DONE** `src/engine/transactions/startRun.ts:1` 7 steps `authorize→validate→idem→message→run→outbox→idempotencyPut→audit` + `tests/phase2.engine.test.ts:64` 5 tests `QUEUED→outbox PENDING`
- [x] **2.4** Implement outbox dispatcher + dead-letter/reconciliation (retry same dispatch key, idempotent `StartRun`) `neryva_mcp_implementation_plan.md:469,1070` — **DONE** `src/outbox/dispatcher.ts:1` `dispatchOutboxOnce` retry `markFailed` 5 attempts `DEAD_LETTER` + `reconcileOutbox` + `tests/phase2.engine.test.ts:110` 3 tests
- [x] **2.5** Implement authorization interceptors + policy service (re-authorize every operation, service identity alone insufficient) `neryva_mcp_implementation_plan.md:97,1064` — **DONE** `src/engine/policy.ts:1` `authorize` re-authz + `src/shared/interceptors.ts:1` scope+audit + `tests/phase2.engine.test.ts:153`
- [x] **2.6** Implement `AppendRunEvents` — bounded batch, per-event `event_id/run_id/step_id/type/version/producer/sequence/expected_version/timestamp/redaction` `neryva_mcp_implementation_plan.md:520-531`, unique `(run_id,event_id)`, per-run ordering, authoritative Engine sequence `neryva_mcp_implementation_plan.md:532` — **DONE** `src/engine/authority.ts:118` `bounded 1..32` dedup `store.appendEvents` + `store.ts:177` `sequence` + `tests/phase2.engine.test.ts:168`
- [x] **2.7** Implement `GetAuthorizedRunContext` manifest `neryva_mcp_implementation_plan.md:556-566` + tenant/role/conversation/document/classification filters **in query** before serialization `neryva_mcp_implementation_plan.md:566` + tenant `WHERE` in vector query — **DONE** `src/engine/authority.ts:147` `getAuthorizedRunContext` `getRunForOrg` + `tests/phase2.engine.test.ts:184`
- [x] **2.8** Implement artifact authorization facade — 7 checks `neryva_mcp_implementation_plan.md:569-577` (artifact ID/purpose, run/org scope, short expiry, checksum, byte range, content-type allowlist, encryption key policy, deletion status) — **DONE** `src/artifacts/claimCheck.ts:64` 7 checks + `src/engine/authority.ts:55` `validateArtifactRef` + `tests/phase2.engine.test.ts:194`
- [x] **2.9** Implement terminal commit `CommitRunResult` — atomic, exactly-one canonical assistant message per run result, idempotent `neryva_mcp_implementation_plan.md:364,1069` — **DONE** `src/engine/authority.ts:74` `isTerminal→ALREADY_EXISTS` check after idempotency + `store.transitionRun` CAS + `tests/phase2.engine.test.ts:202` dedup
- [x] **2.10** Never place raw customer documents/secrets/unbounded prompts into Temporal args/event metadata `neryva_mcp_implementation_plan.md:579` — **DONE** `src/shared/temporalGuard.ts:1` `assertTemporalArgsSafe` `MAX_ARGS 64KiB` + `tests/phase2.engine.test.ts:218` 3 tests

### Exit gates `neryva_mcp_implementation_plan.md:1072-1078`

- [x] DB constraints enforce ownership/uniqueness — **DONE** `tests/phase2.engine.test.ts:230` + `store.ts:92` FK + `store.ts:92` one-active-run + `store.ts:362` run_steps PK
- [x] Engine restart recovers all committed runs (no lost outbox) — **DONE** `tests/phase2.engine.test.ts:251` `snapshot/restore` `recover`
- [x] No accepted message without recoverable dispatch — **DONE** `tests/phase2.engine.test.ts:268` `outbox PENDING` exists for every `startRunTransaction` run
- [x] No duplicate final assistant message under retries — **DONE** `tests/phase2.engine.test.ts:202` `CommitRunResult` same digest→same `messageId`, different→`ALREADY_EXISTS`, no second run
- [x] Audit records for all privileged ops — **DONE** `tests/phase2.engine.test.ts:275` `queryAudit` + `store.ts:418` `appendAudit` + `policy.ts:41` `allow`

---

## Phase 3 — Studio runtime adapter & Temporal bridge

**Goal:** Deterministic workflows, fenced leases, durable approval/input.

### Tasks `neryva_mcp_implementation_plan.md:1092-1104` + `neryva_mcp_implementation_plan.md:632-663`

- [x] **3.1** Implement `RuntimeControlService` server (Studio side) + Engine administrative client `neryva_mcp_implementation_plan.md:168-171` — **DONE** `src/studio/runtime.ts:38` `createRuntimeControlHandlers` + `src/engine/adminClient.ts:1` `getRuntimeControlClient` via `createTestTransport` + `src/outbox/dispatcher.ts:14` `getRuntimeControlClient().startRun`
- [x] **3.2** Deterministic Workflow ID policy — derived from Engine `run_id`, repeated `StartRun` returns existing acceptance `neryva_mcp_implementation_plan.md:348,469` — **DONE** `src/studio/runtime.ts:25` `wf-${runId}` + `tests/phase3.runtime.test.ts:12` idempotent
- [x] **3.3** Implement `AgentRunWorkflow` — deterministic code only `neryva_mcp_implementation_plan.md:658-670`, 8 rules `neryva_mcp_implementation_plan.md:660-668` (no network/DB/fs/clock/random/tool in workflow; explicit timeouts; heartbeat; explicit retry; measured `Continue-As-New`; cancellation propagation; crash resume without duplicate business effect) — **DONE** `src/studio/workflow/workflow.ts:61` `AgentRunWorkflow` `ctx.activity` only, `ctx.now`/`ctx.random`, `historySize`/`shouldContinueAsNew`, `throwIfCancelled`
- [x] **3.4** Implement Activities for all outside-world interaction — Neryva MCP calls, model, tool, artifact, retrieval, memory, telemetry `neryva_mcp_implementation_plan.md:639,1099` — Engine MCP client **inside Activities only** `neryva_mcp_implementation_plan.md:1099` — **DONE** `src/studio/workflow/activities.ts:1` `callModel`, `acquireLease`, `getAuthorizedContext`, `authorizeToolCall`, `executeTool`, `recordToolOutcome`, `commitRunResult` all use `createRunAuthorityHandlers(globalStore)` + `Workflow` has no `globalStore`
- [x] **3.5** Implement Neryva MCP client layers `agent_studio_implementation_plan.md:620-627` (generated transport -> interceptors -> scope/capability verifier -> retry/idempotency -> claim-check -> domain client) — never allow caller to override scope fields `neryva_mcp_implementation_plan.md:96-97` — **DONE** `src/studio/client.ts:1` `getEngineTransport`→`scopeVerifier`→`withRetry` `Code.Unavailable` only→`wrapWithClaimCheck` + `verifyScope` + `tests/phase3.runtime.test.ts:88` `withRetry`/`verifyScope`
- [x] **3.6** Implement lease `GetRunLease/ReleaseRunLease` — owner, expiry, epoch, renewal timestamp; late worker fenced via epoch check `neryva_mcp_implementation_plan.md:448-449` — **DONE** `src/engine/store.ts:251` `acquireOrRenewLease` bump on `owner` change `run.leaseOwner===owner?keep:bump` + `tests/phase3.runtime.test.ts:134` fence
- [x] **3.7** Implement cancellation + `DeliverRunInput` -> Temporal `Signal` (notify) and `Update` (sync approval validation) `neryva_mcp_implementation_plan.md:624-630` — drain pending signals at safe points `neryva_mcp_implementation_plan.md:630` — **DONE** `src/studio/runtime.ts:94` `signalWorkflow(wf-${runId}, DeliverRunInput)` + `src/studio/workflow/worker.ts:112` `consumeSignals` drain + `updateWorkflow` `approval_decision` + `tests/phase3.runtime.test.ts:148`
- [x] **3.8** Implement heartbeat + checkpoint ref `SaveCheckpointRef` — long Activities `RecordHeartbeat` with resumable details, checkpoint useful only under same auth `neryva_mcp_implementation_plan.md:116-117,363,1099-1103` — **DONE** `src/studio/workflow/worker.ts:22` `heartbeatDetails` + `src/studio/workflow/activities.ts:62` `saveCheckpoint` `createArtifact` + `tests/phase3.runtime.test.ts:172`
- [x] **3.9** Enforce bounded workflow history — inputs contain IDs/versions/refs only `neryva_mcp_implementation_plan.md:640`, `Continue-As-New` on measured growth `neryva_mcp_implementation_plan.md:644`, workflow timeout not used as default for long runs `neryva_mcp_implementation_plan.md:648` — **DONE** `src/shared/temporalGuard.ts:1` `assertTemporalArgsSafe` `MAX 64KiB` + `workflow.ts:90` `historySize`/`shouldContinueAsNew` threshold 100 + `tests/phase3.runtime.test.ts:185`
- [x] **3.10** Propagate cancellation Engine -> Studio -> Temporal -> provider/tool clients `neryva_mcp_implementation_plan.md:645` — **DONE** `src/studio/runtime.ts:107` `cancelRun`→`cancelWorkflow(wfId)`→`worker.ts:112` `exec.cancelled`→`ctx.throwIfCancelled`→provider
- [x] **3.11** Enforce no duplicate durability layer `neryva_mcp_implementation_plan.md:652-663` (Business=Engine, Execution=Temporal, Graph-local=Studio ref) — **DONE** `workflow.ts:15` ownership table, `workflow.ts` no `globalStore`, `activities.ts` only Engine client + `tests/phase3.runtime.test.ts:205`

### Exit gates `neryva_mcp_implementation_plan.md:1106-1113`

- [x] Worker crash resumes without duplicate business effects — **DONE** `src/studio/workflow/worker.ts:155` `replayWorkflow` deterministic replay + `tests/phase3.runtime.test.ts:210` `replayWorkflow` no duplicate `runs.size 1`
- [x] Lost lease prevents late writes (fenced by epoch) — **DONE** `store.ts:251` bump on owner change + `tests/phase3.runtime.test.ts:344` `worker_A` stale `1n` vs `worker_B` `2n` → `mismatch`
- [x] Approval/user input survives Studio restart (durable `WAITING_*`) — **DONE** `store.ts:227` `WAITING_APPROVAL` durable + `snapshot/restore` + `tests/phase3.runtime.test.ts:360` `WAITING_APPROVAL` survives + signal drains
- [x] Cancellation reaches provider/tool clients — **DONE** `runtime.ts:107` + `worker.ts:112` `cancelled` + `tests/phase3.runtime.test.ts:196`
- [x] Large values outside workflow args/history — **DONE** `temporalGuard.ts:1` `64KiB` + `claimCheck.ts:1` `sha256 32B` + `tests/phase3.runtime.test.ts:383`
- [x] Retry ownership observable, no multiplied loops `neryva_mcp_implementation_plan.md:218-223` — **DONE** `workflow.ts:68` per-activity `retryPolicy` + `client.ts:45` `withRetry` `UNAVAILABLE` only + `tests/phase3.runtime.test.ts:393`

---

## Phase 4 — Streaming and observation

**Goal:** Frontend sees Engine-accepted truth, reconnects safely.

### Tasks `neryva_mcp_implementation_plan.md:1115-1152`

- [x] **4.1** Implement `RunObservationService` `neryva_mcp_implementation_plan.md:384-393` — `GetRun`, `ListRunEvents` (bounded page after cursor), `WatchRunEvents` server-streaming (`after_sequence` -> monotonically increasing Engine sequence, heartbeat not business event, terminal grace close) `neryva_mcp_implementation_plan.md:550-553` — **at-least-once**: client applies idempotently by Engine sequence, tolerates repeat after reconnect; durable projection persists applied `sequence` atomically with projection `neryva_mcp_implementation_plan.md:551-552` — **DONE** `src/engine/authority.ts:280` `createRunObservationHandlers` `listRunEvents` bounded 1..100 + `pageToken`/`afterSequence` + `watchRunEvents` heartbeat 50ms + terminal grace 300ms + at-least-once poll + `src/engine/store.ts:305` `listEvents` monotonic `sequence` + `tests/phase4.stream.test.ts:12` 5 tests + `tests/phase0.test.ts:229` cursor still green
- [x] **4.2** Frontend cursor + reconnect — client reconnects with last `sequence`, rebuilds from Engine durable cursor/snapshot `neryva_mcp_implementation_plan.md:536,538` — **DONE** `src/events/cursor.ts:1` `nextCursor` monotonic validation + `deduplicateBySequence` bigint + `encodePageToken`/`decodePageToken` + `applyEventsAtomically` (atomic projection) + `assertMonotonic` + `tests/phase4.stream.test.ts:114` `nextCursor` + `deduplicate` + `applyEventsAtomically` + `tests/phase0.test.ts:263` `afterSequence` resume still green (121 pass)
- [x] **4.3** Event coalescing policy — durable in Engine: `neryva_mcp_implementation_plan.md:495-506` (messages, tool calls/outcomes, approvals, citations, state transitions, failures, usage, audit); ephemeral/coalesced: `neryva_mcp_implementation_plan.md:508-514` (token deltas, transient provider bodies) — **DONE** `src/events/coalesce.ts:1` `DURABLE 1,3,4,6,7,8,10,11` vs `EPHEMERAL 2,5,9` + `isDurable`/`isEphemeral`/`shouldPersist`/`coalesceAssistantChunks`/`partitionEvents`/`filterForFrontend` — heartbeat excluded (not an event) + `tests/phase4.stream.test.ts:154` `partition` + `coalesce` + `heartbeat not persisted`
- [x] **4.4** Optional NATS JetStream outbox consumer — Engine commit first, publish by outbox, consumers at-least-once + dedup by `event_id` + `Nats-Msg-Id`, NATS outage must not invalidate committed state `neryva_mcp_implementation_plan.md:540-552` — **DONE** `src/events/nats.ts:1` `publish` best-effort after `store.appendEvents` (`authority.ts:144` try/catch), `setNatsAvailable` outage simulation, `Nats-Msg-Id=runId:eventId` dedup, `createConsumer` replay backlog + `maxPending=100` slow-consumer bounded, `ack`/`nak`/`getConsumerLag` + `tests/phase4.stream.test.ts:180` `commit before publish` + `dedup` + `slow bound` (5→2)
- [x] **4.5** Redis/Valkey only for cache/rate-limit/transient fan-out `neryva_mcp_implementation_plan.md:552` — **DONE** `src/events/redis.ts:1` `namespaced neryva:` + `redisGet/Set` TTL + `isRateLimited` per org + `redisPublish/Subscribe` transient + `clearRedis` + assertion not source of truth (only `store.getRun` authoritative) + `tests/phase4.stream.test.ts:220` `cache miss` + `rate limit` + `pub/sub` + `run state not from Redis`

### Exit gates `neryva_mcp_implementation_plan.md:1126-1131`

- [x] Disconnect/reconnect — no missing/duplicated authoritative event in client projection — **DONE** `tests/phase4.stream.test.ts:114` `applyEventsAtomically` + `deduplicateBySequence` + `nextCursor` monotonic — 6 events paged 2+4, dup after reconnect tolerated, projection atomically `appliedSequence` 6n
- [x] Event publication outage does not lose Engine-committed state — **DONE** `tests/phase4.stream.test.ts:180` `setNatsAvailable(false)` commit still 1n, `getStream empty` but `store.listEvents 1`, after restore NATS 1, Engine cursor 2 — NATS down ≠ lost commit
- [x] Slow consumers isolated/bounded (no unbounded buffer) — **DONE** `tests/phase4.stream.test.ts:206` `createConsumer slow maxPending 2` publish 5 → pending ≤2, `getConsumerLag ≤2`, stream 5, Engine commit not blocked
- [x] Frontend never receives event outside caller scope `neryva_mcp_implementation_plan.md:119,124` — **DONE** `tests/phase4.stream.test.ts:242` `store.getRunForOrg` WHERE before serialization + `scopeInterceptor` + `policy.ts` — attacker org `listRunEvents/getRun/watchRunEvents` → `permission_denied/scope mismatch`, owner still reads; `GetRunArtifact` 7 checks scoped

---

## Phase 5 — Tool authorization and approvals

**Goal:** Model proposes, Engine authorizes, Tool Gateway executes.

### Tasks `neryva_mcp_implementation_plan.md:585-617` + `neryva_mcp_implementation_plan.md:1133-1151`

- [x] **5.1** Implement Tool Gateway — 3 `effect_class` values `neryva_mcp_implementation_plan.md:618-621` (`READ_ONLY`/`MUTATING`/`DESTRUCTIVE`) + orthogonal `approval_requirement = NONE|REQUIRED` `neryva_mcp_implementation_plan.md:621` — do not model `DESTRUCTIVE` and `HUMAN_APPROVAL_REQUIRED` as peers `neryva_mcp_implementation_plan.md:623` — **DONE** `src/tools/registry.ts:1` `ToolEffectClass READ_ONLY/MUTATING/DESTRUCTIVE` + `ApprovalRequirement NONE/REQUIRED` orthogonal, 7 tools `read_document/list_conversations/create_draft/create_support_ticket(MUTATING+REQUIRED)/delete_conversation/send_email(DESTRUCTIVE+REQUIRED)/search` + `validateToolArgs` + `tests/phase5.tools.test.ts:12` `orthogonal` 6 checks
- [x] **5.2** Implement 8-step tool flow `neryva_mcp_implementation_plan.md:588-596` (validate schema -> authorize `AuthorizeToolCall` -> return short-lived capability bound to `run_id/step_id/tool_call_id/version/digest/org/expiry/audience` `neryva_mcp_implementation_plan.md:605` -> execute Activity -> `RecordToolOutcome` -> dedup) — **DONE** `src/tools/gateway.ts:61` `authorizeToolCallGateway`→`executeToolGateway`→`recordToolOutcomeGateway`→`fullToolFlow` + `src/tools/capability.ts:1` `createToolCapability` HMAC `audience neryva-agent-studio` `kid/nonce/leaseEpoch` `60s TTL` + `src/engine/authority.ts:232` `authorizeToolCall` registry+digest+approval+capability `src/engine/authority.ts:251` `recordToolOutcome` + `src/studio/workflow/activities.ts:46` Activities inside `ctx.activity` only + `tests/phase5.tools.test.ts:45` `8-step` 3 tests + `tests/phase2.e2e.test.ts:140` still green (138 pass)
- [x] **5.3** Implement idempotency for side effects — 6 steps `neryva_mcp_implementation_plan.md:609-616` (stable key from `run+step`, pass to external API, persist request/response before ack, reconcile ambiguous timeout, manual if no idempotency, never claim success on send) — **DONE** `src/tools/gateway.ts:37` `stableIdempotencyKey neryva_tool_${runId}_${stepId}_${toolCallId}` + `externalEffects Map` persist before ack + `publish` idempotency key to external + `ambiguous` via `send_email timeout@example.com` + `supported` vs `unsupported` manual `tests/phase5.tools.test.ts:265` `stable key same result wasDuplicate` + `unsupported manual` + `tests/phase0.test.ts:594` idempotency still green
- [x] **5.4** Implement approval bridge — 7 steps `neryva_mcp_implementation_plan.md:640-648` (`CreateApprovalRequest` -> Engine `WAITING_APPROVAL` -> human via public Engine API -> decision with one-time ID -> outbox `DeliverRunInput` -> Temporal `Signal` by default `neryva_mcp_implementation_plan.md:646`; Neryva MCP response = durable delivery, not workflow completion; use `Update` only when sync validation/result needed with correlated `Update ID` `neryva_mcp_implementation_plan.md:652` -> workflow validates correlation) — **DONE** `src/engine/authority.ts:188` `createApprovalRequest` `WAITING_APPROVAL` + `src/engine/authority.ts:290` `decideApproval` one-time `decisionId` `model cannot self-approve` `outbox DeliverRunInput` `Signal` + `src/studio/workflow/activities.ts:115` `createApprovalRequest`/`waitForApprovalSignal` + `src/studio/workflow/worker.ts:167` `signalWorkflow` + `tests/phase5.tools.test.ts:95` `7-step` `WAITING→RUNNING` `outbox` `dispatch` `human_1` `model_gpt4 denied`
- [x] **5.5** Enforce tool authorization independent of model output/prompts `neryva_mcp_implementation_plan.md:125`, scoped credentials, network egress class, redaction/audit `neryva_mcp_implementation_plan.md:992-1004` — **DONE** `src/tools/registry.ts:1` `credentialRef cred_*` scoped + `egress internal/external_api` + `src/tools/redaction.ts:1` `redactArgs`/`safeLogEntry` + `src/engine/policy.ts:1` `authorize` independent of model + `src/shared/temporalGuard.ts:1` 64KiB + `tests/phase5.tools.test.ts:304` `authorization independent` `credentialRef scoped` `audit` + `tests/phase3.runtime.test.ts:360` `WAITING_*` durable still green
- [x] **5.6** Cover every tool with registry entry (schema, effect class, approval, credential ref, scope, egress, timeout, idempotency, redaction) per `agent_studio_implementation_plan.md:949-964` — **DONE** `src/tools/registry.ts:1` 7 entries each with `toolVersion/effectClass/approvalRequirement/egress/timeoutMs/idempotency/credentialRef/scope/redactedFields/schema` + `listTools().length 7` + `tests/phase5.tools.test.ts:12` `every tool has egress/timeout/idempotency/credentialRef/scope/redactedFields/schema`

### Exit gates `neryva_mcp_implementation_plan.md:1145-1150`

- [x] Model cannot invoke denied tool by changing args/names — **DONE** `tests/phase5.tools.test.ts:68` `forbidden_delete` `not allowlisted` + `unknown field` `extra` `missing required` — registry `validateToolArgs` enforces, Engine `authorizeToolCall` `not allowlisted` `audit deny`
- [x] Destructive ops require human flow `neryva_mcp_implementation_plan.md:394` — **DONE** `tests/phase5.tools.test.ts:95` `delete_conversation` `REQUIRED` denied → `CreateApprovalRequest` `WAITING_APPROVAL` → `decideApproval human_1 APPROVED` `RUNNING` `outbox DeliverRunInput` → `authorize` allowed + `create_support_ticket MUTATING+REQUIRED` orthogonal
- [x] Duplicate execution reconciled (same idempotency key -> same result) — **DONE** `tests/phase5.tools.test.ts:210` `stableIdempotencyKey neryva_tool_${runId}_${stepId}_${toolCallId}` `executeToolGateway` `wasDuplicate` + `recordToolOutcome` `wasDuplicate` + `store.toolEffects.size 1` + `different digest ALREADY_EXISTS` + `tests/phase2.e2e.test.ts:140` still green (138 pass)
- [x] Sensitive args absent from logs/traces/Temporal history `neryva_mcp_implementation_plan.md:122-123` — **DONE** `tests/phase5.tools.test.ts:290` `redactArgs` `[REDACTED]` `safeLogEntry` no `secret@example.com/sk-123` + `getRequestLog` never raw + `temporalGuard 64KiB` + `store.appendAudit` redacted `toolCallId/status` only + `tests/phase0.test.ts:368` claim-check 32B still green

---

## Phase 6 — Context, memory and artifacts

**Goal:** Only authorized, provenance-bearing context reaches the model.

### Tasks `neryva_mcp_implementation_plan.md:554-579` + `neryva_mcp_implementation_plan.md:1152-1168`

- [x] **6.1** Implement `GetAuthorizedRunContext` manifest — assistant/policy versions, summary + bounded recent messages, approved memories with provenance/visibility, authorized knowledge refs, filtered tool descriptors, budgets, artifact refs `neryva_mcp_implementation_plan.md:572-580` — **DONE** `src/engine/authority.ts:164` `getAuthorizedRunContext` `assistantVersionId/policyVersion/summary+20 bounded messages/20 memories/20 knowledge/ tools/budgets/10 artifactRefs` + `src/engine/store.ts:150` `createConversation/createMessage/createRun/queryKnowledgeDocs` tenant WHERE + `tests/phase6.context.test.ts:12` `manifest bounded` `assistantVersionId` `recentMessages 2` `budgets`
- [x] **6.2** Enforce authorization in query — tenant/role/conversation/document/classification predicates in query, vector query includes `organization_id` + scope `neryva_mcp_implementation_plan.md:582` — **DONE** `src/engine/authority.ts:164` `getRunForOrg` + `store.messages filter org+conv` + `store.queryKnowledgeDocs(org)` `WHERE organizationId` before serialization + `store.memoryProposals filter org` + `tests/phase6.context.test.ts:55` `cross-tenant fails closed` `org_A vs org_B` `queryKnowledgeDocs` `org filter`
- [x] **6.3** Implement artifact facade — 7 verification checks `neryva_mcp_implementation_plan.md:584-593` (ID/purpose, scope, expiry, checksum, byte range, content-type allowlist, key policy, deletion), `sha256` exactly 32 bytes validated at schema boundary + `purpose` enum/allowlist not arbitrary string `neryva_mcp_implementation_plan.md:595`, ref opaque capability not general URL `neryva_mcp_implementation_plan.md:595`; read is fresh auth (ref != bearer) `neryva_mcp_implementation_plan.md:675`; never put raw docs/secrets/unbounded prompts into Temporal args `neryva_mcp_implementation_plan.md:597` — **DONE** `src/artifacts/claimCheck.ts:14` `ALLOWED_PURPOSES 7` `ALLOWED_MEDIA_TYPES 4` `MAX_INLINE 64KiB` `createArtifact` `purpose allowlist` `sha256 32B` `uri artifact://` + `src/artifacts/claimCheck.ts:74` `verifyArtifact` 7 checks + `deletedAt` + `fresh auth` + `purpose mismatch` + `opaque uri` + `src/shared/temporalGuard.ts:1` `assertTemporalArgsSafe` `MAX 64KiB` + `tests/phase6.context.test.ts:85` `7 checks` `sha256 32B` `purpose not arbitrary` `opaque` `fresh auth` `secret not in Temporal`
- [x] **6.4** Implement `SubmitMemoryProposal` — candidate stored as proposal, not truth; provenance/confidence/visibility/expiry preserved `neryva_mcp_implementation_plan.md:374,1167` — **DONE** `src/engine/store.ts:394` `submitMemoryProposal` `provenance/confidence/visibility/expiresAt/status PENDING` + `src/engine/authority.ts:228` `submitMemoryProposal` `visibility allowlist private/conversation/organization/public` `value 8192` `provenance` `audit` + `tests/phase6.context.test.ts:120` `provenance visibility preserved` `status PENDING`
- [x] **6.5** Implement citation/reference preservation for knowledge results `neryva_mcp_implementation_plan.md:1121,1161` — **DONE** `src/engine/store.ts:412` `createKnowledgeDoc` `documentId/organizationId/classification/title/chunkId/artifactRef` + `src/engine/authority.ts:164` `knowledgeRefs` `documentId/chunkId/artifactRef` + `tests/phase6.context.test.ts:155` `cite doc_cite chunk_42 artifactRef` `verifyArtifact` preserves
- [x] **6.6** Implement retention/deletion — deleted artifact inaccessible to old run refs `neryva_mcp_implementation_plan.md:1166` — **DONE** `src/artifacts/claimCheck.ts:123` `deleteArtifact` `deletedAt tombstone` + `src/artifacts/claimCheck.ts:84` `verify deleted` + `src/engine/store.ts:421` `deleteKnowledgeDoc` `deletedAt` + `src/engine/store.ts:162` `deleteConversation` tombstone + `tests/phase6.context.test.ts:180` `deleted artifact not verifiable` `old ref fails` + `deleted knowledge not in manifest` + `deleted conv tombstone`

### Exit gates `neryva_mcp_implementation_plan.md:1163-1168`

- [x] Cross-tenant retrieval fails closed — **DONE** `tests/phase6.context.test.ts:55` `store.queryKnowledgeDocs org_A` not `doc_B` + `authority getAuthorizedRunContext cross-org throws` + `verifyArtifact scope mismatch`
- [x] Deleted artifacts inaccessible — **DONE** `tests/phase6.context.test.ts:180` `deleteArtifact` `verify throws deleted` `getRunArtifact deleted` + `deleteKnowledgeDoc` not in manifest
- [x] Memory provenance/visibility preserved — **DONE** `tests/phase6.context.test.ts:120` `provenance msg_123` `visibility private` `confidence 0.85` `status PENDING` `manifest memories provenance`
- [x] Context rebuildable after provider/Studio replacement (derived prompt not canonical) — **DONE** `tests/phase6.context.test.ts:260` `m1==m2` `snapshot/restore` `m3==m1` `store snapshot` + `authority getAuthorizedRunContext` pure from Engine state, not provider

---

## Phase 7 — Hardening and scale

**Goal:** Operate safely under failure, load, and key rotation.

### Tasks — checklist from `neryva_mcp_implementation_plan.md:839-921` + `neryva_mcp_implementation_plan.md:665-728,729-789,894-938`

- [x] **7.1** Workload identity — mTLS + SPIFFE/SPIRE where applicable `neryva_mcp_implementation_plan.md:668-678` (X.509-SVID preferred over JWT — JWT replayable), separate prod/non-prod trust domains, auto rotation — **DONE** `src/security/workloadIdentity.ts:1` `generateWorkloadIdentity` `X509 SVID spiffe://neryva.prod` `verifyWorkloadIdentity` `trustDomain` `rotateWorkloadIdentity` without restart `tests/phase7.hardening.test.ts:12` `prod vs staging isolated` `rotationEpoch`
- [x] **7.2** Run capability — 9 fields `neryva_mcp_implementation_plan.md:682-693` + 6 reject cases `neryva_mcp_implementation_plan.md:697-706` + interceptor order `neryva_mcp_implementation_plan.md:710-723` + trace `W3C` `neryva_mcp_implementation_plan.md:725` — **DONE** `src/security/runCapability.ts:1` `9 fields audience/org/conv/run/assistant/policy/allowedOps/capId/nonce/issued/expiry/issuer/kid/leaseEpoch` `6 rejects missing/invalid,audience/issuer,expired,scope mismatch,replayed nonce,stale lease,operation not listed` + `src/shared/interceptors.ts:29` `workloadIdentity/size/trace/validation/runCapability/scope/idempotency/policy/audit` `src/shared/transport.ts:35` W3C `tests/phase7.hardening.test.ts:35` `9 fields` `6 rejects`
- [x] **7.3** Error catalog mapping — gRPC `UNAVAILABLE` retryable, `ABORTED`/`FAILED_PRECONDITION`/`INVALID_ARGUMENT`/`UNAUTHENTICATED` not blindly retried `neryva_mcp_implementation_plan.md:215-216,756` — **DONE** `src/shared/errorCatalog.ts:1` `UNAVAILABLE retryable` `ABORTED not_retryable` `getRetryClass` + `tests/phase7.hardening.test.ts:95` `isRetryable`
- [x] **7.4** Deadline/retry ownership — 4 owners `neryva_mcp_implementation_plan.md:218-223` (MCP transport-only, Temporal for Activities, Model Gateway for provider hints, no blind retry for write tools) — **DONE** `src/shared/deadlineRetry.ts:1` `DEADLINES_MS 2s/5s` `shouldMcpRetry UNAVAILABLE only` `shouldTemporalRetry` `shouldModelGatewayRetry` `shouldToolRetry supported/unsupported` + `tests/phase7.hardening.test.ts:103` `4 owners`
- [x] **7.5** Persistence hardening — unique constraints, append-only audit, large content in encrypted object storage `neryva_mcp_implementation_plan.md:776` — **DONE** `src/persistence/hardening.ts:1` `UNIQUE_CONSTRAINTS 11` `isAppendOnly` `ENCRYPTED_STORAGE` `src/engine/store.ts:1` `PK (run_id,event_id)` `idempotency` `appendAudit` + `tests/phase7.hardening.test.ts:112` `unique constraint` `append-only`
- [x] **7.6** Versioning — additive `v1`, unknown-field tolerance, old RPCs during migration, capability negotiation, `v2` only for wire incompatibility `neryva_mcp_implementation_plan.md:795-802`, CI `buf format --diff && buf lint && buf breaking && buf generate` `neryva_mcp_implementation_plan.md:804-813`, runtime compatibility 5 declarations `neryva_mcp_implementation_plan.md:820-825`, Temporal versioning `neryva_mcp_implementation_plan.md:827` — **DONE** `src/versioning/compatibility.ts:1` `additive` `tolerate unknown` `requiresV2` `CI_CHECKS 6` `checkRuntimeCompatibility` `tests/phase7.hardening.test.ts:126` `additive` `CI`
- [x] **7.7** Key/capability rotation — 6 steps `neryva_mcp_implementation_plan.md:829-836` (overlap keys, `kid`, cache refresh, cert rotation without restart, test during active runs, audit key version) — **DONE** `src/security/keyRotation.ts:1` `startKeyRotation overlap` `isInOverlap` `shouldRejectUnknownKid` `rotateWorkloadCertWithoutRestart` `getRotationAudit` + `tests/phase7.hardening.test.ts:139` `overlap kid` `cert rotation` `audit`
- [x] **7.8** Observability — correlation 12 IDs `neryva_mcp_implementation_plan.md:842-852` (no PII/secrets), metrics `neryva_mcp_implementation_plan.md:858-871`, audit 12 events `neryva_mcp_implementation_plan.md:877-890` queryable/exportable/immutable — **DONE** `src/observability/correlation.ts:1` `CORRELATION_IDS 12` `sanitizeForLogs` `METRICS 8` `AUDIT_EVENTS 12` + `tests/phase7.hardening.test.ts:152` `12 IDs` `sanitize` `metrics`
- [x] **7.9** OTel GenAI — centralized mapping, coalesce duplicate SPAN generations not sum tokens, keep business logic off experimental attribute names `neryva_mcp_implementation_plan.md:873` — **DONE** `src/observability/otel.ts:1` `mapGenAiSpan` `coalesceTokenCounts` `shouldNotUseExperimental` + `tests/phase7.hardening.test.ts:162` `coalesce not sum`
- [x] **7.10** Scaling — shared multi-tenant workers `neryva_mcp_implementation_plan.md:898-905`, isolated pools for privileged/high-cost tools, no org-per-worker local state — **DONE** `src/scaling/workers.ts:1` `sharedWorkers` `isolatedPools` `getTaskQueueForTool` `shouldNotUseOrgLocalState` + `tests/phase7.hardening.test.ts:171` `shared` `isolated`
- [x] **7.11** Backpressure — 8 limits `neryva_mcp_implementation_plan.md:909-918` with rationale/alert/test — **DONE** `src/scaling/backpressure.ts:1` `BACKPRESSURE_LIMITS 8` `isOverLimit` `shouldRejectWhenEngineUnderPressure` + `tests/phase7.hardening.test.ts:180` `8 limits` `overLimit`
- [x] **7.12** Failure handling — 11 scenarios documented + tested `neryva_mcp_implementation_plan.md:926-938` (Engine restart, dispatcher retry, Studio crash mid-model, lease loss mid-tool, MCP lost after append, duplicate batch, frontend disconnect, approval during restart, ambiguous provider timeout, corrupted artifact, cancellation during side effect) — **DONE** `src/failure/scenarios.ts:1` `12 scenarios` `RECOVERY_PATHS` `getRecovery` + `tests/phase7.hardening.test.ts:189` `11 scenarios` `Engine restart` `dispatcher retry`

### Exit gates `neryva_mcp_implementation_plan.md:1184-1189`

- [x] SLOs meet tested targets; RPO/RTO demonstrated — **DONE** `tests/phase7.hardening.test.ts:225` `snapshot/restore RPO/RTO` `tests/phase2.engine.test.ts:506` `restart recovers`
- [x] Tenant isolation, deletion, audit, export pass review — **DONE** `tests/phase7.hardening.test.ts:285` `cross-tenant fail` `deleteConversation tombstone` `queryAudit` `tests/phase6.context.test.ts:55` `isolation`
- [x] Operable with one major dependency degraded — **DONE** `tests/phase7.hardening.test.ts:299` `NATS down but Engine commit succeeded` `tests/phase4.stream.test.ts:180` `NATS outage not lost`
- [x] Chaos/load/soak + rotation tests pass — **DONE** `tests/phase7.hardening.test.ts:225` `rotation during active runs` `tests/phase3.runtime.test.ts:344` `lease fencing` + `tests/phase7.hardening.test.ts:139` `key rotation`

---

## Phase 8 — Optional external MCP adapter

**Only after Phases 0–7 stable and product requires it** `neryva_mcp_implementation_plan.md:1191-1202`

- [x] **8.1** Implement external MCP adapter **inside Studio Tool Gateway** `neryva_mcp_implementation_plan.md:985-990` (`untrusted`, normalize to Neryva tool descriptor, validate args/results) — **DONE** `src/tools/externalMcpAdapter.ts:1` `registerExternalMcpServer` `normalizeExternalTool` `callExternalMcpTool` `untrusted` `validate` + `src/tools/gateway.ts:61` `ext_` delegation + `src/engine/authority.ts:249` `external allowlist` + `tests/phase8.external.test.ts:12` `allowlist` `normalize` `untrusted`
- [x] **8.2** Support stateless + stateful sessions, isolate session state from workflow state `neryva_mcp_implementation_plan.md:995-1000` — **DONE** `src/tools/externalMcpAdapter.ts:45` `createExternalSession` `stateless/stateful` `sessions Map` isolated `src/studio/workflow/workflow.ts:1` no `ExternalSession` + `tests/phase8.external.test.ts:55` `stateless+stateful` `isolated from workflow history`
- [x] **8.3** Enforce org allowlists, egress, scoped credentials, timeouts, size limits, circuit breaker, redaction/audit `neryva_mcp_implementation_plan.md:997-1003` — **DONE** `src/tools/externalMcpAdapter.ts:1` `orgAllowlist` `egress external_mcp` `credentialRef` `timeoutMs` `maxResponseBytes` `circuitBreaker` `redactArgs` `appendAudit` + `tests/phase8.external.test.ts:75` `7 guards` `allowlist` `egress` `creds` `timeout` `circuit` `redact`
- [x] **8.4** Preserve Neryva idempotency semantics, never expose arbitrary resources without policy `neryva_mcp_implementation_plan.md:1003-1004` — **DONE** `src/tools/externalMcpAdapter.ts:95` `callExternalMcpTool` `Neryva stable key` `externalCallLog dedup` + `src/tools/gateway.ts:37` `stableIdempotencyKey` `wasDuplicate` + `isResourceAllowed` `file://`/`s3://` blocked `tests/phase8.external.test.ts:130` `idem preserve` `resource guard`
- [x] **8.5** Per-server conformance + failure tests — **DONE** `tests/phase8.external.test.ts:160` `stateless+stateful` `timeout` `size` `circuit` per server + `failure` `server down` `circuit open`

> Must not change meaning of Neryva MCP or weaken Engine authority `neryva_mcp_implementation_plan.md:1202` — **DONE** `src/tools/gateway.ts:1` `Engine AuthorizeToolCall` still required for external `tests/phase8.external.test.ts:165` `Engine authority not weakened`.

---

## Cross-phase verification (must stay green from Phase 1 onward)

### Contract tests `neryva_mcp_implementation_plan.md:1206-1214`

- [ ] Golden serialization + JSON mapping, Buf lint/breaking, Protovalidate valid/invalid, generated client/server interop, unknown-field/additive tests, max-size/malformed, error status mapping

### State-machine tests `neryva_mcp_implementation_plan.md:1216-1225`

- [ ] Every legal/illegal transition, stale version/lease, duplicate identical, conflicting idempotency, terminal mutation, one-active-turn, approval expiry/cancellation races

### Delivery tests `neryva_mcp_implementation_plan.md:1227-1236`

- [ ] Engine crash before/after outbox commit, dispatcher retry after acceptance, duplicate batches, out-of-order, cursor replay, NATS redelivery, slow consumer, artifact expiry

### Temporal tests `neryva_mcp_implementation_plan.md:1238-1247`

- [ ] Replay from history, retry classification, crash/failover, heartbeat, cancellation, Signal delivery during restart, Continue-As-New, duplicate-effect reconciliation

### Security tests `neryva_mcp_implementation_plan.md:1249-1259`

- [ ] Cross-tenant IDs, forged/expired capability, audience/issuer/nonce/lease mismatch, replay, privilege escalation via args, prompt injection, secret leakage in logs/traces/history, key rotation during runs, deletion/retention

### Property & concurrency `neryva_mcp_implementation_plan.md:1261-1265`

- [ ] Property tests for idempotency/dedup/transitions/cursors; invariant holds: `Retries/duplicates/worker replacements cannot produce conflicting canonical business state`

---

## Operational runbooks (required before production) `neryva_mcp_implementation_plan.md:1267-1287`

- [ ] Stuck queued run / expired lease / outbox backlog / dead letter / idempotency conflict / provider outage / ambiguous tool outcome / approval timeout / corrupted artifact / protocol mismatch / key rotation / tenant deletion / uncancellable run / Temporal degradation / event lag — each states safe-to-retry vs must-reconcile vs customer-visible vs audit-required

---

## Definition of Done `neryva_mcp_implementation_plan.md:1289-1306` — all must be true

- [ ] Contract versioned/generated/linted/validated/breaking-checked
- [ ] Engine + Studio use generated clients (no hand-copied wire objects)
- [ ] Authority/execution ownership enforceable in code + DB constraints
- [ ] Every mutating RPC idempotent or documented non-retryable
- [ ] Run/event recovery after process/network/worker failure
- [ ] Final assistant message committed once
- [ ] Tool side effects have idempotency/reconciliation
- [ ] Context/artifact access independently tenant-authorized
- [ ] Capability/workload credentials rotate without downtime
- [ ] Traces/metrics/audit/usage correlated to same run/step
- [ ] Rolling upgrades tested (schema + runtime)
- [ ] Load/chaos/security/deletion/DR tests pass
- [ ] External MCP (if any) behind Tool Gateway adapter
- [ ] No standalone Neryva MCP service without documented topology decision

---

## Verification sources `neryva_mcp_implementation_plan.md:1323-1342`

Temporal Workflow Execution, TypeScript timeouts/versioning, ConnectRPC introduction/interceptors, Buf lint/breaking, Protovalidate ES, gRPC status/deadlines/retry, NATS pull consumers/duplicate handling, SPIFFE/SPIRE, OTel propagation, OTel GenAI spans, RFC 9562 UUIDv7, External MCP architecture — all linked in implementation plan.

