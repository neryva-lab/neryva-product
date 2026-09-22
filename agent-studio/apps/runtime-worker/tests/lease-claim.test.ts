/**
 * lease-claim.test.ts — idempotent lease re-claim + BigInt serialization.
 *
 * Regression 1 (idempotency): Temporal retries `acquireOrRenewRunLease`;
 * attempt 1 can acquire the lease (epoch 0→1) while its response is lost.
 * Attempt 2's `expectedEpoch=0` then fails the Engine CAS. The activity must
 * parse the Engine's `details` response header (actual_epoch + lease_owner):
 * if WE hold the lease it re-claims with the current epoch + our owner (a
 * renew, not a steal); otherwise it rethrows.
 *
 * Regression 2 (serialization): the Engine protobuf claim response carries
 * uint64 fields as BigInt, which Temporal's payload converter cannot
 * serialize. The activity must return plain JSON (BigInt → Number).
 */
import { describe, it, expect, vi } from 'vitest';
import { createActivityRegistry } from '../src/activity-registry.js';

const scope = {
  organizationId: 'org-1',
  conversationId: 'conv-1',
  runId: 'run-1',
  agentVersionId: 'av-1',
  actorId: 'actor-1',
};
const OUR_OWNER = 'agent-studio:actor-1';

function staleLeaseError(leaseOwner: string, actualEpoch: number): Error {
  const cause = new Error('connect: code=failed_precondition: stale lease epoch') as Error & {
    metadata: { get(name: string): string | null };
  };
  cause.metadata = {
    get: (name: string) =>
      name === 'details' ? JSON.stringify({ lease_owner: leaseOwner, actual_epoch: actualEpoch }) : null,
  };
  return new Error('claim failed', { cause });
}

function malformedDetailsError(): Error {
  const cause = new Error('connect: code=failed_precondition: stale lease epoch') as Error & {
    metadata: { get(name: string): string | null };
  };
  cause.metadata = { get: (name: string) => (name === 'details' ? 'not-json{{{' : null) };
  return new Error('claim failed', { cause });
}

interface ClaimCall {
  expectedLeaseOwner?: string;
  expectedLeaseEpoch?: bigint;
}

/** Fake manager: dispatchClient returns the scripted client; bootstrapClient likewise. */
function fakeManager(script: Array<unknown | Error>) {
  const calls: ClaimCall[] = [];
  const client = {
    claimRun: vi.fn(async (params: ClaimCall) => {
      calls.push(params);
      const next = script.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  return {
    calls,
    client,
    manager: {
      dispatchClient: () => client,
      bootstrapClient: () => client,
    },
  };
}

function acquireActivity(manager: unknown) {
  const registry = createActivityRegistry({ manager: manager as never });
  const fn = registry['acquireOrRenewRunLease'] as (params: {
    scope: typeof scope;
    expectedLeaseOwner?: string;
    expectedLeaseEpoch?: bigint;
    capabilityToken?: string;
    capabilityId?: string;
  }) => Promise<unknown>;
  return fn;
}

describe('acquireOrRenewRunLease — BigInt serialization', () => {
  it('converts BigInt claim fields to plain numbers (Temporal-serializable)', async () => {
    const { manager } = fakeManager([
      { leaseEpoch: 1n, acquired: true, run: { version: 2n } },
    ]);
    const acquire = acquireActivity(manager);
    const res = (await acquire({
      scope,
      capabilityToken: 'jwt',
      capabilityId: 'engine-dispatch',
    })) as Record<string, unknown>;
    expect(res['leaseEpoch']).toBe(1);
    expect(res['epoch']).toBe(1);
    expect(res['acquired']).toBe(true);
    expect((res['run'] as Record<string, unknown>)['version']).toBe(2);
    // Must survive a JSON round-trip — Temporal's payload converter equivalent.
    expect(() => JSON.stringify(res)).not.toThrow();
    expect(JSON.parse(JSON.stringify(res))).toEqual(res);
  });
});

describe('acquireOrRenewRunLease — idempotent re-claim', () => {
  it('re-claims with the current epoch + our owner when WE hold the stale lease', async () => {
    const { manager, calls, client } = fakeManager([
      staleLeaseError(OUR_OWNER, 1),
      { leaseEpoch: 1n, acquired: true, run: { version: 1n } },
    ]);
    const acquire = acquireActivity(manager);
    const res = (await acquire({
      scope,
      capabilityToken: 'jwt',
      capabilityId: 'engine-dispatch',
    })) as Record<string, unknown>;
    expect(client.claimRun).toHaveBeenCalledTimes(2);
    // Second attempt is a RENEW: current epoch + our owner — not a steal.
    expect(calls[1]).toEqual({ expectedLeaseOwner: OUR_OWNER, expectedLeaseEpoch: 1n });
    expect(res['leaseEpoch']).toBe(1);
    expect(res['acquired']).toBe(true);
  });

  it('rethrows when another owner holds the lease (never steal)', async () => {
    const { manager, client } = fakeManager([staleLeaseError('agent-studio:someone-else', 7)]);
    const acquire = acquireActivity(manager);
    await expect(
      acquire({ scope, capabilityToken: 'jwt', capabilityId: 'engine-dispatch' }),
    ).rejects.toThrow(/claim failed/);
    expect(client.claimRun).toHaveBeenCalledTimes(1);
  });

  it('rethrows when the details header is malformed', async () => {
    const { manager, client } = fakeManager([malformedDetailsError()]);
    const acquire = acquireActivity(manager);
    await expect(
      acquire({ scope, capabilityToken: 'jwt', capabilityId: 'engine-dispatch' }),
    ).rejects.toThrow(/claim failed/);
    expect(client.claimRun).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-stale errors without a second attempt', async () => {
    const { manager, client } = fakeManager([new Error('connect: unavailable')]);
    const acquire = acquireActivity(manager);
    await expect(
      acquire({ scope, capabilityToken: 'jwt', capabilityId: 'engine-dispatch' }),
    ).rejects.toThrow(/unavailable/);
    expect(client.claimRun).toHaveBeenCalledTimes(1);
  });

  it('falls back to the bootstrap client when no dispatch capability is relayed', async () => {
    const dispatched = { claimRun: vi.fn(async () => ({ leaseEpoch: 1n, acquired: true })) };
    const bootstrapped = { claimRun: vi.fn(async () => ({ leaseEpoch: 1n, acquired: true })) };
    const manager = {
      dispatchClient: () => dispatched,
      bootstrapClient: () => bootstrapped,
    };
    const acquire = acquireActivity(manager);
    await acquire({ scope });
    expect(bootstrapped.claimRun).toHaveBeenCalledTimes(1);
    expect(dispatched.claimRun).not.toHaveBeenCalled();
  });
});
