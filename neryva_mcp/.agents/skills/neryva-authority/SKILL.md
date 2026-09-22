---
name: neryva-authority
description: Engine authority implementation — run state machine, outbox, event ledger, idempotency, context/artifact authorization, and terminal CommitRunResult with audit.
---

# Neryva Authority

Engine is the only committer of business truth `neryva_mcp_implementation_plan.md:95,98`. Studio proposes, Engine validates `99`.

## When to use
- Implementing `engine/src/mcp/` — `RunAuthorityService` / `RunObservationService`, interceptors, or dispatcher
- Touching `runs`, `run_events`, `run_idempotency`, `outbox`, `audit_log`, `usage_ledger`, lease or `CommitRunResult`
- Handling `AppendRunEvents`, `GetAuthorizedRunContext`, `CommitRunResult`/`FailRun`, or conversation scoping

## Workflow

### 1. State machine — CAS only `neryva_mcp_implementation_plan.md:414-467`
```
QUEUED → CLAIMED → RUNNING → {WAITING_APPROVAL, WAITING_INPUT} → RUNNING → SUCCEEDED|FAILED|CANCELLED|EXPIRED
```
- 10 states: `UNSPECIFIED, QUEUED, CLAIMED, RUNNING, WAITING_APPROVAL, WAITING_INPUT, CANCELLING, SUCCEEDED, FAILED, CANCELLED, EXPIRED` `430-442`
- Engine-only terminal `1`; `expected_version` → `ABORTED` on stale write `2`; one active turn per conversation `3`; lease epoch fencing `4`; `WAITING_*` durable `5`; cooperative cancel `6`; terminal immutable `7` `444-452`
- Lease separate from run state: owner/expiry/epoch/renewal; late writes fenced `ABORTED` `448-449`; use `ABORTED` not `FAILED_PRECONDITION` for CAS

### 2. Start-run transaction (7 steps, atomic) `neryva_mcp_implementation_plan.md:458-471`
1. authn/authz 2. validate conversation/assistant version 3. idempotency check 4. insert user message 5. insert run `QUEUED` 6. insert outbox 7. commit → return `message_id, run_id, conversation_version`
- Never hold TX while waiting for model `471`; commit → outbox dispatcher after commit

Outbox `neryva_mcp_implementation_plan.md:469,1070`:
- Dispatcher retries same `dispatch_key`/idempotency key; Studio dedup via deterministic WorkflowID=`run_id` `348`
- Engine crash before/after commit must be tested `ledger.md:129`; dead-letter + reconciliation required

### 3. Idempotency (6-step, audit on conflict) `neryva_mcp_implementation_plan.md:780-789`
1. canonical digest after validation 2. insert `(scope, idempotency_key, digest)` unique 3. same digest → return original 4. different digest → `ALREADY_EXISTS`/conflict + audit 5. store result before ack 6. retention covers retries/reconciliation
- Do not substitute domain uniqueness; both required `813`; `run_idempotency` includes `scope, key, digest, result_ref, expiry` `784-796`

### 4. Event ledger `neryva_mcp_implementation_plan.md:518-553`
- `AppendRunEvents` bounded batch; per-event `event_id/run_id/step_id/type/version/producer/sequence/expected_version/timestamp/redaction` `520-531`; unique `(run_id,event_id)`; Engine assigns authoritative `sequence` in same TX `532`; tolerate duplicate → return prior
- Durable: messages, tool outcomes, approvals, citations, state transitions, failures, usage, audit `495-506`; ephemeral: token deltas `508-514`
- `WatchRunEvents` after `sequence`, monotonic, heartbeat not business event, at-least-once → client dedup by Engine sequence `550-553`; NATS optional after commit, `Nats-Msg-Id` dedup `540-552`; Redis only cache `552`

### 5. Authorization — query-first `neryva_mcp_implementation_plan.md:95-99,113,124,566,569-577`
- Every op re-authorizes: service identity alone insufficient `97`; tenant `WHERE` in Engine query **before** serialization `124,566`
- `GetAuthorizedRunContext` returns manifest (assistant/policy versions, summary + bounded messages, approved memories, knowledge refs, filtered tools, budgets, `ArtifactRef`) `572-580`; vector query must include tenant predicates
- Artifact facade 7 checks: ID/purpose, run/org scope, short expiry, `sha256==32B` `595`, byte range, content-type allowlist, encryption key, deletion status `569-577`; `purpose` enum/allowlist not free string `595`

### 6. Terminal — exactly once `neryva_mcp_implementation_plan.md:364,1069`
- `CommitRunResult` atomic: one canonical assistant message per run result, idempotent, persists `usage_ledger` + `audit_log`; late events after terminal rejected unless administrative repair `109`

### 7. Interceptor order + persistence `neryva_mcp_implementation_plan.md:710-723,758-796`
- TLS → size → auth → trace (W3C) → validation → capability → idempotency → authz → handler → audit/metrics
- 11 records with FK to `conversations/messages` + deletion/tombstone `800-801`: `runs, run_idempotency, run_events, run_steps, approvals, memory_proposals, checkpoints, tool_effects, outbox, audit_log, usage_ledger`

## Anti-patterns
- Studio DB access `175-177` → blocked; only generated Neryva MCP clients
- Raw docs/secrets/unbounded prompts in Temporal args/event metadata `579` → use `ArtifactRef`
- Retrying `ABORTED/FAILED_PRECONDITION/INVALID_ARGUMENT/UNAUTHENTICATED` as transient `215` → handle explicitly

## References
- `ledger.md:109-132` Phase 2 tasks + exit gates; `274-276` contract tests
- `neryva_mcp_implementation_plan.md:336-394` service surfaces, `741-754` error families
