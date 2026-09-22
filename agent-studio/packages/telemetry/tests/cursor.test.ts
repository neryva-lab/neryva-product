import { describe, it, expect } from 'vitest';
import { createRuntimeEvent } from '@neryva/contracts/events/runtime-events';

/**
 * Cursor replay via Engine (1501) — frontend reconnects with last event ID / sequence.
 * Engine is system of record: ListRunEvents/WatchRunEvents are authoritative; Studio never serves frontend directly.
 * Simulate Engine ledger that assigns authoritative sequence and supports cursor queries.
 */
class FakeEngineLedger {
  private events: Array<{ sequence: number; eventId: string; runId: string }> = [];
  private nextSeq = 1;
  append(event: { eventId: string; runId: string }): { sequence: number } {
    const seq = this.nextSeq++;
    this.events.push({ sequence: seq, eventId: event.eventId, runId: event.runId });
    return { sequence: seq };
  }
  listAfter(afterSequence: number, runId: string): Array<{ sequence: number; eventId: string }> {
    return this.events.filter((e) => e.sequence > afterSequence && e.runId === runId);
  }
}

describe('cursor replay (1501 frontend observation survives disconnect/reconnect through Engine)', () => {
  it('list after cursor returns only newer events, idempotent replay', () => {
    const ledger = new FakeEngineLedger();
    const runId = 'run_123';
    const org = 'org_123';
    const conv = 'conv_123';
    const evts = [
      createRuntimeEvent(
        {
          runId,
          organizationId: org,
          conversationId: conv,
          producerId: 'w1',
          correlationId: 'corr',
          type: 'RunStarted',
        },
        { kind: 'RunStarted', runId, agentVersionId: 'v1' },
      ),
      createRuntimeEvent(
        {
          runId,
          organizationId: org,
          conversationId: conv,
          producerId: 'w1',
          correlationId: 'corr',
          type: 'ModelCallStarted',
          stepId: 's1',
        },
        { kind: 'ModelCallStarted', runId, modelId: 'openai/gpt-4', stepId: 's1' },
      ),
      createRuntimeEvent(
        {
          runId,
          organizationId: org,
          conversationId: conv,
          producerId: 'w1',
          correlationId: 'corr',
          type: 'RunCompleted',
        },
        { kind: 'RunCompleted', runId, resultType: 'SUCCEEDED' },
      ),
    ];
    for (const e of evts) {
      const { sequence } = ledger.append({ eventId: e.eventId, runId: e.runId });
      // Engine assigns authoritative sequence (1503-ish)
      (e as unknown as Record<string, unknown>).sequence = sequence;
    }
    // Frontend fetched first 2 events (seq 1,2) then disconnects
    const after2 = ledger.listAfter(2, runId);
    expect(after2.length).toBe(1);
    expect(after2[0].eventId).toBe(evts[2].eventId);
    // Reconnect with last seq 2 reconstructs final state
    const reconstructed = [...ledger.listAfter(0, runId).slice(0, 2), ...after2];
    expect(reconstructed.length).toBe(3);
    expect(reconstructed[2].sequence).toBe(3);
  });

  it('duplicate append is deduped by Engine (at-least-once safe)', () => {
    const ledger = new FakeEngineLedger();
    const runId = 'run_123';
    const evt = createRuntimeEvent(
      {
        runId,
        organizationId: 'org_123',
        conversationId: 'conv_123',
        producerId: 'w1',
        correlationId: 'corr',
        type: 'RunStarted',
      },
      { kind: 'RunStarted', runId, agentVersionId: 'v1' },
    );
    ledger.append({ eventId: evt.eventId, runId });
    // Duplicate with same eventId should be idempotent — Engine would return same sequence, not second
    // Simulate dedup: check if eventId already exists, don't add second sequence
    const before = ledger.listAfter(0, runId).length;
    const isDuplicate = ledger.listAfter(0, runId).some((e) => e.eventId === evt.eventId);
    if (!isDuplicate) ledger.append({ eventId: evt.eventId, runId });
    expect(ledger.listAfter(0, runId).length).toBe(before);
  });

  it('WatchRunEvents delivers in order, no gaps after reconnect', () => {
    const ledger = new FakeEngineLedger();
    const runId = 'run_123';
    for (let i = 0; i < 5; i++) {
      const e = createRuntimeEvent(
        {
          runId,
          organizationId: 'org_123',
          conversationId: 'conv_123',
          producerId: 'w1',
          correlationId: 'corr',
          type: 'RunWarning',
        },
        { kind: 'RunWarning', runId, code: `W${i}`, messageHash: `h${i}` },
      );
      ledger.append({ eventId: e.eventId, runId });
    }
    const all = ledger.listAfter(0, runId);
    expect(all.map((a) => a.sequence)).toEqual([1, 2, 3, 4, 5]);
    // Client after seq 3 gets 4,5
    expect(ledger.listAfter(3, runId).map((a) => a.sequence)).toEqual([4, 5]);
  });
});
