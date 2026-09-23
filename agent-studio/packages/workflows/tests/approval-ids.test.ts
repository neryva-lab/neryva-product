/**
 * approval-ids.test.ts — approved calls must carry their approval ID into
 * execution.
 *
 * Regression for the Wave 4 smoke gap: the workflow obtained the approval
 * decision but executed the approved MUTATING call without the approvalId,
 * so the tool gateway rejected it with APPROVAL_REQUIRED after the user had
 * approved. This pins the binding contract the workflow relies on: record on
 * APPROVED, resolve at execution, never leak an ID to a call that wasn't
 * approved.
 */
import { describe, it, expect } from 'vitest';
import { ApprovalIdMap } from '../src/approval-ids.js';

describe('ApprovalIdMap', () => {
  it('resolves the recorded approval ID for an approved call', () => {
    const map = new ApprovalIdMap();
    map.recordApproved('call_1', 'aprv_run_0_call_1');
    expect(map.forExecution('call_1')).toBe('aprv_run_0_call_1');
  });

  it('returns undefined for calls that were never approved (READ_ONLY path)', () => {
    const map = new ApprovalIdMap();
    expect(map.forExecution('call_readonly')).toBeUndefined();
  });

  it('does not leak one call’s approval ID to another call', () => {
    const map = new ApprovalIdMap();
    map.recordApproved('call_1', 'aprv_1');
    expect(map.forExecution('call_2')).toBeUndefined();
  });

  it('forget drops the binding for denied/over-budget calls', () => {
    const map = new ApprovalIdMap();
    map.recordApproved('call_1', 'aprv_1');
    map.forget('call_1');
    expect(map.forExecution('call_1')).toBeUndefined();
  });

  it('latest record wins on re-approval', () => {
    const map = new ApprovalIdMap();
    map.recordApproved('call_1', 'aprv_old');
    map.recordApproved('call_1', 'aprv_new');
    expect(map.forExecution('call_1')).toBe('aprv_new');
  });
});
