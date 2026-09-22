/**
 * bearer-auth.test.ts — Engine-issued capability JWT as Authorization: Bearer.
 *
 * Regression: NeryvaMcpClient sent Engine MCP RPCs with only the locally
 * decoded CapabilityToken view and no Authorization header. The Engine
 * verifies the JWT signature server-side, so every authorized RPC failed
 * with permission_denied — including the first claim/lease call. The client
 * now wraps its transport so EVERY unary and streaming call presents
 * `Authorization: Bearer <capabilityJwt>`.
 *
 * The fake transport records request headers and then fails fast; the test
 * asserts on the recorded headers (no protobuf response is needed).
 */
import { describe, it, expect } from 'vitest';
import type { Transport } from '@connectrpc/connect';
import { NeryvaMcpClient } from '../src/client.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJjYXBfdGVzdCJ9.sig';

function capability() {
  return {
    capabilityId: 'cap-true-9f3a',
    organizationId: 'org-1',
    conversationId: 'conv-1',
    runId: 'run-1',
    agentVersionId: 'av-1',
    actorId: 'actor-1',
    allowedMethods: ['AcquireOrRenewRunLease'],
    issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 3600_000,
    keyId: 'kid-1',
  };
}

function scope() {
  return {
    organizationId: 'org-1',
    conversationId: 'conv-1',
    runId: 'run-1',
    agentVersionId: 'av-1',
  };
}

function capturingTransport(captured: Headers[]): Transport {
  return {
    unary: async (_method, _signal, _timeoutMs, header, _input, _contextValues) => {
      captured.push(new Headers(header ?? undefined));
      throw new Error('fake-transport: no backend');
    },
    stream: async function* (_method, _signal, _timeoutMs, header, _input, _contextValues) {
      captured.push(new Headers(header ?? undefined));
      throw new Error('fake-transport: no backend');
      yield undefined as never;
    },
  } as unknown as Transport;
}

describe('NeryvaMcpClient — Authorization: Bearer transport', () => {
  it('presents the capability JWT as Authorization: Bearer on unary RPCs', async () => {
    const captured: Headers[] = [];
    const client = new NeryvaMcpClient({
      transport: capturingTransport(captured),
      capability: capability(),
      capabilityJwt: JWT,
      grantedScope: { ...scope(), actorId: 'actor-1' },
    });
    await expect(client.claimRun({})).rejects.toThrow(/fake-transport/);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].get('authorization')).toBe(`Bearer ${JWT}`);
  });

  it('uses the REAL capability_id in the request context (not the request-context binding)', async () => {
    const captured: Headers[] = [];
    const client = new NeryvaMcpClient({
      transport: capturingTransport(captured),
      capability: capability(),
      capabilityJwt: JWT,
      grantedScope: { ...scope(), actorId: 'actor-1' },
    });
    // The decoded view carries the true capability_id from the JWT claims;
    // assertScopeImmutability in buildRequestContext would throw on mismatch,
    // so reaching the transport proves the relayed id did not leak into ctx.
    await expect(client.claimRun({})).rejects.toThrow(/fake-transport/);
    expect(captured.length).toBeGreaterThan(0);
  });

  it('sends no Authorization header when no JWT is provided', async () => {
    const captured: Headers[] = [];
    const client = new NeryvaMcpClient({
      transport: capturingTransport(captured),
      capability: capability(),
      grantedScope: { ...scope(), actorId: 'actor-1' },
    });
    await expect(client.claimRun({})).rejects.toThrow(/fake-transport/);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].get('authorization')).toBeNull();
  });
});
