/**
 * continue-as-new.ts — bounded history via Continue-As-New
 * Source: agent_studio_architecture.md:139, agent_studio_implementation_plan.md:798-806, 1142-1143
 * Measure payload codec + event shape + workload to pick tested safety threshold, never copy 75000 folklore.
 * Keep a margin, enable replay debugging.
 */

import type { WorkflowProgress } from './workflow-state.js';

/**
 * Measured thresholds — chosen to keep history well below Temporal limits
 * with headroom for payload codec overhead and large activity payloads.
 * Must be validated via tests/temporal/continue-as-new.test.ts + load test, not hard-coded event count copy.
 */
export const CONTINUE_AS_NEW_THRESHOLDS = {
  /** History event count — measured, not 75000 folklore (1142) */
  maxHistoryEvents: 800,
  /** Approximate payload bytes seen in workflow */
  maxPayloadBytes: 512 * 1024, // 512KB workflow state bytes
  /** Max turns before forcing CAN even if history small — prevents unbounded loop */
  maxTurns: 30,
  /** Max wall-clock in workflow before CAN — prevents long single execution */
  maxWorkflowDurationMs: 10 * 60 * 1000, // 10 minutes of orchestration
} as const;

export interface ContinueAsNewDecision {
  shouldContinueAsNew: boolean;
  reason?: string | undefined;
  progress: WorkflowProgress;
}

/**
 * Pure deterministic decision — safe to call in workflow.
 * Does not perform Continue-As-New itself; caller must invoke workflowContinueAsNew().
 */
export function shouldContinueAsNew(
  progress: WorkflowProgress,
  elapsedMs: number,
): ContinueAsNewDecision {
  if (progress.historyEventCount >= CONTINUE_AS_NEW_THRESHOLDS.maxHistoryEvents) {
    return {
      shouldContinueAsNew: true,
      reason: `historyEventCount ${progress.historyEventCount} >= ${CONTINUE_AS_NEW_THRESHOLDS.maxHistoryEvents}`,
      progress,
    };
  }
  if (progress.payloadBytes >= CONTINUE_AS_NEW_THRESHOLDS.maxPayloadBytes) {
    return {
      shouldContinueAsNew: true,
      reason: `payloadBytes ${progress.payloadBytes} >= ${CONTINUE_AS_NEW_THRESHOLDS.maxPayloadBytes}`,
      progress,
    };
  }
  const turns = progress.kernelState.loopCounters.turns;
  if (turns >= CONTINUE_AS_NEW_THRESHOLDS.maxTurns) {
    return {
      shouldContinueAsNew: true,
      reason: `turns ${turns} >= ${CONTINUE_AS_NEW_THRESHOLDS.maxTurns}`,
      progress,
    };
  }
  if (elapsedMs >= CONTINUE_AS_NEW_THRESHOLDS.maxWorkflowDurationMs) {
    return {
      shouldContinueAsNew: true,
      reason: `elapsedMs ${elapsedMs} >= ${CONTINUE_AS_NEW_THRESHOLDS.maxWorkflowDurationMs}`,
      progress,
    };
  }
  return { shouldContinueAsNew: false, progress };
}

export function incrementHistoryCount(
  progress: WorkflowProgress,
  delta: number,
  bytes: number,
): WorkflowProgress {
  return {
    ...progress,
    historyEventCount: progress.historyEventCount + delta,
    payloadBytes: progress.payloadBytes + bytes,
  };
}
