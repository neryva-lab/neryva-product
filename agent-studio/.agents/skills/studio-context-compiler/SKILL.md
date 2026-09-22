---
name: studio-context-compiler
description:
  Implement pure Context Compiler — authorized history/summary/memory/knowledge selectors, token
  budgeting, deterministic ordering/truncation, and provider-format mapping with citations. Use when
  touching packages/context-compiler or handling context budgeting, hybrid retrieval, or citation
  tracking.
---

# Studio Context Compiler — Authorized Context Assembly (Phase 5)

Pure planning/assembly from authorized Engine data. Prompt is derived artifact — canonical data
stays in Engine.

## When to use

- Editing
  `packages/context-compiler/src/{compiler,context-inputs,token-budget,history-selector,summary-selector,memory-selector,knowledge-selector,tool-selector,provider-format,citations,truncation}.ts`
  (`agent_studio_implementation_plan.md:179-198`)
- Changing `contracts/tool` tool-schema selection or `contracts/provider` mapping
- Adjusting token budgeting, truncation, or citation logic

## Workflow

### 1. Input model (`agent_studio_architecture.md:448-462`, `agent_studio_implementation_plan.md:922-941`)

```
definition + policy snapshot + user message + conversation history + summaries
+ approved memories + authorized knowledge results + permitted tools + output schema
+ provider capabilities + budget → provider-neutral context plan → provider-specific request
```

Assembly is separate module, not scattered across agent loop (`463`).

### 2. Responsibilities (`agent_studio_architecture.md:464-477`)

Token budgeting (`466`), message ordering (`467`), summary insertion (`468`), memory selection
(`469`), retrieval filtering (`470`), hybrid retrieval vector+lexical where it improves recall
(`471,556`), tool schema selection (`472`), provider format conversion (`473`), context truncation
(`474`), prompt-cache preparation (`476`), citation tracking (`477`). Final rendered prompt treated
as derived artifact (`479`).

### 3. Context stages — 11 steps in order (`agent_studio_implementation_plan.md:943-955`)

1 Validate scope/input metadata — 2 Load immutable definition/policy snapshot — 3 Select history by
`conversation sequence` not timestamp — 4 Add summaries with `source_range/version` — 5 Select
approved memories with visibility/expiry — 6 Retrieve knowledge via authorized Engine/MCP queries —
7 Select tools allowed for step+policy from `contracts/tool` + compiled definition — 8 Reserve
token/cost budget — 9 Deterministic ordering/truncation — 10 Map to provider request format — 11
Produce citation/source mapping + context diagnostics (`955`).

### 4. Selectors and token budgeting (`agent_studio_implementation_plan.md:179-198`)

- `history-selector.ts`: by `sequence` (`main.md:212`), bounded recent messages, never unbounded
  history
- `summary-selector.ts`: `source_range/version`, safe insertion
- `memory-selector.ts`: approved memories only, provenance/visibility/scope respected
- `knowledge-selector.ts`: authorized refs, `READY`+non-expired+non-deleted only
- `tool-selector.ts`: allowed for step+policy, from compiled `tool schemas` + capability registry
- `token-budget.ts` + `truncation.ts`: reserve budget, deterministic ordering, truncation that never
  removes system/policy constraints without safe failure

### 5. Invariants — fail-closed (`agent_studio_implementation_plan.md:957-965`)

- Never retrieve-then-authorize — authorize in Engine query before serialization (`958`,
  `main.md:189`).
- Never include expired/deleted/quarantined/unauthorized source (`959`).
- Never let truncation remove system/policy constraints without explicit safe failure (`960`).
- Never treat model-generated `"remember this"` as approved memory (`961`).
- Never depend on provider-managed `conversation_id` for reconstruction (`962`, `main.md:226`).
- Record source IDs/versions used, not necessarily full prompt (`963`, `479`).
- Safe failure when required policy context cannot be loaded
  (`agent_studio_implementation_plan.md:1440`) → typed `InsufficientContext`, not truncated unsafe
  prompt.

### 6. Tests

- `budgeting.test.ts` — token/cost budgeting, history limits, context limits
- `ordering.test.ts` — deterministic ordering, truncation, summary insertion
- `authorization.test.ts` — tenant/scope predicate, unauthorized retrieval never reaches model,
  retrieval filtering in query not post-filter (`agent_studio_architecture.md:556`)
- `provider-format.test.ts` — provider-specific request mapping per `NeryvaModelRequest`

## Anti-patterns

- Including quarantined/expired document because "retrieval returned it" — filter in Engine query
  before Studio sees it (`958`).
- Truncating system instructions to fit context window without failing safe (`960`).
- Using `Date.now()` in compiler for ordering — keep pure, use sequence/version.

## References

- `agent_studio_implementation_plan.md:922-965` compiler, `179-198` selectors, `1437` tool-schema
  from `contracts/tool`
- `agent_studio_architecture.md:446-481` Context Compiler, `479` derived prompt
- `docs/architecture/agent_studio/imp/ledger.md:190-205` Phase 5 checklist

## Exit gates (Phase 5)

- Context rebuildable from Engine references; no unauthorized retrieval reaches model; long
  conversations bounded; diagnostics identify omitted/truncated sources without leaking content
