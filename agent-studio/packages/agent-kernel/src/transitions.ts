/**
 * transitions.ts — pure bounded state machine
 * Source: agent_studio_architecture.md:322-351, agent_studio_implementation_plan.md:738-754
 * Deterministic: same state + event → same next state or typed error.
 */

import { StudioError } from './errors.js';
import { isTerminal, type KernelState, type AgentRunStatus } from './state.js';

export type KernelEvent =
  | { type: 'ADMITTED' }
  | { type: 'CONTEXT_LOADED' }
  | { type: 'POLICY_PASSED' }
  | { type: 'POLICY_FAILED'; reason: string }
  | { type: 'MODEL_COMPLETED'; finishReason: string; toolCallCount: number }
  | { type: 'INTERPRET_FINAL_ANSWER' }
  | { type: 'INTERPRET_READ_ONLY_TOOL'; toolId: string }
  | { type: 'INTERPRET_EFFECTFUL_TOOL'; toolId: string }
  | { type: 'INTERPRET_USER_INPUT'; signalId: string }
  | { type: 'INTERPRET_HANDOFF' }
  | { type: 'TOOL_COMPLETED'; toolId: string; success: boolean }
  | { type: 'APPROVAL_GRANTED'; approvalId: string }
  | { type: 'APPROVAL_DENIED'; reason: string }
  | { type: 'SIGNAL_RECEIVED'; signalId: string }
  | { type: 'BUDGET_CHECK_PASSED' }
  | { type: 'BUDGET_EXHAUSTED'; budget: string }
  | { type: 'CANCEL_REQUESTED'; reason: string }
  | { type: 'FINALIZE' }
  | { type: 'FAIL'; reason: string };

const ALLOWED: Record<AgentRunStatus, KernelEvent['type'][]> = {
  ADMISSION: ['ADMITTED', 'CANCEL_REQUESTED', 'FAIL'],
  LOAD_CONTEXT: ['CONTEXT_LOADED', 'CANCEL_REQUESTED', 'FAIL'],
  POLICY_CHECK: ['POLICY_PASSED', 'POLICY_FAILED', 'CANCEL_REQUESTED', 'FAIL'],
  MODEL_STEP: ['MODEL_COMPLETED', 'BUDGET_EXHAUSTED', 'CANCEL_REQUESTED', 'FAIL'],
  INTERPRET_MODEL_RESULT: [
    'INTERPRET_FINAL_ANSWER',
    'INTERPRET_READ_ONLY_TOOL',
    'INTERPRET_EFFECTFUL_TOOL',
    'INTERPRET_USER_INPUT',
    'INTERPRET_HANDOFF',
    'CANCEL_REQUESTED',
    'FAIL',
  ],
  EXECUTE_TOOL: ['TOOL_COMPLETED', 'BUDGET_EXHAUSTED', 'CANCEL_REQUESTED', 'FAIL'],
  REQUEST_APPROVAL: ['APPROVAL_GRANTED', 'APPROVAL_DENIED', 'CANCEL_REQUESTED', 'FAIL'],
  WAIT_FOR_SIGNAL: ['SIGNAL_RECEIVED', 'CANCEL_REQUESTED', 'FAIL'],
  BUDGET_CHECK: ['BUDGET_CHECK_PASSED', 'BUDGET_EXHAUSTED', 'CANCEL_REQUESTED', 'FAIL'],
  FINALIZE: ['FINALIZE', 'CANCEL_REQUESTED', 'FAIL'],
  COMMIT_RESULT: [],
  FAILED: [],
  CANCELLED: [],
};

function nextStatus(current: AgentRunStatus, event: KernelEvent): AgentRunStatus {
  // Terminal states are immutable — no event (including FAIL/CANCEL) may mutate them.
  // A committed run can never become FAILED; a cancelled run can never become FAILED.
  if (isTerminal(current)) {
    throw new StudioError({
      code: 'INVALID_TRANSITION',
      message: `cannot transition from terminal state ${current}`,
      retryable: 'non-retryable',
      details: { from: current, event: event.type },
    });
  }
  switch (current) {
    case 'ADMISSION':
      if (event.type === 'ADMITTED') return 'LOAD_CONTEXT';
      break;
    case 'LOAD_CONTEXT':
      if (event.type === 'CONTEXT_LOADED') return 'POLICY_CHECK';
      break;
    case 'POLICY_CHECK':
      if (event.type === 'POLICY_PASSED') return 'MODEL_STEP';
      if (event.type === 'POLICY_FAILED') return 'FAILED';
      break;
    case 'MODEL_STEP':
      if (event.type === 'MODEL_COMPLETED') return 'INTERPRET_MODEL_RESULT';
      if (event.type === 'BUDGET_EXHAUSTED') return 'FAILED';
      break;
    case 'INTERPRET_MODEL_RESULT':
      if (event.type === 'INTERPRET_FINAL_ANSWER') return 'FINALIZE';
      if (event.type === 'INTERPRET_READ_ONLY_TOOL') return 'EXECUTE_TOOL';
      if (event.type === 'INTERPRET_EFFECTFUL_TOOL') return 'REQUEST_APPROVAL';
      if (event.type === 'INTERPRET_USER_INPUT') return 'WAIT_FOR_SIGNAL';
      if (event.type === 'INTERPRET_HANDOFF') return 'FINALIZE'; // Escalate
      break;
    case 'EXECUTE_TOOL':
      if (event.type === 'TOOL_COMPLETED') return 'MODEL_STEP';
      if (event.type === 'BUDGET_EXHAUSTED') return 'FAILED';
      break;
    case 'REQUEST_APPROVAL':
      if (event.type === 'APPROVAL_GRANTED') return 'EXECUTE_TOOL';
      if (event.type === 'APPROVAL_DENIED') return 'FAILED';
      break;
    case 'WAIT_FOR_SIGNAL':
      if (event.type === 'SIGNAL_RECEIVED') return 'MODEL_STEP';
      break;
    case 'BUDGET_CHECK':
      if (event.type === 'BUDGET_CHECK_PASSED') {
        // After budget check, decide: if we came from FINAL_ANSWER, go FINALIZE, else MODEL_STEP
        // For Phase 1 bounded read-only run, we simplify: always go FINALIZE if no pending tool, else MODEL_STEP
        // The caller (agent-run.ts) will override this based on context; default to MODEL_STEP
        return 'MODEL_STEP';
      }
      if (event.type === 'BUDGET_EXHAUSTED') return 'FAILED';
      break;
    case 'FINALIZE':
      if (event.type === 'FINALIZE') return 'COMMIT_RESULT';
      break;
    default:
      break;
  }

  // Cancellation and failure are global for non-terminal states
  if (event.type === 'CANCEL_REQUESTED') {
    return 'CANCELLED';
  }
  if (event.type === 'FAIL') return 'FAILED';

  throw new StudioError({
    code: 'INVALID_TRANSITION',
    message: `invalid transition ${current} -> ${event.type}`,
    retryable: 'non-retryable',
    details: { from: current, to: event.type },
  });
}

export function canTransition(state: KernelState, event: KernelEvent): boolean {
  if (isTerminal(state.status)) return false;
  const allowed = ALLOWED[state.status];
  return allowed.includes(event.type) || event.type === 'CANCEL_REQUESTED' || event.type === 'FAIL';
}

export function transition(
  state: KernelState,
  event: KernelEvent,
  nextStepId?: string,
): KernelState {
  if (!canTransition(state, event)) {
    throw new StudioError({
      code: 'INVALID_TRANSITION',
      message: `invalid transition ${state.status} -> ${event.type}`,
      retryable: 'non-retryable',
      details: { from: state.status, to: event.type },
    });
  }

  const nextStatusValue = nextStatus(state.status, event);

  // Special handling for BUDGET_CHECK → FINALIZE vs MODEL_STEP is decided by caller via nextStepId hint
  // For Phase 1, we allow caller to pass nextStepId that encodes intent; otherwise default.

  const next: KernelState = {
    ...state,
    status: nextStatusValue,
    stepId: nextStepId ?? state.stepId,
    attempt:
      event.type === 'TOOL_COMPLETED' || event.type === 'MODEL_COMPLETED'
        ? state.attempt + 1
        : state.attempt,
  };

  // Update terminal intent
  if (nextStatusValue === 'COMMIT_RESULT') next.terminalIntent = 'FINALIZE';
  if (nextStatusValue === 'FAILED') {
    next.terminalIntent = 'FAILED';
    if ('reason' in event && typeof (event as { reason: string }).reason === 'string') {
      next.terminalReason = (event as { reason: string }).reason;
    }
  }
  if (nextStatusValue === 'CANCELLED') {
    next.terminalIntent = 'CANCELLED';
    next.cancelled = true;
  }

  // Update outcome refs
  if (event.type === 'MODEL_COMPLETED') {
    next.lastModelOutcomeRef = {
      stepId: state.stepId,
      toolCallCount: event.toolCallCount,
      finishReason: event.finishReason,
    };
    next.loopCounters = {
      ...state.loopCounters,
      modelCalls: state.loopCounters.modelCalls + 1,
      turns: state.loopCounters.turns + 1,
    };
  }
  if (event.type === 'TOOL_COMPLETED') {
    next.lastToolOutcomeRef = {
      stepId: state.stepId,
      toolId: event.toolId,
      success: event.success,
    };
    next.loopCounters = { ...state.loopCounters, toolCalls: state.loopCounters.toolCalls + 1 };
  }
  if (event.type === 'APPROVAL_GRANTED') {
    next.pendingApprovalRef = undefined;
  }
  if (event.type === 'INTERPRET_EFFECTFUL_TOOL') {
    next.pendingApprovalRef = {
      approvalId: `aprv_${state.stepId}`,
      toolCallId: event.toolId,
      stepId: state.stepId,
    };
  }

  return next;
}
