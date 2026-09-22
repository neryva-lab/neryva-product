/**
 * transitions.test.ts — kernel state machine tests
 * Source: ledger.md:1.7, agent_studio_implementation_plan.md:756-770
 */

import { describe, it, expect } from 'vitest';
import { createInitialState } from '../src/state.js';
import { transition } from '../src/transitions.js';
import { deriveStepId } from '../src/step-id.js';

function makeState() {
  const stepId = deriveStepId({ runId: 'run_123', workflowGeneration: 1, stepPath: 'admission' });
  return createInitialState({
    runId: 'run_123',
    organizationId: 'org_123',
    conversationId: 'conv_123',
    agentVersionId: 'asst_v1',
    policyVersionId: 'pol_1',
    stepId,
  });
}

describe('transitions — deterministic', () => {
  it('ADMISSION -> LOAD_CONTEXT via ADMITTED', () => {
    const s0 = makeState();
    expect(s0.status).toBe('ADMISSION');
    const s1 = transition(s0, { type: 'ADMITTED' });
    expect(s1.status).toBe('LOAD_CONTEXT');
  });

  it('invalid transition throws INVALID_TRANSITION', () => {
    const s0 = makeState();
    expect(() => transition(s0, { type: 'FINALIZE' })).toThrow(
      /invalid transition ADMISSION -> FINALIZE/,
    );
  });

  it('bounded read-only run succeeds', () => {
    let s = makeState();
    s = transition(s, { type: 'ADMITTED' });
    s = transition(s, { type: 'CONTEXT_LOADED' });
    s = transition(s, { type: 'POLICY_PASSED' });
    s = transition(s, { type: 'MODEL_COMPLETED', finishReason: 'stop', toolCallCount: 0 });
    s = transition(s, { type: 'INTERPRET_FINAL_ANSWER' });
    expect(s.status).toBe('FINALIZE');
    s = transition(s, { type: 'FINALIZE' });
    expect(s.status).toBe('COMMIT_RESULT');
    expect(s.terminalIntent).toBe('FINALIZE');
  });

  it('tool loop: READ_ONLY -> EXECUTE_TOOL -> MODEL_STEP', () => {
    let s = makeState();
    s = transition(s, { type: 'ADMITTED' });
    s = transition(s, { type: 'CONTEXT_LOADED' });
    s = transition(s, { type: 'POLICY_PASSED' });
    s = transition(s, { type: 'MODEL_COMPLETED', finishReason: 'tool-call', toolCallCount: 1 });
    s = transition(s, { type: 'INTERPRET_READ_ONLY_TOOL', toolId: 'search_tickets' });
    expect(s.status).toBe('EXECUTE_TOOL');
    s = transition(s, { type: 'TOOL_COMPLETED', toolId: 'search_tickets', success: true });
    expect(s.status).toBe('MODEL_STEP');
  });

  it('effectful requires approval', () => {
    let s = makeState();
    s = transition(s, { type: 'ADMITTED' });
    s = transition(s, { type: 'CONTEXT_LOADED' });
    s = transition(s, { type: 'POLICY_PASSED' });
    s = transition(s, { type: 'MODEL_COMPLETED', finishReason: 'tool-call', toolCallCount: 1 });
    s = transition(s, { type: 'INTERPRET_EFFECTFUL_TOOL', toolId: 'create_ticket' });
    expect(s.status).toBe('REQUEST_APPROVAL');
    expect(s.pendingApprovalRef?.toolCallId).toBe('create_ticket');
    s = transition(s, { type: 'APPROVAL_GRANTED', approvalId: 'aprv_1' });
    expect(s.status).toBe('EXECUTE_TOOL');
  });

  it('cancellation is global', () => {
    let s = makeState();
    s = transition(s, { type: 'ADMITTED' });
    s = transition(s, { type: 'CANCEL_REQUESTED', reason: 'user' });
    expect(s.status).toBe('CANCELLED');
    expect(s.cancelled).toBe(true);
  });

  it('budget exhaustion from MODEL_STEP goes to FAILED', () => {
    let s = makeState();
    s = transition(s, { type: 'ADMITTED' });
    s = transition(s, { type: 'CONTEXT_LOADED' });
    s = transition(s, { type: 'POLICY_PASSED' });
    // At MODEL_STEP, budget exhausted should go to FAILED
    s = transition(s, { type: 'BUDGET_EXHAUSTED', budget: 'maxModelCalls' });
    expect(s.status).toBe('FAILED');
  });

  it('invalid transitions are deterministic (same input → same error)', () => {
    const s0 = makeState();
    const attempt = () => transition(s0, { type: 'FINALIZE' });
    expect(attempt).toThrow(/invalid transition/);
    expect(attempt).toThrow(/invalid transition/);
  });
});
