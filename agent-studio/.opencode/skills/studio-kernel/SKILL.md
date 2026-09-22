---
name: studio-kernel
description:
  Implement Agent Studio pure kernel — bounded AgentRun state machine, budgets, step-id, and
  immutable agent-definition compiler (v1.schema.json). Use when touching packages/agent-kernel,
  packages/agent-definition, contracts/agent-definition, or contracts/tool for definition
  validation.
---

# Studio Kernel — Bounded State Machine & Definition (Phase 1)

Pure. No network, no Temporal, no provider SDKs, no DB. Deterministic unit/property tests only.

## When to use

- Editing
  `packages/agent-kernel/src/{agent-run,state,transitions,budgets,step-id,outcomes,errors}.ts`
  (`agent_studio_implementation_plan.md:148-162`)
- Defining `contracts/agent-definition/v1.schema.json` or
  `contracts/tool/{descriptor,effect-policy}.ts`
- Changing
  `packages/agent-definition/src/{schema,parser,validator,compiler,capability-checker,versions}.ts`
- Adjusting budgets, step-id derivation, or terminal outcomes

## Workflow

### 1. Agent definition contract (`agent_studio_architecture.md:357-405`, `agent_studio_implementation_plan.md:688-724`)

- Immutable declarative document, versioned per `agent_id`. Example fields: `agent_id`, `version`,
  `instructions`, `model_policy.allowed_models` (MUST reference Model Gateway capability registry
  `406`), `context_policy {history_limit, summary_enabled, knowledge_sources, memory_scope}`,
  `tools[] {name, access: read|write, approval: required}`,
  `guardrails {input_policy, output_policy, pii_redaction}` (`375-390`).
- Every run pinned to one immutable `agent_version_id + policy snapshot` (`394`). Current run
  continues with original version if admin publishes new.
- Output of compiler (11 fields `703-720`): `agent_version_id`, `definition_schema_version`,
  `instructions ref`, `model/context/tool/guardrail/budget/retrieval policy`,
  `compiled tool schemas`, `compiler version`, `policy snapshot ref`. Never contains secrets,
  mutable org pointers, or executable customer code.
- Validation rejects (`725-732`): unknown model capability, disallowed tool, effectful without
  approval/idempotency, limits exceed entitlement, unsupported context/output, unbounded recursion,
  instructions attempting Engine authority.

### 2. Read-only tool registry interface (`agent_studio_implementation_plan.md:1354`)

- Build `contracts/tool/descriptor.ts` + provider-neutral `tool-gateway` registry interface used for
  definition validation + context planning. Runtime execution remains unimplemented until Phase 6.

### 3. Kernel state machine (`agent_studio_architecture.md:322-351`, `agent_studio_implementation_plan.md:736-754`)

```
AgentRun: Admission → LoadContext → PolicyCheck → ModelStep → InterpretModelResult
  → {FinalAnswer→Finalize, ReadOnlyTool→ExecuteTool→ModelStep, EffectfulTool→RequestApproval→ExecuteTool→ModelStep, UserInput→WaitForSignal, Handoff→Escalate}
  → BudgetCheck → CommitResult
```

- Kernel state is bounded refs only (`758-770`): `run identity+scope`, `agent/policy version`,
  `step ID/attempt`, `loop counters/budgets`, `last model/tool outcome refs`,
  `pending approval/input ref`, `checkpoint/artifact refs`, `terminal intent`. Never full
  history/docs/prompts.
- Budgets per run (`338-350`, `148-162`): `max model calls`, `max tool calls`, `max wall-clock`,
  `max token`, `max cost`, `max recursion`, `allowed tool/model set`, `cancellation`,
  `retry policy`, `approval policy`. Start bounded, not autonomous.
- Outcomes are typed terminal values; invalid transitions are deterministic errors.

### 4. Budgets and step identity (`agent_studio_implementation_plan.md:773-783`)

- Every logical step has stable ID: `run_id + workflow generation + step path` (`773`). Used for
  Temporal activity idempotency, tool side-effect idempotency, usage correlation, event dedup, trace
  links (`775-781`). Retries reuse same ID; attempt ≠ new step.
- Budget counters are pure; cost/token reservations are deterministic.

### 5. Tests (pure)

- `transitions.test.ts`: invalid transitions, terminal-state rules
- `budgets.test.ts`: counters, cost/token reservations, exhaustion
- `step-id.test.ts`: stable derivation, dedup
- `schema.test.ts`, `validation.test.ts`, `compatibility.test.ts`: additive schema evolution,
  capability checks

## Anti-patterns

- Adding `fetch`/`fs`/`Date.now`/`Math.random`/`process.env` to `agent-kernel` or `agent-definition`
  (must remain pure; use activities for effects) (`491-503`).
- Allowing `allowed_models` to accept arbitrary provider strings — must check capability registry
  (`agent_studio_architecture.md:406`).
- Storing raw prompts or full history in workflow state — pass refs via `neryva-mcp-client`
  claim-check (`758-770`).

## References

- `agent_studio_implementation_plan.md:736-785` kernel, `688-735` definition pipeline, `86-98`
  package layout
- `agent_studio_architecture.md:322-351` execution model, `357-406` definitions, `394` pinning
- `docs/architecture/agent_studio/imp/ledger.md:114-132` Phase 1 checklist + exit gates

## Exit gates (Phase 1)

- Kernel simulates bounded read-only run without network
- Invalid transitions + budget exhaustion deterministic
- One immutable definition → one stable compiled representation
- 7 validation rejection classes have typed errors and tests
