/**
 * effect-policy.test.ts — effect_class vs approval_requirement orthogonal
 * Source: agent_studio_implementation_plan.md:989, ledger 6.2
 * READ_ONLY can require approval (confidential), MUTATING can be pre-approved only under explicit policy.
 */

import { describe, it, expect } from 'vitest';
import { decideEffectPolicy, EFFECT_POLICY_MATRIX } from '../src/effect-policy.js';
import type { ToolDescriptor } from '@neryva/contracts/tool/descriptor';

function makeDesc(overrides: Partial<ToolDescriptor>): ToolDescriptor {
  return {
    toolId: 'test_tool',
    version: '1.0.0',
    inputSchema: { type: 'object' },
    effectClass: 'READ_ONLY',
    approvalRequirement: 'NONE',
    egressClass: 'none',
    timeoutMs: 1000,
    idempotency: 'supported',
    redactionPolicy: 'strict',
    auditEventType: 'tool.test',
    executionMode: 'in-process',
    ...overrides,
  } as ToolDescriptor;
}

describe('effect-policy — orthogonal', () => {
  it('READ_ONLY with NONE does not require approval', () => {
    const d = makeDesc({ effectClass: 'READ_ONLY', approvalRequirement: 'NONE' });
    const dec = decideEffectPolicy(d);
    expect(dec.requiresApproval).toBe(false);
  });

  it('READ_ONLY with REQUIRED requires approval (confidential)', () => {
    const d = makeDesc({ effectClass: 'READ_ONLY', approvalRequirement: 'REQUIRED' });
    const dec = decideEffectPolicy(d);
    expect(dec.requiresApproval).toBe(true);
  });

  it('MUTATING with NONE requires approval unless explicitly pre-approved', () => {
    const d = makeDesc({ effectClass: 'MUTATING', approvalRequirement: 'NONE' });
    const dec = decideEffectPolicy(d);
    expect(dec.requiresApproval).toBe(true);
    const dec2 = decideEffectPolicy(d, new Set(['test_tool']));
    expect(dec2.requiresApproval).toBe(false);
  });

  it('MUTATING with REQUIRED always requires approval', () => {
    const d = makeDesc({ effectClass: 'MUTATING', approvalRequirement: 'REQUIRED' });
    const dec = decideEffectPolicy(d);
    expect(dec.requiresApproval).toBe(true);
  });

  it('DESTRUCTIVE always requires approval', () => {
    const d = makeDesc({ effectClass: 'DESTRUCTIVE', approvalRequirement: 'NONE' });
    const dec = decideEffectPolicy(d);
    expect(dec.requiresApproval).toBe(true);
    const d2 = makeDesc({ effectClass: 'DESTRUCTIVE', approvalRequirement: 'REQUIRED' });
    expect(decideEffectPolicy(d2).requiresApproval).toBe(true);
  });

  it('policy matrix covers all 6 combinations', () => {
    expect(EFFECT_POLICY_MATRIX.length).toBe(6);
    for (const row of EFFECT_POLICY_MATRIX) {
      const d = makeDesc({
        effectClass: row.effectClass,
        approvalRequirement: row.approvalRequirement,
      });
      const dec = decideEffectPolicy(d, new Set());
      // For MUTATING/NONE without pre-approval, matrix says requiresApproval true, which matches
      if (row.effectClass === 'MUTATING' && row.approvalRequirement === 'NONE') {
        expect(dec.requiresApproval).toBe(true);
      } else {
        expect(dec.requiresApproval).toBe(row.requiresApproval);
      }
    }
  });
});
