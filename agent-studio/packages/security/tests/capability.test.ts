/**
 * capability.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  isCapabilityExpired,
  assertCapabilityForMethod,
  checkReplay,
} from '../src/capabilities.js';

describe('capabilities', () => {
  it('expired detection', () => {
    const cap = {
      signatureVersion: 'v1',
      expiresAt: Date.now() - 1000,
      organizationId: 'org_A',
      conversationId: 'conv_1',
      runId: 'run_1',
      agentVersionId: 'v1',
      actorId: 'actor_1',
      allowedMethods: ['GetAuthorizedRunContext'],
      capabilityId: 'cap_1',
    };
    expect(isCapabilityExpired(cap)).toBe(true);
  });

  it('replay protection', () => {
    const cap: any = {
      signatureVersion: 'v1',
      expiresAt: Date.now() + 60000,
      organizationId: 'org_A',
      conversationId: 'conv_1',
      runId: 'run_1',
      agentVersionId: 'v1',
      actorId: 'actor_1',
      allowedMethods: ['*'],
      capabilityId: 'cap_1',
    };
    checkReplay(cap, 'nonce_1');
    expect(() => checkReplay(cap, 'nonce_1')).toThrow(/replay/);
  });

  it('method allowed', () => {
    const cap = {
      signatureVersion: 'v1',
      expiresAt: Date.now() + 60000,
      organizationId: 'org_A',
      conversationId: 'conv_1',
      runId: 'run_1',
      agentVersionId: 'v1',
      actorId: 'actor_1',
      allowedMethods: ['AppendRunEvents'],
      capabilityId: 'cap_1',
    };
    expect(() => assertCapabilityForMethod(cap, 'AppendRunEvents')).not.toThrow();
    expect(() => assertCapabilityForMethod(cap, 'CommitRunResult')).toThrow();
  });
});
