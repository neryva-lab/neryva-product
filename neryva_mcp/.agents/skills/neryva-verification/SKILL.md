---
name: neryva-verification
description: Cross-phase verification for Neryva MCP — contract, state-machine, delivery, Temporal, security, property/concurrency, chaos, and ledger exit gates.
---

# Neryva Verification

No phase N+1 before phase N exit gates DONE `ledger.md:14`. 18 invariants must hold P1+ `ledger.md:36-40`.

## When to use
- Before marking any `ledger.md` checkbox `DONE`, before PR, before release, after rotation/chaos
- Writing or changing tests for idempotency, dedup, CAS, cursors, or tenant isolation

## Workflow — 5 test families + operational gates

### 1. Contract tests `neryva_mcp_implementation_plan.md:1206-1225` `ledger.md:272-276`
- `buf lint && buf breaking --against '.git#branch=main' && buf generate && pnpm typecheck` in CI `804-813`
- `protovalidate` valid/invalid fixtures at both boundaries `0.8, 1 gate`
- Golden serialization + JSON mapping, unknown-field/additive tests, max-size/malformed payloads, error status mapping (10 families `741-754`)
- Generated client/server interop both fakes consumed `1.4`; old fixtures readable after additive change

### 2. State-machine tests `ledger.md:278-281`
- Every legal/illegal transition `ledger.md:278` (10 states `430-442`)
- Stale `expected_version` → `ABORTED` + lease fencing (lost lease prevents late writes `449`)
- Duplicate identical vs conflicting idempotency `106,781-785` (same `digest` → original, different → `ALREADY_EXISTS` + audit)
- Terminal mutation rejected except repair `109`; one-active-turn per conversation

### 3. Delivery tests `ledger.md:282-285` `neryva_mcp_implementation_plan.md:1227-1236`
- Engine crash before/after outbox commit `926-938:1-2`; dispatcher retry after Studio acceptance `2`
- Duplicate batches `(run_id,event_id)` dedup `107,520-531` + per-run ordering authoritative `532`
- Out-of-order producer events, cursor replay `WatchRunEvents after_sequence` `550-553` at-least-once idempotent by Engine sequence `551`
- NATS redelivery with `Nats-Msg-Id`, slow consumer bounded queue, artifact expiry during run

### 4. Temporal tests `ledger.md:286-289` `neryva_mcp_implementation_plan.md:1238-1247`
- Deterministic replay, retry classification (`UNAVAILABLE` retryable, `ABORTED` not) `215-216`
- Worker crash/failover without duplicate business effect `3 exit gate`; heartbeat timeout + resumption `1099`
- Cancellation propagation Engine→Studio→Temporal→provider `645`; Signal delivery during restart, `Continue-As-New`, duplicate-effect reconciliation

### 5. Security tests `ledger.md:290-293` `neryva_mcp_implementation_plan.md:1249-1259`
- Cross-tenant IDs every RPC `1263`; forged/expired capability; audience/issuer/nonce/lease mismatch `1265`
- Replay one-time operation; privilege escalation via tool args; prompt injection exfiltration
- Secret leakage absent in logs/traces/artifacts/Temporal history/frontend `123`; key rotation during active runs `668-678,829-836`; deletion/retention enforcement

### 6. Property & concurrency `ledger.md:294-297` `neryva_mcp_implementation_plan.md:1261-1265`
- Property: `Retries/duplicates/worker replacements cannot produce conflicting canonical business state` `1265`
- Concurrency: multiple dispatchers, duplicate Studio workers, lease expiry, delayed responses; NATS redelivery + dedup must not cause second side effect when idempotency supported
- Use property-based for idempotency/dedup/transitions/cursors

### 7. Hardening, scale & runbooks `ledger.md:230-302` `neryva_mcp_implementation_plan.md:839-938`
- Workload identity rotation (X.509-SVID `668-678`), interceptor order `710-723`, W3C trace `725`, error mapping `215,756`, deadline ownership `218-223`
- Backpressure 8 limits `909-918` (req size, batch size, events/run, concurrent/org, tool/model calls, artifact rate, queue depth, outbox age) with rationale/alert/test `945`
- 11 failure scenarios documented+tested `926-938`; chaos/load/soak/DR/RPO/RTO; tenant isolation/deletion/audit/export review `1184-1189`
- 15 runbooks `1267-1287` (stuck queued, expired lease, outbox backlog, dead-letter, idempotency conflict, provider outage, ambiguous tool, approval timeout, corrupted artifact, protocol mismatch, key rotation, tenant deletion, uncancellable run, Temporal degradation, event lag) — each states safe-to-retry vs must-reconcile vs customer-visible vs audit-required

## Commands
```bash
buf lint && buf format --diff --exit-code && buf breaking --against '.git#branch=main'
buf generate && pnpm -C neryva-mcp-contract gen:check
pnpm lint && pnpm typecheck && pnpm test
pnpm test:temporal  # Testcontainers; replay, Signal during restart, heartbeat
# security: grep -R "sk-|\bsecret\b|Bearer" src/ -- must be clean; check trace export
```

## Exit-gate checklist (DoD) `neryva_mcp_implementation_plan.md:1289-1306` `ledger.md:304-320`
- [ ] Contract versioned/generated/linted/breaking-checked; both sides use generated clients
- [ ] Every mutating RPC idempotent or documented non-retryable; authority/execution DB constraints enforce ownership
- [ ] Run/event recovery after process/network/worker failure; final assistant message exactly once; tool idempotency/reconciliation
- [ ] Context/artifact tenant-authorized independently; credentials rotate without downtime; traces/metrics/audit/usage correlated
- [ ] Rolling upgrade, load/chaos/security/deletion/DR passed; external MCP behind Tool Gateway only; no standalone service without topology decision `121,189`

## References
- `neryva_mcp_implementation_plan.md:1026-1058` P0-1 gates, `1072-1189` P2-7 gates, `1206-1272` test strategy
- `ledger.md:66-303` full phased checklist +  `REQ` traceability
