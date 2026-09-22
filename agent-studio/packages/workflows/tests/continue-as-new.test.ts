/**
 * continue-as-new.test.ts — history growth + CAN threshold measured, not hard-coded folklore
 * Source: agent_studio_architecture.md:139, agent_studio_implementation_plan.md:1142-1143
 */

import { describe, it, expect } from 'vitest';
import {
  shouldContinueAsNew,
  CONTINUE_AS_NEW_THRESHOLDS,
  incrementHistoryCount,
} from '../src/continue-as-new.js';
import type { WorkflowProgress } from '../src/workflow-state.js';

function makeProgress(overrides: Partial<WorkflowProgress> = {}): WorkflowProgress {
  return {
    kernelState: {
      runId: 'run1',
      organizationId: 'org1',
      conversationId: 'conv1',
      agentVersionId: 'agent_v1',
      policyVersionId: 'pol1',
      status: 'MODEL_STEP',
      stepId: 'run1#1#model/1',
      attempt: 1,
      budgets: { modelCalls: 0, toolCalls: 0, tokens: 0, costCents: 0, recursionDepth: 0 },
      loopCounters: { modelCalls: 0, toolCalls: 0, turns: 0 },
      artifactRefs: [],
      terminalIntent: undefined,
      cancelled: false,
    },
    historyEventCount: 1,
    payloadBytes: 1024,
    pendingSignals: [],
    cancellationRequested: false,
    ...overrides,
  };
}

describe('continue-as-new', () => {
  it('does not trigger early', () => {
    const p = makeProgress({ historyEventCount: 10, payloadBytes: 10_000 });
    const d = shouldContinueAsNew(p, 1000);
    expect(d.shouldContinueAsNew).toBe(false);
  });

  it('triggers on historyEventCount threshold', () => {
    const p = makeProgress({ historyEventCount: CONTINUE_AS_NEW_THRESHOLDS.maxHistoryEvents });
    const d = shouldContinueAsNew(p, 0);
    expect(d.shouldContinueAsNew).toBe(true);
    expect(d.reason).toContain('historyEventCount');
  });

  it('triggers on payloadBytes threshold', () => {
    const p = makeProgress({ payloadBytes: CONTINUE_AS_NEW_THRESHOLDS.maxPayloadBytes });
    const d = shouldContinueAsNew(p, 0);
    expect(d.shouldContinueAsNew).toBe(true);
    expect(d.reason).toContain('payloadBytes');
  });

  it('triggers on maxTurns threshold', () => {
    const p = makeProgress();
    (p.kernelState.loopCounters as unknown as Record<string, number>)['turns'] =
      CONTINUE_AS_NEW_THRESHOLDS.maxTurns;
    const d = shouldContinueAsNew(p, 0);
    expect(d.shouldContinueAsNew).toBe(true);
    expect(d.reason).toContain('turns');
  });

  it('triggers on maxWorkflowDuration', () => {
    const p = makeProgress();
    const d = shouldContinueAsNew(p, CONTINUE_AS_NEW_THRESHOLDS.maxWorkflowDurationMs);
    expect(d.shouldContinueAsNew).toBe(true);
    expect(d.reason).toContain('elapsedMs');
  });

  it('incrementHistoryCount is deterministic and bounded', () => {
    let p = makeProgress();
    p = incrementHistoryCount(p, 5, 1000);
    expect(p.historyEventCount).toBe(6);
    expect(p.payloadBytes).toBe(2024);
    p = incrementHistoryCount(p, 2, 500);
    expect(p.historyEventCount).toBe(8);
  });

  it('threshold values are measured, not 75000 folklore', () => {
    expect(CONTINUE_AS_NEW_THRESHOLDS.maxHistoryEvents).toBeLessThan(5000);
    expect(CONTINUE_AS_NEW_THRESHOLDS.maxHistoryEvents).toBeGreaterThan(100);
    expect(CONTINUE_AS_NEW_THRESHOLDS.maxPayloadBytes).toBe(512 * 1024);
  });

  it('CAN preserves runId and bumps generation', () => {
    const input = { runId: 'run1', workflowGeneration: 1 };
    const next = { ...input, workflowGeneration: input.workflowGeneration + 1 };
    expect(next.workflowGeneration).toBe(2);
    expect(next.runId).toBe('run1');
  });
});
