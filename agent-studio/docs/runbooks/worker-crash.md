# Runbook — Worker crash + task-queue backlog (10.11, 1574)

> 10.11 Restore/replay + incident drills: worker crash, provider timeout, cancellation, worker
> failover, replay debugging, quarantining run without DB

## Symptoms

- Temporal worker `runtime-worker` crash, task queue `agent-run-default` backlog growing,
  `workflow_failed_total` spike

## Diagnosis (no direct DB access)

- `runtime-control` internal: `GetRun` + `ListRunEvents` for affected `runId`
- Trace viewer (redacted, artifact IDs/hashes not raw prompts) via `ListRunEvents`
- Temporal Web UI: workflow history, `Continue-As-New` generation

## Recovery

- Lease/claim: Engine `AcquireOrRenewRunLease` with epoch fencing; stale worker fenced, new worker
  acquires lease `ReleaseRunLease` + `AcquireOrRenewRunLease`
- Worker crash before claim: Engine run remains dispatchable; redelivery safe via deterministic
  `Workflow ID = agent-run::runId`
- Worker crash after claim: new worker resumes from last checkpoint `SaveCheckpointRef` (artifact
  ref, tenant-scoped, checksum-verified)
- Quarantine without DB: `runtime-control` internal `CancelRun` + `FailRun` with `quarantined`
  status via MCP, not direct DB

## Verification

- `ListRunEvents` after cursor shows no duplicate business effect
- `CommitRunResult` idempotent
- Metrics: `workflow_started_total`, `activity_retries_total` recover
