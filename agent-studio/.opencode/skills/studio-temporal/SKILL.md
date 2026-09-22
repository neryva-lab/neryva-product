---
name: studio-temporal
description:
  Implement Agent Studio Temporal runtime — deterministic AgentRunWorkflow, Activities,
  Signals/Updates, heartbeat, Continue-As-New, and payload codec. Use when touching
  packages/workflows, packages/activities, apps/runtime-worker, or handling approval waits and
  workflow versioning.
---

# Studio Temporal — Deterministic Workflows & Durable Execution (Phase 3)

Temporal owns durable execution mechanics. Engine owns business state. Workflows are deterministic
orchestration only.

## When to use

- Editing
  `packages/workflows/src/{agent-run-workflow,signals,queries,updates,workflow-state,continue-as-new,workflow-timeouts,workflow-versioning}.ts`
  (`agent_studio_implementation_plan.md:289-305`)
- Editing
  `packages/activities/src/{context-activities,model-activities,tool-activities,mcp-activities,artifact-activities,memory-activities,approval-activities,usage-activities,heartbeat}.ts`
- Configuring
  `apps/runtime-worker/src/{worker,workflow-bundle,activity-registry,config,shutdown}.ts` or
  `apps/runtime-control`
- Changing `infra/temporal/{namespaces.md,task-queues.md,retention.md}` or versioning strategy

## Workflow

### 1. Workflow responsibilities — deterministic only (`agent_studio_implementation_plan.md:787-799`)

- Start/validate run, call Activities with explicit timeouts/retry, track bounded state + budgets,
  wait on Signals for approval/cancellation/user-input, expose Queries for bounded status, use
  Updates only when sync validation/tracking required (not replacement for Engine business ack
  `796`), `Continue-As-New` on measured growth (`797`), map terminal outcomes to
  `CommitRunResult`/`FailRun`.

### 2. Activity responsibilities — all non-determinism (`agent_studio_implementation_plan.md:801-812`)

- Neryva MCP calls, model provider calls, tool execution, artifact reads/writes, retrieval/memory
  calls, telemetry enrichment, external credential acquisition. All network/DB/fs/clock/random in
  Activities.

### 3. Timeout and retry per Activity class (`agent_studio_implementation_plan.md:813-825`)

- Each Activity declares `schedule-to-start`, `start-to-close`, `heartbeat` (where progress
  possible), retryable error classification, max attempts/elapsed budget. No blanket retry —
  provider, read-only tool, effectful tool, approval, artifact, MCP finalization have distinct
  semantics.

### 4. Determinism rules — CI-enforced (`agent_studio_implementation_plan.md:826-838`)

Workflow code must NOT: call provider SDKs, call Neryva MCP network client, read
`process.env`/files, use `Date`/`Math.random`/non-deterministic UUID, depend on mutable global,
iterate unordered external data without stable ordering. Use Temporal deterministic time/randomness
APIs and Activities for effects. Enforced via `pnpm check:generated` bundle scan (`1319`).

### 5. Payload protection (`agent_studio_implementation_plan.md:839-848`, `agent_studio_architecture.md:133-143,558-598`)

- Default: IDs/refs/bounded metadata + `ArtifactRef` only; never raw prompts/docs/credentials/full
  provider responses in workflow args/history (`138,595`).
- If small non-public value needed: configured **encrypted payload codec** with classification, key
  source, rotation, access policy documented (`844`).
- Tested `max inline payload` size; reject oversized before scheduling (`845`).
- Claim-check for large/sensitive/long-retained: tenant/run scoped, purpose-bound, checksum-verified
  (`sha256==32B`), expiring, re-authorized on read (`846`).
- CI proves secrets/prohibited classes never enter workflow args/activity results/logs/default
  traces (`847`). Codec does not replace Engine retention/deletion (`848`).
- Durable constraints: long activities `RecordHeartbeat` with checkpoint refs (`137`),
  `Continue-As-New` at tested threshold not hard-coded count (`139`), retry ownership explicit
  (provider hints but workflow applies one bounded policy, respect `retry-after`, never blindly
  retry effectful tool `140`), tool side effects idempotent (`141`).

### 6. Signals/Updates and versioning (`agent_studio_implementation_plan.md:789-796,850-856`)

- `StartRun` uses deterministic WorkflowID = `run_id`; duplicate returns existing acceptance.
  `CancelRun`/`DeliverRunInput` → Temporal **Signal** by default; **Update** only when sync
  workflow-level validation/result needed. Drain pending Signals at safe points.
- Continue-As-New when measured history growth approaches safety threshold — deployment config based
  on Temporal version/payload codec/event shape/workload, not arbitrary event count (`856`).
- Versioning: Temporal-compatible version markers, keep old paths until executions drain, never
  deploy replay-breaking change without marker (`851`).

### 7. Runtime workers and scaling (`agent_studio_implementation_plan.md:98-127,536-547`)

- `runtime-worker` registers workflows+activities+MCP client+gateways+telemetry; no public customer
  API (Engine dispatches via Neryva MCP `520`). `runtime-control` is stateless, internal, audited —
  maps to MCP/Temporal ops only (`523-525`). `tool-worker` optional isolated pool. `eval-worker`
  after runtime stable (`532`).
- Scale by task queue/workload class: `agent-run-default`, `agent-run-long`, `tool-read-only`,
  `tool-effectful`, `retrieval-indexing`, `evaluation` (`539-545`). Do not create one worker per
  organization; shared workers with tenant-scoped capabilities + per-org budgets/fairness (`547`).

## Tests

- `replay.test.ts` — workflow replay from recorded histories; version compat
- `cancellation.test.ts` — Signal before/after wait, cooperative → administrative termination,
  approval `WAITING_*` durable
- `continue-as-new.test.ts` — state carry-over, threshold measured not folklore
- `heartbeat.test.ts` — long Activity progress via `RecordHeartbeat`
- `retry-safety.test.ts` — terminal `CommitRunResult` retry idempotency via lease epoch fencing

## Anti-patterns

- Importing provider SDK or `pg` in `packages/workflows` (determinism violation)
- Passing full documents via workflow args instead of `ArtifactRef` (payload growth → history
  blowup)
- Hard-coding `Continue-As-New` at `50k` events without measuring deployed Temporal version (`139`,
  `856`)

## References

- `agent_studio_implementation_plan.md:786-856` workflows/activities/versioning, `98-127` apps,
  `536-547` scaling
- `agent_studio_architecture.md:98-143` why Temporal, `558-598` persistence, `133-143` durable
  constraints
- `docs/architecture/agent_studio/imp/ledger.md:160-175` Phase 3 checklist

## Exit gates (Phase 3)

- Worker crash resumes without duplicate business effect
- No provider/tool/network imports in workflow bundle (static scan)
- Approval + cancellation durable (Signal/Update survive restart)
- `CommitRunResult` retry cannot duplicate assistant message
