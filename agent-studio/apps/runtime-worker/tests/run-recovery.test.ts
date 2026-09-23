/**
 * run-recovery.test.ts — worker-restart run-client recovery (Wave 4 GAP 2).
 *
 * Regression: the runtime-worker's per-run MCP clients live only in an
 * in-memory Map. When a worker was killed mid-run (Wave 4 scenario 2) and
 * Temporal replayed the workflow on a fresh worker, the completed admission
 * activity was NOT re-executed — the retried later activity found no claimed
 * client and failed with MCP_RUN_NOT_CLAIMED (365 occurrences in the Wave 4
 * failure log), and the workflow's own `failRun` reconciliation failed the
 * same way, leaving the Engine row DISPATCHED while Temporal marked FAILED.
 *
 * Fix: the workflow attaches a recovery envelope (run scope, dispatch
 * capability, expected lease epoch) as a trailing argument to every
 * MCP-dependent activity call; `wrapActivitiesWithRecovery` strips it and,
 * when the run client is missing, reconstructs the client from the dispatch
 * capability and re-acquires/renews the Engine lease BEFORE the activity
 * runs.
 *
 * Proves:
 *  1. fresh manager + envelope → client reconstructed, lease claimed, then
 *     the activity executes with the envelope stripped;
 *  2. no envelope → passthrough (no recovery attempted);
 *  3. client already present → no reconstruction (no duplicate claim);
 *  4. same-owner stale epoch → safe renew with the Engine-reported epoch;
 *  5. another owner's lease → never stolen; RUN_RECOVERY_FAILED surfaces and
 *     the partially-cached client is evicted;
 *  6. concurrent recovery for one run → single reconstruction (single-flight);
 *  7. failed recovery → client evicted, activity never runs;
 *  8. end-to-end through the real registry: `failRun` with an envelope on a
 *     fresh worker reconstructs and executes (the exact Wave 4 failure).
 */
import { describe, it, expect, vi, beforeEach, assert } from 'vitest';
import { wrapActivitiesWithRecovery } from '../src/activity-registry.js';

const SCOPE = {
  organizationId: 'org-1',
  conversationId: 'conv-1',
  runId: 'run-1',
  agentVersionId: 'av-1',
  actorId: 'actor-1',
};
const OUR_OWNER = 'agent-studio:actor-1';

const envelope = (overrides: Record<string, unknown> = {}) => ({
  __neryvaRecovery: true as const,
  scope: { ...SCOPE },
  capabilityToken: 'dispatch-jwt',
  capabilityId: 'cap-1',
  expectedLeaseEpoch: 3,
  ...overrides,
});

function staleLeaseError(leaseOwner: string, actualEpoch: number): Error {
  const cause = new Error('connect: code=failed_precondition: stale lease epoch') as Error & {
    metadata: { get(name: string): string | null };
  };
  cause.metadata = {
    get: (name: string) =>
      name === 'details'
        ? JSON.stringify({ lease_owner: leaseOwner, actual_epoch: actualEpoch })
        : null,
  };
  return new Error('claim failed', { cause });
}

/** Fake manager simulating a FRESH worker: no run client until dispatchClient. */
function freshWorkerManager() {
  const clients = new Map<
    string,
    { claimRun: ReturnType<typeof vi.fn>; failRun: ReturnType<typeof vi.fn> }
  >();
  const manager = {
    clientForRun: vi.fn((runId: string) => {
      const c = clients.get(runId);
      if (!c) throw new Error(`MCP_RUN_NOT_CLAIMED:${runId}`);
      return c;
    }),
    dispatchClient: vi.fn((scope: typeof SCOPE) => {
      const client = {
        claimRun: vi.fn(async () => ({ leaseEpoch: 4 })),
        failRun: vi.fn(async () => ({ ok: true })),
      };
      clients.set(scope.runId, client);
      return client;
    }),
    evictRun: vi.fn((runId: string) => {
      clients.delete(runId);
    }),
  };
  return { manager, clients };
}

describe('run-client recovery (worker restart)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reconstructs the client and claims the lease before the activity runs', async () => {
    const { manager, clients } = freshWorkerManager();
    const activity = vi.fn(async (params: unknown) => ({ ok: params }));
    const wrapped = wrapActivitiesWithRecovery(manager, { myActivity: activity });
    const fn = wrapped['myActivity'] as (params: unknown, recovery?: unknown) => Promise<unknown>;

    const result = await fn({ foo: 1 }, envelope());

    // Reconstruction happened first: dispatch capability → claim with the
    // workflow's expected epoch and owner.
    expect(manager.dispatchClient).toHaveBeenCalledTimes(1);
    const client = clients.get('run-1');
    assert(client, 'run client should have been reconstructed');
    expect(client.claimRun).toHaveBeenCalledTimes(1);
    expect(client.claimRun).toHaveBeenCalledWith({
      expectedLeaseOwner: OUR_OWNER,
      expectedLeaseEpoch: 3n,
    });
    // Then the activity ran with the envelope stripped.
    expect(activity).toHaveBeenCalledTimes(1);
    expect(activity).toHaveBeenCalledWith({ foo: 1 });
    expect(result).toEqual({ ok: { foo: 1 } });
  });

  it('passes through without recovery when no envelope is present', async () => {
    const { manager } = freshWorkerManager();
    const activity = vi.fn(async (params: unknown) => params);
    const wrapped = wrapActivitiesWithRecovery(manager, { myActivity: activity });
    const fn = wrapped['myActivity'] as (params: unknown) => Promise<unknown>;

    await fn({ foo: 1 });

    expect(manager.dispatchClient).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledWith({ foo: 1 });
  });

  it('does not reconstruct when the client is already claimed', async () => {
    const { manager, clients } = freshWorkerManager();
    // Simulate the original worker: client already claimed.
    manager.dispatchClient({ ...SCOPE });
    const activity = vi.fn(async () => 'done');
    const wrapped = wrapActivitiesWithRecovery(manager, { myActivity: activity });
    const fn = wrapped['myActivity'] as (params: unknown, recovery?: unknown) => Promise<unknown>;

    await fn({ foo: 1 }, envelope());

    expect(manager.dispatchClient).toHaveBeenCalledTimes(1); // the original claim only
    const claimed = clients.get('run-1');
    assert(claimed, 'original client should exist');
    expect(claimed.claimRun).not.toHaveBeenCalled(); // no re-claim
    expect(activity).toHaveBeenCalledTimes(1);
  });

  it('renews safely on same-owner stale epoch (never steals)', async () => {
    const { manager, clients } = freshWorkerManager();
    manager.dispatchClient.mockImplementation((scope: typeof SCOPE) => {
      const client = {
        claimRun: vi.fn(async (params: { expectedLeaseEpoch?: bigint }) => {
          if (params.expectedLeaseEpoch === 3n) throw staleLeaseError(OUR_OWNER, 7);
          return { leaseEpoch: 7 };
        }),
        failRun: vi.fn(async () => ({ ok: true })),
      };
      clients.set(scope.runId, client);
      return client;
    });
    const activity = vi.fn(async () => 'done');
    const wrapped = wrapActivitiesWithRecovery(manager, { myActivity: activity });
    const fn = wrapped['myActivity'] as (params: unknown, recovery?: unknown) => Promise<unknown>;

    await fn({ foo: 1 }, envelope());

    const staleClient = clients.get('run-1');
    assert(staleClient, 'client should exist after stale-epoch renew');
    const claimRun = staleClient.claimRun;
    expect(claimRun).toHaveBeenCalledTimes(2);
    expect(claimRun).toHaveBeenLastCalledWith({
      expectedLeaseOwner: OUR_OWNER,
      expectedLeaseEpoch: 7n,
    });
    expect(activity).toHaveBeenCalledTimes(1);
  });

  it('never steals another owner: surfaces RUN_RECOVERY_FAILED and evicts', async () => {
    const { manager, clients } = freshWorkerManager();
    manager.dispatchClient.mockImplementation((scope: typeof SCOPE) => {
      const client = {
        claimRun: vi.fn(async () => {
          throw staleLeaseError('agent-studio:run:other-run', 9);
        }),
        failRun: vi.fn(async () => ({ ok: true })),
      };
      clients.set(scope.runId, client);
      return client;
    });
    const activity = vi.fn(async () => 'done');
    const wrapped = wrapActivitiesWithRecovery(manager, { myActivity: activity });
    const fn = wrapped['myActivity'] as (params: unknown, recovery?: unknown) => Promise<unknown>;

    await expect(fn({ foo: 1 }, envelope())).rejects.toThrow(/^RUN_RECOVERY_FAILED:run-1:/);
    // Partially-cached client evicted — a later activity must not resolve it.
    expect(manager.evictRun).toHaveBeenCalledWith('run-1');
    expect(clients.has('run-1')).toBe(false);
    expect(() => manager.clientForRun('run-1')).toThrow('MCP_RUN_NOT_CLAIMED:run-1');
    // The activity never ran against an unclaimed client.
    expect(activity).not.toHaveBeenCalled();
  });

  it('recovers only once under concurrent activities (single-flight)', async () => {
    const { manager, clients } = freshWorkerManager();
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    manager.dispatchClient.mockImplementation((scope: typeof SCOPE) => {
      const client = {
        claimRun: vi.fn(async () => {
          await claimGate;
          return { leaseEpoch: 4 };
        }),
        failRun: vi.fn(async () => ({ ok: true })),
      };
      clients.set(scope.runId, client);
      return client;
    });
    const activity = vi.fn(async (params: unknown) => params);
    const wrapped = wrapActivitiesWithRecovery(manager, {
      activityA: activity,
      activityB: activity,
    });
    const fnA = wrapped['activityA'] as (params: unknown, recovery?: unknown) => Promise<unknown>;
    const fnB = wrapped['activityB'] as (params: unknown, recovery?: unknown) => Promise<unknown>;

    const pA = fnA({ a: 1 }, envelope());
    const pB = fnB({ b: 2 }, envelope());
    releaseClaim();
    await Promise.all([pA, pB]);

    expect(manager.dispatchClient).toHaveBeenCalledTimes(1);
    const singleFlightClient = clients.get('run-1');
    assert(singleFlightClient, 'client should exist after single-flight recovery');
    expect(singleFlightClient.claimRun).toHaveBeenCalledTimes(1);
    expect(activity).toHaveBeenCalledTimes(2);
  });

  it('evicts the client when reconstruction itself fails', async () => {
    const { manager, clients } = freshWorkerManager();
    manager.dispatchClient.mockImplementation(() => {
      throw new Error('transport down');
    });
    const activity = vi.fn(async () => 'done');
    const wrapped = wrapActivitiesWithRecovery(manager, { myActivity: activity });
    const fn = wrapped['myActivity'] as (params: unknown, recovery?: unknown) => Promise<unknown>;

    await expect(fn({ foo: 1 }, envelope())).rejects.toThrow(
      'RUN_RECOVERY_FAILED:run-1:transport down',
    );
    expect(manager.evictRun).toHaveBeenCalledWith('run-1');
    expect(clients.has('run-1')).toBe(false);
    expect(activity).not.toHaveBeenCalled();
  });

  it('fails closed without a dispatch capability (bootstrap-only workflows cannot recover)', async () => {
    const { manager } = freshWorkerManager();
    const activity = vi.fn(async () => 'done');
    const wrapped = wrapActivitiesWithRecovery(manager, { myActivity: activity });
    const fn = wrapped['myActivity'] as (params: unknown, recovery?: unknown) => Promise<unknown>;

    await expect(fn({ foo: 1 }, envelope({ capabilityToken: undefined }))).rejects.toThrow(
      /^RUN_RECOVERY_FAILED:run-1:no dispatch capability/,
    );
    expect(manager.dispatchClient).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
  });

  it('zero-arg and scalar-arg activities receive the envelope and strip it', async () => {
    const { manager } = freshWorkerManager();
    const zeroArg = vi.fn(async () => 'zero');
    const scalarArg = vi.fn(async (epoch: unknown) => `epoch:${String(epoch)}`);
    const wrapped = wrapActivitiesWithRecovery(manager, { zeroArg, scalarArg });

    const zero = wrapped['zeroArg'] as (recovery?: unknown) => Promise<unknown>;
    const scalar = wrapped['scalarArg'] as (epoch: unknown, recovery?: unknown) => Promise<unknown>;
    await expect(zero(envelope())).resolves.toBe('zero');
    await expect(scalar(9, envelope())).resolves.toBe('epoch:9');
    expect(zeroArg).toHaveBeenCalledWith();
    expect(scalarArg).toHaveBeenCalledWith(9);
    expect(manager.dispatchClient).toHaveBeenCalledTimes(1); // one recovery for the run
  });

  it('end-to-end: failRun with an envelope on a fresh worker reconstructs and executes', async () => {
    // Full registry path — the exact Wave 4 failure (failRun after restart).
    // The Temporal activity Context is stubbed so currentRunId() resolves.
    vi.mock('@temporalio/activity', () => ({
      Context: {
        current: () => ({ info: { workflowExecution: { workflowId: 'agent-run::run-1' } } }),
      },
    }));
    const { createActivityRegistry } = await import('../src/activity-registry.js');
    const { manager, clients } = freshWorkerManager();
    const registry = createActivityRegistry({ manager: manager as never });
    const failRun = registry['failRun'] as (
      params: { errorCode: string; errorMessage: string },
      recovery?: unknown,
    ) => Promise<unknown>;

    await failRun({ errorCode: 'FAILED', errorMessage: 'boom' }, envelope());

    expect(manager.dispatchClient).toHaveBeenCalledTimes(1);
    const client = clients.get('run-1');
    assert(client, 'run client should have been reconstructed for failRun');
    expect(client.claimRun).toHaveBeenCalledTimes(1);
    expect(client.failRun).toHaveBeenCalledTimes(1);
    expect(client.failRun).toHaveBeenCalledWith({
      errorCode: 'FAILED',
      errorMessage: 'boom',
      expectedVersion: undefined,
    });
  });
});
