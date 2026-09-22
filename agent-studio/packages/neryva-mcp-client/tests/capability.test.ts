/**
 * capability.test.ts — scope immutability, expiry, replay
 * Source: ledger.md:2.2, 2.5
 */

import { describe, it, expect } from 'vitest';
import { assertScopeImmutability, assertCapabilityForMethod } from '@neryva/security';
import { assertNotExpired, isExpired } from '@neryva/neryva-mcp-client';

describe('capability — scope immutability', () => {
  it('rejects organization_id override', () => {
    const granted = {
      organizationId: 'org_A',
      conversationId: 'conv_1',
      runId: 'run_1',
      agentVersionId: 'asst_v1',
    };
    expect(() => assertScopeImmutability(granted, { organizationId: 'org_B' } as never)).toThrow(
      /scope mismatch/,
    );
  });

  it('allows same scope', () => {
    const granted = {
      organizationId: 'org_A',
      conversationId: 'conv_1',
      runId: 'run_1',
      agentVersionId: 'asst_v1',
    };
    expect(() =>
      assertScopeImmutability(granted, { organizationId: 'org_A' } as never),
    ).not.toThrow();
  });
});

describe('capability — expiry', () => {
  it('detects expired token', () => {
    const now = Date.now();
    const token = {
      capabilityId: 'cap_1',
      organizationId: 'org_A',
      conversationId: 'conv_1',
      runId: 'run_1',
      agentVersionId: 'asst_v1',
      actorId: 'actor_1',
      allowedMethods: ['GetAuthorizedRunContext'],
      issuedAt: now - 10000,
      expiresAt: now - 1000,
      keyId: 'kid_1',
    };
    expect(isExpired(token, now)).toBe(true);
    expect(() => assertNotExpired(token, now)).toThrow(/expired/);
  });

  it('rejects method not in allowedMethods', () => {
    const token = {
      capabilityId: 'cap_1',
      organizationId: 'org_A',
      conversationId: 'conv_1',
      runId: 'run_1',
      agentVersionId: 'asst_v1',
      actorId: 'actor_1',
      allowedMethods: ['GetAuthorizedRunContext'],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      keyId: 'kid_1',
    };
    expect(() => assertCapabilityForMethod(token, 'CommitRunResult')).toThrow(/not allowed/);
    expect(() => assertCapabilityForMethod(token, 'GetAuthorizedRunContext')).not.toThrow();
  });
});
