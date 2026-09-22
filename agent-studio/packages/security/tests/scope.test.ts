/**
 * scope.test.ts — tenant scope immutability
 */

import { describe, it, expect } from 'vitest';
import { assertScopeImmutability, validateScopeFields } from '../src/scope.js';

describe('scope', () => {
  it('rejects override', () => {
    const granted = {
      organizationId: 'org_A',
      conversationId: 'conv_1',
      runId: 'run_1',
      agentVersionId: 'v1',
    };
    expect(() => assertScopeImmutability(granted, { organizationId: 'org_B' } as never)).toThrow();
  });

  it('validates required fields', () => {
    expect(
      validateScopeFields({
        organizationId: 'org_A',
        conversationId: 'conv_1',
        runId: 'run_1',
        agentVersionId: 'v1',
      }).ok,
    ).toBe(true);
    expect(
      validateScopeFields({
        organizationId: '',
        conversationId: 'conv_1',
        runId: 'run_1',
        agentVersionId: 'v1',
      }).ok,
    ).toBe(false);
  });
});
