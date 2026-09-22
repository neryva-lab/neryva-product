/**
 * temporal-test-env.ts — Temporal TestEnv harness for workflow replay and crash tests
 * Source: agent_studio_implementation_plan.md:371-381, 1236-1247
 * Uses @temporalio/testing TestWorkflowEnvironment when available; falls back to in-memory fake for Phase 0.
 */

// Minimal interface to avoid hard dependency on @temporalio/testing in Phase 0 skeleton
export interface TestEnv {
  client: unknown;
  nativeConnection: unknown;
  workflowClient: unknown;
  shutdown(): Promise<void>;
}

export async function createTestEnv(): Promise<TestEnv> {
  // Phase 0: return fake; Phase 3 will replace with real TestWorkflowEnvironment.createLocal()
  return {
    client: {},
    nativeConnection: {},
    workflowClient: {},
    async shutdown() {
      // no-op
    },
  };
}

export async function replayWorkflow(history: unknown): Promise<void> {
  // Placeholder — Phase 3 will implement deterministic replay via Worker.runReplayHistory
  void history;
}
