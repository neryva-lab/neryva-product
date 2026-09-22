# Spike PoC — Phase 0 Architecture Validation (2026-09-02)

> Proves `agent_studio_architecture.md:674-694` 6 success criteria with fakes (no live
> Engine/Temporal/provider required for Phase 0). Full Temporal TestEnv + live provider spike will
> be added in Phase 3.

## Components

| Component             | Spike implementation                                                                                        | Location                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Engine endpoint       | `FakeMcpEngine` with `getAuthorizedRunContext` (bounded manifest, no raw docs)                              | `packages/testkit/src/fake-mcp-engine.ts`                                        |
| Neryva MCP connection | Generated `RequestContext` 8 fields + `ArtifactRef` 8 fields via `createRequestContext`/`createArtifactRef` | `packages/testkit/src/fixtures.ts`                                               |
| Temporal workflow     | `AgentRunWorkflow` skeleton (deterministic, IDs/refs only, no provider SDK)                                 | `packages/workflows/src/index.ts` (Phase 0 placeholder) + `temporal-test-env.ts` |
| Model provider        | `FakeModel` with `enqueue({text, toolCalls, usage})` → deterministic `generate()`                           | `packages/testkit/src/fake-model.ts`                                             |
| Read-only tool        | `FakeTools.search_tickets` → `{tickets: []}`                                                                | `packages/testkit/src/fake-tools.ts`                                             |
| Streamed response     | Ephemeral delta via `FakeModel` streaming (coalesced; final via `commitRunResult`)                          | `tests/integration/spike.test.ts`                                                |
| Worker crash          | `FaultInjector` `{type: 'crash', after: 'model'}` + `FaultInjector.shouldCrash()`                           | `packages/testkit/src/fault-injection.ts`                                        |

## Success criteria (must all pass)

1. **Run resumes after worker failure** — `FaultInjector` crashes after `model` call; second worker
   replays from `FakeMcpEngine` events (idempotent `appendRunEvents` with Engine sequence
   authoritative).
2. **Frontend receives final response** — `commitRunResult` returns `messageId` exactly once;
   duplicate `commitRunResult` with same `idempotencyKey` returns same `messageId` (no duplicate
   assistant message).
3. **No duplicate assistant message** — `FakeMcpEngine` dedup by `runId` (Engine is system of
   record, not provider).
4. **Engine remains canonical** — all context via `getAuthorizedRunContext` (filtered manifest, not
   raw DB), all events via `appendRunEvents`; Studio never writes `conversations/messages` directly.
5. **Workflow inputs/events bounded; large via claim-check** — workflow args are
   `requestId/organization_id/conversation_id/run_id/agent_version_id` only; large tool result
   `ArtifactRef` with `sha256==32B`, `purpose` enum, re-authorized on read.
6. **Spans exported with correlated run identifiers** — `packages/telemetry/src/bootstrap.ts`
   `initTelemetry` called before imports; spans carry
   `request_id/organization_id/conversation_id/run_id/correlation_id` (redacted, no prompts).

## How to run

```bash
pnpm test:integration -- tests/integration/spike.test.ts
```

See `tests/integration/spike.test.ts` for the runnable spike (uses only `testkit` fakes, no
network).
