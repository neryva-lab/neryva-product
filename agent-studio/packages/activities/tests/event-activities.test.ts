import { describe, it, expect, beforeEach } from 'vitest';
import { createEventActivities } from '../src/event-activities.js';
import { getMetricSnapshot, resetMetrics } from '@neryva/telemetry';
import type { NeryvaMcpClient } from '@neryva/neryva-mcp-client';

describe('event-activities (1080-1089 emit after outcome, bounded else artifact, Engine sequence authoritative, retry only idempotent)', () => {
  beforeEach(() => resetMetrics());

  function fakeClient(shouldFail = false): NeryvaMcpClient {
    return {
      appendRunEvents: async (events: unknown) => {
        if (shouldFail) throw new Error('MCP unavailable');
        return { accepted: true, count: 1 };
      },
      commitRunResult: async (params: { resultText: string }) => ({
        committed: true,
        text: params.resultText,
      }),
    } as unknown as NeryvaMcpClient;
  }

  const SCOPE = {
    organizationId: 'org_123',
    conversationId: 'conv_123',
    runId: 'run_123',
    correlationId: 'corr_123',
  };

  function makeActs(client = fakeClient()) {
    return createEventActivities({ client, producerId: 'worker-1' });
  }

  it('emitEvent after outcome with stable idempotencyKey', async () => {
    const acts = makeActs();
    const res = await acts.emitEvent({
      scope: SCOPE,
      type: 'RunStarted',
      body: { kind: 'RunStarted', runId: 'run_123', agentVersionId: 'v1' },
    });
    expect(res.eventId.startsWith('evt_run_123')).toBe(true);
    expect(res.idempotencyKey).toBe('run_123:RunStarted:none:0');
    const snap = getMetricSnapshot();
    expect(
      Object.keys(snap.counters).some(
        (k) => k.includes('run_events_appended_total') && k.includes('RunStarted'),
      ),
    ).toBe(true);
  });

  it('bounded payload: large artifactContent uses ArtifactRef', async () => {
    const acts = makeActs();
    const large = new TextEncoder().encode('x'.repeat(9000));
    const res = await acts.emitEvent({
      scope: SCOPE,
      type: 'ModelCallCompleted',
      stepId: 's1',
      body: { kind: 'ModelCallCompleted', runId: 'run_123', modelId: 'openai/gpt-4', stepId: 's1' },
      artifactContent: large,
    });
    expect(res.wasArtifact).toBe(true);
  });

  it('small payload does not use artifact', async () => {
    const acts = makeActs();
    const small = new TextEncoder().encode('small');
    const res = await acts.emitEvent({
      scope: SCOPE,
      type: 'RunWarning',
      body: { kind: 'RunWarning', runId: 'run_123', code: 'W', messageHash: 'h' },
      artifactContent: small,
    });
    expect(res.wasArtifact).toBe(false);
  });

  it('retry only idempotent appends — critical vs best-effort: RunCompleted throws, RunWarning swallows', async () => {
    const acts = makeActs(fakeClient(true));
    await expect(
      acts.emitEvent({
        scope: SCOPE,
        type: 'RunCompleted',
        body: { kind: 'RunCompleted', runId: 'run_123', resultType: 'SUCCEEDED' },
      }),
    ).rejects.toThrow();
    // Best-effort should not throw
    const res = await acts.emitEvent({
      scope: SCOPE,
      type: 'RunWarning',
      body: { kind: 'RunWarning', runId: 'run_123', code: 'W', messageHash: 'h' },
    });
    expect(res.eventId).toBeDefined();
  });

  it('Engine sequence authoritative — Studio sequence diagnostic only', async () => {
    const acts = makeActs();
    const res = await acts.emitEvent({
      scope: SCOPE,
      type: 'RunStarted',
      body: { kind: 'RunStarted', runId: 'run_123', agentVersionId: 'v1' },
    });
    expect(res['sequence']).toBeUndefined(); // Engine will assign
  });

  it('emitBatch validates 1..32', async () => {
    const acts = makeActs();
    await expect(acts.emitBatch([])).rejects.toThrow(/1\.\.32/);
    const big = Array.from({ length: 33 }, () => ({
      scope: SCOPE,
      runId: 'run_123',
      organizationId: 'org_123',
      conversationId: 'conv_123',
      type: 'RunWarning' as const,
      schemaVersion: '1.0',
      producerId: 'w1',
      correlationId: 'corr',
      idempotencyKey: 'k',
      redaction: 'NONE' as const,
      producerTimestamp: new Date().toISOString(),
      body: { kind: 'RunWarning' as const, runId: 'run_123', code: 'W', messageHash: 'h' },
      eventId: 'e',
      sequence: undefined,
    }));
    await expect(
      acts.emitBatch(big as unknown as Parameters<typeof acts.emitBatch>[0]),
    ).rejects.toThrow();
  });

  it('commitRunResult is durable final (1502)', async () => {
    const acts = makeActs();
    const res = await acts.commitRunResult(SCOPE, 'final answer');
    expect((res as unknown as Record<string, unknown>).committed).toBe(true);
  });
});
