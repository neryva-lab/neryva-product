/**
 * approval-version-refresh.test.ts — getRunVersion normalizes the Engine's
 * run version at the activity edge.
 *
 * Regression for the Wave 4 smoke failure: the Engine bumps runs.version on
 * the approval decision (WAITING_APPROVAL → RUNNING), so a workflow parked
 * on an approval holds a stale CAS token and its terminal commitRunResult
 * fails with "stale run version". The workflow refreshes via getRunVersion
 * after every approval decision. The activity MUST return a plain JSON
 * number — the result crosses Temporal back to the workflow, and bigint is
 * not serializable ("Unable to convert [object Object] to payload").
 */
import { describe, it, expect, vi } from 'vitest';
import { createApprovalActivities } from '../src/approval-activities.js';

function makeActivities(getRunImpl: () => Promise<{ version?: unknown }>) {
  const client = {
    getApprovalState: vi.fn(),
    getRun: vi.fn(getRunImpl),
  };
  return createApprovalActivities(client as never);
}

describe('getRunVersion', () => {
  it('normalizes a protobuf bigint version to a plain number', async () => {
    const activities = makeActivities(async () => ({ version: 7n }));
    const res = await activities.getRunVersion();
    expect(res).toEqual({ version: 7 });
    expect(typeof res.version).toBe('number');
  });

  it('passes a safe-integer number through', async () => {
    const activities = makeActivities(async () => ({ version: 12 }));
    const res = await activities.getRunVersion();
    expect(res).toEqual({ version: 12 });
  });

  it('returns null for a missing version rather than 0', async () => {
    const activities = makeActivities(async () => ({}));
    const res = await activities.getRunVersion();
    // null = absent: the workflow keeps its admission version instead of
    // silently resetting the CAS token to 0.
    expect(res).toEqual({ version: null });
  });

  it('returns null for a version beyond the safe integer range', async () => {
    const activities = makeActivities(async () => ({
      version: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    }));
    const res = await activities.getRunVersion();
    expect(res).toEqual({ version: null });
  });

  it('returns null for a negative or fractional version', async () => {
    for (const bad of [-1, 1.5, -3n]) {
      const activities = makeActivities(async () => ({ version: bad }));
      const res = await activities.getRunVersion();
      expect(res).toEqual({ version: null });
    }
  });

  it('propagates a client failure loudly — the workflow must not silently keep a stale token', async () => {
    const activities = makeActivities(async () => {
      throw new Error('boom');
    });
    await expect(activities.getRunVersion()).rejects.toThrow('boom');
  });
});
