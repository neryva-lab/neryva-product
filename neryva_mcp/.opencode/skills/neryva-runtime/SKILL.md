---
name: neryva-runtime
description: Agent Studio runtime adapter — RuntimeControlService, Temporal deterministic workflows, Activities, lease fencing, Signals/Updates, tool authorization, and checkpointing.
---

# Neryva Runtime

Studio owns execution; Engine owns business truth `main.md:87-110`. No duplicate durability layer `neryva_mcp_implementation_plan.md:652-663`: Business=Engine, Execution=Temporal, Graph-local=Studio ref.

## When to use
- Implementing `studio/src/mcp/` — `RuntimeControlService` server, Engine MCP client, Temporal workers/workflows/activities
- Handling `StartRun`/`CancelRun`/`DeliverRunInput`, lease renewal, heartbeats, `SaveCheckpointRef`, tool flow
- Debugging replay, cancellation propagation, or approval `WAITING_*` resumption

## Workflow

### 1. RuntimeControlService (Studio side) `neryva_mcp_implementation_plan.md:336-348`
| RPC | Idempotency |
|---|---|
| `StartRun` | Deterministic WorkflowID=`run_id`, duplicate returns existing acceptance `348,469` |
| `CancelRun` | Required |
| `DeliverRunInput` | Per `input_id` (approval/user input) |
| `GetRuntimeStatus` | Safe read |
| `DrainRuntime` | Operator-authorized |
- Engine calls Studio via outbox administrative client `168-171`; Studio calls Engine via generated client **inside Activities only** `1099`

Client layers `620-627`: generated transport → interceptors → scope/capability verifier → retry/idempotency → claim-check → domain client; never allow caller to override `organization_id/conversation_id/run_id` `96-97`

### 2. Temporal — 8 workflow rules `neryva_mcp_implementation_plan.md:658-670,640-648`
- Workflow code deterministic; no network/DB/fs/clock/random/tool in workflow — all in Activities or approved APIs
- Inputs = IDs/policy versions/refs only, not full docs/secrets `640`; `ArtifactRef` for large values `579`
- Explicit `startToClose`/`scheduleToClose` timeouts; long Activities → `RecordHeartbeat` with resumable details
- Explicit retry policies; non-retryable = `FAILED_PRECONDITION/INVALID_ARGUMENT` (validation/authz), retryable = `UNAVAILABLE` `215`
- `Continue-As-New` on measured history growth `644`, not magic constants; workflow timeout not default for long runs `648`
- Versioning via Temporal versioning API `827`; no in-place deterministic change `850`

### 3. Lease fencing `neryva_mcp_implementation_plan.md:448-449,363,1099`
- `AcquireOrRenewRunLease`/`ReleaseRunLease` fields: owner, expiry, epoch, renewal timestamp
- Late worker after epoch bump → `ABORTED`; replacement worker acquires new lease, resumes same `run_id`; checkpoint must be loadable under same auth `116`

### 4. Approval & user-input bridge (7 steps) `neryva_mcp_implementation_plan.md:640-653`
1. Studio `CreateApprovalRequest` → 2. Engine `WAITING_APPROVAL` → 3. human via public Engine API (with summary/type/scope/expiry/policy/redacted args/ref/decision meta `384-394`) → 4. decision persisted with one-time ID → 5. outbox `DeliverRunInput` → 6. **Signal** by default (MCP response = durable delivery, not workflow done `646`); `Update` only when sync validation/result needed with correlated `UpdateID` `652` → 7. workflow validates
- Model cannot self-approve destructive `394,125`; drain pending Signals at safe points `630`; duplicate delivery tolerated; small typed Signal payloads, large via `ArtifactRef`

### 5. Tool authorization boundary `neryva_mcp_implementation_plan.md:585-637`
Model proposes → Studio validates schema → `AuthorizeToolCall` (Engine checks tenant/user/assistant/capability/limits) → short-lived capability bound to `run_id/step_id/tool_call_id/version/digest/org/expiry/aud` `605` → Tool Gateway Activity → `RecordToolOutcome` dedup
- Classes: `READ_ONLY | MUTATING | DESTRUCTIVE` + orthogonal `approval_requirement NONE|REQUIRED` `618-623`; do not peer `DESTRUCTIVE` with `HUMAN_APPROVAL_REQUIRED` `623`
- Idempotency 6 steps `609-616`: stable key `run+step`, pass to external, persist request/response before ack, reconcile ambiguous timeout, manual if no idempotency, never claim success on send alone

### 6. Streaming & coalescing (Studio reports, Engine persists) `neryva_mcp_implementation_plan.md:495-514,518-531`
- `AppendRunEvents` batch bounded; Engine `sequence` authoritative; Studio `sequence` untrusted diagnostic only `532`
- Ephemeral coalesced: token deltas, transient provider bodies; durable: `498-506`; final assistant message remains canonical

### 7. Cancellation `neryva_mcp_implementation_plan.md:645,1099`
Engine → Studio (`CancelRun`) → Temporal (cooperative → administrative termination) → provider/tool clients; NATS/Temporal Signals obey same chain

## Anti-patterns
- Putting provider conversation ID as source of truth `224` → Engine `conversation_id` is truth
- Temporal history containing secrets/raw docs `114-115` → claim-check
- Multiplying retries: MCP retries transport-idempotent only; Temporal owns Activity retry; Model Gateway owns provider hints; write tools no blind retry `218-223`

## References
- `ledger.md:136-182` Phase 3-5 checklists; `246-247` delivery/Temporal tests
- `neryva_mcp_implementation_plan.md:552-596,624-630` approval/tool specifics
