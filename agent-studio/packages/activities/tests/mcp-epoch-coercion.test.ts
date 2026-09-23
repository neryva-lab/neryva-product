/**
 * mcp-epoch-coercion.test.ts — the MCP activity edge converts workflow-side
 * numbers back to the uint64 bigints the protobuf client requires.
 *
 * Regression companion to version-extract.test.ts: the workflow passes plain
 * JSON numbers through Temporal activity args (bigint is not serializable);
 * the coercion MUST happen here, at the activity boundary, and must reject
 * negative/fractional values rather than silently corrupting the lease fence
 * or the version CAS.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMcpActivities, toUint64 } from '../src/mcp-activities.js';

describe('toUint64', () => {
  it('passes bigint through', () => {
    expect(toUint64(5n, 'epoch')).toBe(5n);
  });

  it('converts a safe-integer number', () => {
    expect(toUint64(7, 'epoch')).toBe(7n);
  });

  it('truncates nothing silently — fractional numbers throw', () => {
    expect(() => toUint64(1.5, 'epoch')).toThrow(/non-negative safe integer/);
  });

  it('rejects negatives', () => {
    expect(() => toUint64(-1, 'epoch')).toThrow();
    expect(() => toUint64(-1n, 'epoch')).toThrow();
  });

  it('rejects bigint beyond MAX_SAFE_INTEGER (precision loss would corrupt the fence)', () => {
    expect(() => toUint64(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 'epoch')).toThrow(
      /non-negative safe integer/,
    );
  });

  it('rejects unsafe-integer numbers', () => {
    expect(() => toUint64(Number.MAX_SAFE_INTEGER + 1, 'epoch')).toThrow(
      /non-negative safe integer/,
    );
    expect(() => toUint64(NaN, 'epoch')).toThrow(/non-negative safe integer/);
  });

  it('passes undefined through (optional fields stay unset)', () => {
    expect(toUint64(undefined, 'epoch')).toBeUndefined();
  });
});

describe('createMcpActivities epoch/version coercion', () => {
  function stubClient() {
    const calls: Record<string, unknown[]> = {};
    const client = {
      claimRun: vi.fn(async (p: unknown) => {
        calls.claimRun = [...(calls.claimRun ?? []), p];
        return { run: { leaseEpoch: 1, version: 2 } };
      }),
      releaseRunLease: vi.fn(async (epoch: unknown) => {
        calls.releaseRunLease = [...(calls.releaseRunLease ?? []), epoch];
        return {};
      }),
      commitRunResult: vi.fn(async (p: unknown) => {
        calls.commitRunResult = [...(calls.commitRunResult ?? []), p];
        return {};
      }),
      failRun: vi.fn(async (p: unknown) => {
        calls.failRun = [...(calls.failRun ?? []), p];
        return {};
      }),
    };
    return { client, calls };
  }

  it('releaseRunLease coerces a workflow number to bigint for the client', async () => {
    const { client, calls } = stubClient();
    const acts = createMcpActivities(client as never);
    await acts.releaseRunLease(5);
    expect(client.releaseRunLease).toHaveBeenCalledTimes(1);
    expect(calls.releaseRunLease?.[0]).toBe(5n);
  });

  it('commitRunResult coerces expectedVersion to bigint for the client', async () => {
    const { client, calls } = stubClient();
    const acts = createMcpActivities(client as never);
    await acts.commitRunResult({ resultText: 'done', expectedVersion: 3 });
    const sent = calls.commitRunResult?.[0] as { expectedVersion?: unknown };
    expect(sent.expectedVersion).toBe(3n);
  });

  it('failRun coerces expectedVersion to bigint for the client', async () => {
    const { client, calls } = stubClient();
    const acts = createMcpActivities(client as never);
    await acts.failRun({ errorCode: 'X', errorMessage: 'y', expectedVersion: 9 });
    const sent = calls.failRun?.[0] as { expectedVersion?: unknown };
    expect(sent.expectedVersion).toBe(9n);
  });

  it('acquireOrRenewRunLease coerces expectedLeaseEpoch to bigint for the client', async () => {
    const { client, calls } = stubClient();
    const acts = createMcpActivities(client as never);
    await acts.acquireOrRenewRunLease({ expectedLeaseEpoch: 7 });
    const sent = calls.claimRun?.[0] as { expectedLeaseEpoch?: unknown };
    expect(sent.expectedLeaseEpoch).toBe(7n);
  });

  it('still accepts bigint directly (non-Temporal callers)', async () => {
    const { client, calls } = stubClient();
    const acts = createMcpActivities(client as never);
    await acts.releaseRunLease(11n);
    expect(calls.releaseRunLease?.[0]).toBe(11n);
  });
});
