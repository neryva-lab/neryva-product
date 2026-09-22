---
name: studio-tool-gateway
description:
  Implement Tool Gateway policy boundary — registry, effect/approval, schema validation, scoped
  credentials, idempotency, sandbox, and approval bridge. Use when touching packages/tool-gateway,
  apps/tool-worker, or handling tool authorization, HUMAN_APPROVAL_REQUIRED, or DeliverRunInput
  Signals.
---

# Studio Tool Gateway — Policy Enforcement & Human Approval (Phase 6)

Policy boundary, not model convenience wrapper. Model proposes, Gateway authorizes.

## When to use

- Editing
  `packages/tool-gateway/src/{tool-gateway,registry,schema-validation,effect-policy,approval-policy,idempotency,credentials,egress-policy,result-redaction,tool-context,executors/*}.ts`
  (`agent_studio_implementation_plan.md:231-254`)
- Adding `apps/tool-worker/src/{worker,sandbox,config}.ts` for simulated-isolation execution (current executor is in-process simulation; real backend = E2B/Daytona per FL-2.11)
- Changing `contracts/tool/{descriptor,effect-policy}.ts` or handling
  `AuthorizeToolCall`/`RecordToolOutcome`/`CreateApprovalRequest`

## Workflow

### 1. Tool registration — 11 fields (`agent_studio_implementation_plan.md:970-987`)

```ts
tool_id + version, input/output schema, effect_class: READ_ONLY|MUTATING|DESTRUCTIVE,
approval_requirement: NONE|REQUIRED, credential ref, allowed org/agent scopes,
network egress class, timeout/resource limits, idempotency support, redaction policy,
audit event type, execution mode: in-process|activity|sandbox
```

`effect_class` vs `approval_requirement` orthogonal (`989`): read-only can require approval
(confidential), mutating can be pre-approved only under explicit policy. Do not peer `DESTRUCTIVE`
with `HUMAN_APPROVAL_REQUIRED` as same level — arch
`READ_ONLY/WRITE/DESTRUCTIVE/EXTERNAL_SIDE_EFFECT/HUMAN_APPROVAL_REQUIRED`
(`agent_studio_architecture.md:484`) evolves to impl `READ_ONLY|MUTATING|DESTRUCTIVE` +
`approval_requirement` (`970-977`).

### 2. Gateway checks 1–10 (`agent_studio_architecture.md:495-506`)

1 Validate tool name — 2 Validate args against schema — 3 Confirm tenant/user scope — 4 Check org
policy — 5 Check rate/cost limits — 6 Require human approval when needed — 7 Execute with scoped
credential — 8 Record request+result — 9 Apply idempotency — 10 Return only permitted result.

Engine never exposes raw DB access as model tool (`508`). Use `tool-context.ts` for scoped context +
`result-redaction.ts` for output bounds.

### 3. Tool-call flow — 10 steps (`agent_studio_implementation_plan.md:992-1006`)

```
model proposal → parse+schema-validate → resolve registered version
→ verify run capability + tenant scope → evaluate org/agent policy → check budget/rate/timeout
→ request approval if required → derive run_id+step_id idempotency key
→ execute with scoped credential + egress → redact+bound result → persist/audit via Engine/MCP → return to kernel
```

Approval decisions bound to `organization/run/tool_call/approval_id/policy_version`, idempotent
(`1116`).

### 4. Side-effect safety — at-least-once (`agent_studio_architecture.md:507-510`, `agent_studio_implementation_plan.md:1008-1017`)

Temporal Activity delivery is at-least-once. For `MUTATING`/`DESTRUCTIVE`:

- Stable idempotency key: `run_id + step_id + tool_version` (`1012`)
- Persist request+result before ack where external system supports it (`1013`)
- Query/reconcile by key when response lost (`1014`)
- Never retry unknown side effect without provider-specific reconciliation path (`1015`)
- Return explicit `UNKNOWN_OUTCOME` when external system cannot prove result (`1016`)

For effectful tools derive `run_id + step_id` key (`510`), persist outcome before ack. First
mutating tool must have idempotent fake external system for tests (`1457`).

### 5. Isolation (`agent_studio_architecture.md:400-405`, `agent_studio_implementation_plan.md:1018-1029`)

- `in-process` only when code/deps trusted; `activity` for bounded external calls
- `sandbox` / `tool-worker` for: customer-authored code, untrusted parsers/scripts, broad network
  clients, sensitive credentials, high CPU/memory or long-running tools (`1022-1026`)
- Sandbox controls (TARGET for the real E2B/Daytona backend per FL-2.11; the current `executeInSimulatedSandbox` enforces only a timeout race, a static egress-allowlist presence check, one ambient-credential env check, and audit — no FS/network/CPU/mem isolation): workload identity, filesystem isolation, CPU/memory/time limits, restricted
  egress, no ambient credentials, complete audit correlation (`1028`, `584-596`)

### 6. Approval bridge (`agent_studio_implementation_plan.md:1102-1117`, `agent_studio_architecture.md:328-336`)

```
Tool Gateway determines approval required → Neryva MCP CreateApprovalRequest
→ Engine persists WAITING_APPROVAL + outbox → human via Engine API (with one-time decision ID)
→ outbox DeliverRunInput → Studio maps to Temporal Signal (default)
→ workflow validates correlation and resumes (RequestApproval → ExecuteTool → ModelStep)
```

- Signal by default (MCP response = durable delivery, not workflow done `1116` row 2); Update only
  when synchronous workflow-level validation/result needed with correlated `Update ID` (`652`).
- Drain pending Signals at safe points; small typed Signal payloads, large via `ArtifactRef`.

## Tests

- `registry.test.ts` — unknown model capability rejection, disallowed tool
- `authorization.test.ts` — tenant/scope mismatch, org policy, cross-tenant confusion
- `idempotency.test.ts` — duplicate delivery does not duplicate fake side effect; stable
  `run_id+step_id` keys
- `approval.test.ts` — auditable, correlated to `tool_call_id/step_id`
- `simulated-sandbox.test.ts` — honesty lock-in: asserts what the simulated executor enforces AND what it does not (no FS/env isolation, no handler cancellation); the old pass-by-construction escape-attempt test was deleted in Wave 3

## Anti-patterns

- Letting model self-authorize effectful tool by skipping `AuthorizeToolCall` (`1194`, `1464`).
- Treating approval as optional UX rather than policy-enforced boundary.
- Retrying destructive tool blindly without `UNKNOWN_OUTCOME` reconciliation (`1016`).

## References

- `agent_studio_implementation_plan.md:968-1029` gateway, `1102-1117` approval, `1453-1468` Phase 6
- `agent_studio_architecture.md:483-511` Tool Gateway, `400-405` sandbox, `328-336` agent execution
  model
- `docs/architecture/agent_studio/imp/ledger.md:205-220` Phase 6 checklist

## Exit gates (Phase 6)

- Model cannot self-authorize effectful action; duplicate delivery safe; lost response →
  `UNKNOWN_OUTCOME`; approval auditable + correlated
