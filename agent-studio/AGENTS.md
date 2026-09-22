# AGENTS.md — Neryva Agent Studio

> **Engine = control plane and system of record. Agent Studio = execution plane / runtime. LLM =
> reasoning engine.** Every task is phase-gated by `docs/architecture/agent_studio/imp/ledger.md:1`.
> Do not start Phase N+1 before Phase N exit gates are `DONE`. Verify before you claim done.
> Harness backlog (post contract-v1.1): execution order and FL-* task IDs live in `docs/dev/final_ledger.md`
> (mirror of `engine/docs/dev/final_ledger.md`; canonical in the engine repo). FL-1 = publish blockers.

## Commands

```bash
# Install (pnpm canonical for monorepo)
pnpm install --frozen-lockfile
pnpm lint && pnpm format:check && pnpm typecheck
pnpm build

# Contract
pnpm check:generated        # buf generate + git diff --exit-code gen/ts + deterministic bundle check
pnpm check:dependencies     # package DAG + forbidden-import scan
pnpm check:container        # Dockerfile + image scan + SBOM

# Templates (merge gates for templates/ — run before every template PR)
pnpm templates:check        # registry.json parity (fail loud on stale hash/registry)
pnpm templates:lint         # Studio validator + Engine bounds + secrets + compile + §5 + eval gates

# Tests — run smallest relevant suite first
pnpm test:unit                         # kernel, budgets, step-id, definition
pnpm test:contract                      # Neryva MCP generated client/server compat
pnpm test:workflow                      # workflow replay, heartbeat, Continue-As-New
pnpm test:integration                   # Temporal TestEnv + fake Engine/MCP
pnpm test:isolation                     # cross-tenant capability confusion, artifact substitution
pnpm test:security                      # prompt-injection, secret redaction
pnpm test:property                      # idempotency, cursor replay
pnpm test:load && pnpm test:chaos      # tenant-skew, chaos, kill-9 after durable boundary
pnpm test:contract -- packages/model-gateway/tests/providers/openai.test.ts  # single provider conformance
```

If a command fails, fix it before writing code. Read `package.json:scripts` first — do not guess
flags.

## Project Structure

```
agent-studio/  # implementation root: <neryva-repo>/products/agent-studio/
├── package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.workspace.ts
├── apps/
│   ├── runtime-worker/    # Temporal workflows + activities (primary)
│   ├── runtime-control/   # internal health/readiness/audited operator controls (stateless)
│   ├── tool-worker/       # optional isolated tool pool (sandbox)
│   └── eval-worker/       # offline evaluation (after runtime stable)
├── packages/
│   ├── agent-kernel/      # pure bounded state machine, budgets, step-id
│   ├── agent-definition/  # immutable v1.schema.json parser/validator/compiler
│   ├── context-compiler/  # authorized context assembly, token budgeting, citations
│   ├── model-gateway/     # provider-neutral NeryvaModel* + Vercel AI SDK adapters
│   ├── tool-gateway/      # registry, effect/approval, idempotency, sandbox
│   ├── memory-retrieval/  # Engine-mediated retrieval, hybrid, citation-mapper
│   ├── neryva-mcp-client/ # generated @neryva/mcp-contract + interceptors + claim-check
│   ├── workflows/         # deterministic AgentRunWorkflow only
│   ├── activities/        # all non-deterministic: MCP, model, tool, artifact
│   ├── artifacts/         # claim-check refs, reader/writer, checksums, encryption
│   ├── telemetry/         # OTel bootstrap, traces/metrics, redaction
│   ├── security/          # workload identity, capabilities, egress, secret-provider
│   └── testkit/           # fake-mcp-engine, fake-model, temporal-test-env, fault-injection
├── contracts/
│   ├── agent-definition/v1.schema.json + compatibility.md
│   ├── provider/ (Neryva model/tool/error types) + tool/ (descriptor/effect-policy)
│   └── events/ (runtime-events, evaluation-events)
├── infra/
│   ├── docker/ (runtime-worker, runtime-control, tool-worker)
│   ├── kubernetes/base + overlays/{dev,staging,production}
│   ├── temporal/ (namespaces.md, task-queues.md, retention.md)
│   ├── policies/ (network-egress, workload-identity, sandbox)
│   └── observability/ (dashboards, alerts, service-level-objectives.md)
├── tests/ (contract, integration, temporal, security, isolation, property, load, chaos, evaluation)
└── docs/architecture/agent_studio/imp/ledger.md  # single source for execution order
```

Implementation root is `products/agent-studio/` relative to `docs/`. Do not rename a path without an
ADR per `agent_studio_implementation_plan.md:447`.

## Code Style

- **TypeScript strict** (`tsconfig.base.json` strict). No `any` at authorization boundaries; use
  `zod`/`JSON Schema` validation.
- **Package DAG is enforced** —
  `contracts → kernel/definition → gateways/context → activities → workflows → apps`
  (`agent_studio_implementation_plan.md:451`). Check `pnpm check:dependencies`.
- **Workflow code deterministic only** — no `fetch`, `fs`, `Date.now()`, `Math.random()`,
  `process.env`, `setTimeout`, provider SDK, or Engine DB in `packages/workflows`. Use
  `packages/activities` for effects.
- **Provider types never leak** outside `packages/model-gateway`. Define
  `NeryvaModelRequest/Response/ToolCall/Usage/ProviderError` (`agent_studio_architecture.md:432`).
- **No Engine DB credentials** in Studio — all data via `neryva-mcp-client` claim-check refs.
  `pg`/`drizzle` imports outside `engine/` → CI fail.

## Architecture — Non-Negotiable Invariants

Engine owns identity, authorization, canonical history, billing/usage ledger, audit, retention
(`agent_studio_implementation_plan.md:50`). Studio owns execution, model calls, context compilation,
tool-loop, temporary state. Temporal owns durable execution mechanics. Provider is never canonical
store. Studio has no Engine DB credentials. No second conversation/billing store.

Forbidden until proven via ADR + ledger gate: LangGraph + Temporal dual durability for same run
(`agent_studio_architecture.md:156`), Mastra as core (`170`), LiteLLM as core dependency (`444` —
only behind `model-gateway` for separate network boundary).

Every run pinned to one immutable `agent_version_id + policy snapshot`
(`agent_studio_architecture.md:394`). `allowed_models` must reference Model Gateway capability
registry (`406`).

## Boundaries

- ✅ **Always:** read `ledger.md:1` for current phase + task ID and put it in PR title; use
  generated `@neryva/mcp-contract` types (never hand-copy); enforce tenant scope in Engine query
  before serialization; attach
  `request_id/organization_id/conversation_id/run_id/agent_version_id/correlation_id/protocol_version/idempotency_key`
  per RPC; pass artifact refs not raw docs/secrets for large values; run `check:generated` +
  `check:dependencies` + relevant `test:*` before pushing.
- ⚠️ **Ask first:** adding new tool/RPC/field (needs `buf breaking` + compat note), adding
  LiteLLM/gateway/NATS/Redis, changing workflow determinism, adding provider fallback, changing
  budget limits.
- 🚫 **Never:** add Engine ORM/`pg` to Studio; import provider SDK in workflow; log raw
  prompts/credentials/tokens/full docs; let model self-authorize effectful tool; use provider
  conversation ID as canonical truth (`main.md:226`); create one worker per organization
  (`agent_studio_implementation_plan.md:547`); treat `WRAM` or generic JSON as security boundary.

## Testing — Run Before Every Commit

Unit (kernel transitions, budgets, definition compat) → Contract (envelope 8 fields + `ArtifactRef`
8 fields, UUIDv7, scope immutability, claim-check) → Temporal (replay, crash at every boundary,
heartbeat, Signal before/after wait, `Continue-As-New`) → Isolation/Security (capability confusion,
artifact substitution, prompt-injection via retrieved docs, secret leakage in traces/history) →
Provider (11 cases: streaming, tool round-trip, structured output success/refusal, timeout,
rate-limit+retry-after, auth failure, usage, cancellation, redaction) → Load/Chaos (tenant-skew,
history growth, kill-9 after durable boundary). Use fake providers + `temporal-test-env` +
`fault-injection` for determinism; live provider tests only in scheduled pipeline with spending
limits.

## Security

- Workload identity per deployment; runtime-worker gets only MCP execution access + Temporal
  permissions + assigned secret-manager creds + claim-check path — no broad
  object-store/billing/admin creds (`agent_studio_implementation_plan.md:1166`).
- Capability per operation:
  `signature/key version, expiry, org/conv/run/agent version, actor identity, capabilities, replay protection`
  → terminal auth error on mismatch, do not repair scope.
- Treat model output, retrieved docs, tool output, user input, external MCP as untrusted — cannot
  change tenant, policy, allowlisted tool/model, or bypass approval (`1194`).
- Artifact reads re-authorized fresh; `sha256==32B` at boundary; `purpose` enum allowlisted.

## Verification Gates (DoD excerpt)

Before marking `ledger.md` box `DONE`:

- [ ] `pnpm lint + format:check + typecheck + build` green with no runtime feature code (Phase 0).
- [ ] Generated MCP types reproducible (`buf generate && git diff --exit-code`).
- [ ] Workflow bundle contains only deterministic imports (`check:generated`).
- [ ] Kernel simulates bounded read-only run without network; invalid transitions deterministic.
- [ ] MCP conformance passes, scope immutability holds, duplicate → one Engine effect.
- [ ] Workflow crash resumes without duplicate business effect; `CommitRunResult` retry does not
      duplicate assistant message.
- [ ] No provider types escape `model-gateway`; credentials only in `activities`; usage via
      Engine/MCP.
- [ ] Prompt/secret redaction absent from default logs/traces/history (prove with `grep` on export).

If any box unchecked, task is **not done** — regardless of demo success.

## Git & PR

- Branch: `feat/studio-phase{0-11}-{scope}`. Conventional Commits. One ledger task ID per PR in
  title (e.g., `1.4`, `3.1`).
- Update `AGENTS.md` or `ledger.md` in same PR that changes the convention.
- Never edit generated `gen/ts` or `contracts` hand-copy.

## References

- `docs/architecture/agent_studio/imp/ledger.md:1` — execution order (read first)
- `docs/architecture/agent_studio/agent_studio_architecture.md:50` invariants, `133-143` durable
  constraints, `558-598` persistence
- `docs/architecture/agent_studio/agent_studio_implementation_plan.md:50` ownership, `59-79` 13
  rules, `447-503` dependency rules, `1553-1573` failure matrix
- `docs/architecture/main.md:86` responsibility split, `114-190` state separation
- `../products/neryva_mcp/neryva-mcp-contract/proto` — `neryva.mcp.v1` (consume via
  `contracts/mcp/dependency.md`)

## When Stuck

- Phase/order doubt → `ledger.md:1` (Phase + task ID required in every PR).
- Temporal determinism → `agent_studio_architecture.md:133` +
  `agent_studio_implementation_plan.md:826`.
- Gateway policy → `agent_studio_architecture.md:409` (Model) / `483` (Tool) / `446` (Context).

This file is committed to Git. Keep under 180 lines; link to specs instead of inlining them.
