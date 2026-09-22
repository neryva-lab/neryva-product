# ADR-007 — Workflow Versioning Strategy (Temporal)

Date: 2026-09-02 Status: accepted Deciders: Agent Studio architecture Source:
`agent_studio_implementation_plan.md:850-853`, `agent_studio_architecture.md:133-143`

## Context

`AgentRunWorkflow` is a durable, long-running workflow scheduled on Temporal. Runs started before a
deploy may still be executing when new worker code rolls out. Replay must succeed; history is
immutable. Breaking replay would strand runs or duplicate business effects (e.g., `CommitRunResult`
twice).

## Decision

- Use **Temporal version markers** (`patched` / `deprecatePatch`) via `workflow-versioning.ts` —
  each incompatible change gets a stable string id (e.g., `continue-as-new-v2`,
  `approval-signal-v2`).
- **Keep old paths until executions finish** — old code remains in worker binary until no open
  workflows carry that history version.
- Never do a **replay-breaking deploy without migration**: either drain old workflows, or keep shim
  handling both paths.
- `CURRENT_WORKFLOW_VERSION = agent-run-v1` ships as baseline; future changes are added, not
  replaced.
- `Continue-As-New` preserves pending signals and bumps `workflowGeneration` so `deriveStepId`
  remains stable.

## Consequences

- Worker bundle grows slightly but replay remains deterministic.
- CI enforces bundle determinism (`pnpm check:generated`) and replay tests
  (`packages/workflows/tests/replay.test.ts`).
- Deployment pipeline must keep both old and new workers briefly (rolling, then cleanup).
- Never copy arbitrary `75000` history limits — thresholds are measured and documented in
  `continue-as-new.ts`.

## Alternatives

- No versioning (break replay) — rejected.
- Full workflow reset per deploy — rejected (loses approval waits).

## Verification

- `packages/workflows/tests/replay.test.ts` replays history from v1.
- `pnpm check:generated` ensures bundle has only deterministic imports.
