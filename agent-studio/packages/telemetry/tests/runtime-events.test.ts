import { describe, it, expect } from 'vitest';
import {
  createRuntimeEvent,
  validateRuntimeEvent,
  deriveIdempotencyKey,
  toMcpAppendBatch,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENT_BATCH,
} from '@neryva/contracts/events/runtime-events';

describe('runtime-events (1063-1076 durable semantic, 1080-1089 bounded/artifactRef, stable keys)', () => {
  const base = {
    runId: 'run_123',
    organizationId: 'org_123',
    conversationId: 'conv_123',
    producerId: 'worker-1',
    correlationId: 'corr_123',
    type: 'RunStarted' as const,
  };

  it('createRuntimeEvent stable idempotencyKey and eventId', () => {
    const e1 = createRuntimeEvent(base, {
      kind: 'RunStarted',
      runId: 'run_123',
      agentVersionId: 'v1',
    });
    const e2 = createRuntimeEvent(base, {
      kind: 'RunStarted',
      runId: 'run_123',
      agentVersionId: 'v1',
    });
    expect(e1.idempotencyKey).toBe(e2.idempotencyKey);
    // eventId deterministic from key + run (though timestamp adds variance, we check prefix)
    expect(e1.eventId.startsWith('evt_run_123')).toBe(true);
    expect(e1.idempotencyKey).toBe(
      deriveIdempotencyKey('run_123', 'RunStarted', undefined, undefined),
    );
  });

  it('different types produce different idempotency keys', () => {
    const k1 = deriveIdempotencyKey('run_123', 'RunStarted');
    const k2 = deriveIdempotencyKey('run_123', 'RunCompleted');
    expect(k1).not.toBe(k2);
  });

  it('validateRuntimeEvent rejects missing required fields', () => {
    expect(() =>
      validateRuntimeEvent({
        eventId: '',
        runId: 'r',
        organizationId: 'o',
        conversationId: 'c',
        type: 'RunStarted',
        schemaVersion: '1.0',
        producerId: 'w',
        correlationId: 'corr',
        idempotencyKey: 'k',
        redaction: 'NONE',
        producerTimestamp: new Date().toISOString(),
        body: { kind: 'RunStarted', runId: 'r', agentVersionId: 'v' },
      } as unknown as Parameters<typeof validateRuntimeEvent>[0]),
    ).toThrow(/eventId required/);
  });

  it('bounded payload: large body without artifactRef fails', () => {
    const bigBody = {
      kind: 'ModelCallCompleted' as const,
      runId: 'run_123',
      modelId: 'openai/gpt-4',
      stepId: 's1',
      textPreviewHash: 'h',
      usage: { inputTokens: 1 },
    };
    // Add large string to exceed 8192
    (bigBody as unknown as Record<string, unknown>).large = 'x'.repeat(9000);
    expect(() =>
      createRuntimeEvent(
        {
          runId: 'run_123',
          organizationId: 'org_123',
          conversationId: 'conv_123',
          producerId: 'w1',
          correlationId: 'corr',
          type: 'ModelCallCompleted',
        },
        bigBody as unknown as ReturnType<typeof createRuntimeEvent>['body'],
      ),
    ).toThrow(/must use artifactRef/);
  });

  it('large payload with artifactRef succeeds', () => {
    const bigBody = {
      kind: 'ModelCallCompleted' as const,
      runId: 'run_123',
      modelId: 'openai/gpt-4',
      stepId: 's1',
      textPreviewHash: 'h',
    };
    const artifactRef = {
      artifactId: 'art_1',
      organizationId: 'org_123',
      runId: 'run_123',
      purpose: 'TRANSCRIPT',
      mediaType: 'application/json',
      byteLength: 9000,
      sha256: new Uint8Array(32),
      expiresAt: new Date(Date.now() + 60_000),
    };
    const evt = createRuntimeEvent(
      {
        runId: 'run_123',
        organizationId: 'org_123',
        conversationId: 'conv_123',
        producerId: 'w1',
        correlationId: 'corr',
        type: 'ModelCallCompleted',
        stepId: 's1',
      },
      bigBody,
      artifactRef as unknown as Parameters<typeof createRuntimeEvent>[2],
    );
    expect(evt.artifactRef?.artifactId).toBe('art_1');
  });

  it('toMcpAppendBatch validates batch size 1..32', () => {
    const e = createRuntimeEvent(base, {
      kind: 'RunStarted',
      runId: 'run_123',
      agentVersionId: 'v1',
    });
    expect(() => toMcpAppendBatch([])).toThrow(/1\.\.32/);
    expect(() => toMcpAppendBatch(Array.from({ length: 33 }, () => e))).toThrow();
    expect(() => toMcpAppendBatch([e])).not.toThrow();
  });

  it('Engine sequence is authoritative — Studio producerSequence diagnostic only (1088)', () => {
    const evt = createRuntimeEvent(
      {
        runId: 'run_123',
        organizationId: 'org_123',
        conversationId: 'conv_123',
        producerId: 'w1',
        correlationId: 'corr',
        type: 'RunCompleted',
        producerSequence: 999,
      },
      { kind: 'RunCompleted', runId: 'run_123', resultType: 'SUCCEEDED' },
    );
    expect(evt.producerSequence).toBe(999);
    expect(evt.sequence).toBeUndefined(); // Engine will assign
    const batch = toMcpAppendBatch([evt]);
    expect((batch[0] as unknown as Record<string, unknown>).producerSequence).toBe(999);
  });

  it('all 13 event types create successfully', async () => {
    const types = [
      {
        type: 'RunStarted' as const,
        body: { kind: 'RunStarted' as const, runId: 'run_123', agentVersionId: 'v1' },
      },
      {
        type: 'ContextPrepared' as const,
        body: { kind: 'ContextPrepared' as const, runId: 'run_123', citationCount: 3 },
      },
      {
        type: 'ModelCallStarted' as const,
        body: {
          kind: 'ModelCallStarted' as const,
          runId: 'run_123',
          modelId: 'openai/gpt-4',
          stepId: 's1',
        },
      },
      {
        type: 'ModelCallCompleted' as const,
        body: {
          kind: 'ModelCallCompleted' as const,
          runId: 'run_123',
          modelId: 'openai/gpt-4',
          stepId: 's1',
        },
      },
      {
        type: 'ToolCallProposed' as const,
        body: {
          kind: 'ToolCallProposed' as const,
          runId: 'run_123',
          toolName: 'search',
          toolCallId: 'c1',
          stepId: 's1',
        },
      },
      {
        type: 'ToolCallApproved' as const,
        body: {
          kind: 'ToolCallApproved' as const,
          runId: 'run_123',
          toolName: 'search',
          toolCallId: 'c1',
          approvalId: 'a1',
        },
      },
      {
        type: 'ToolCallCompleted' as const,
        body: {
          kind: 'ToolCallCompleted' as const,
          runId: 'run_123',
          toolName: 'search',
          toolCallId: 'c1',
          stepId: 's1',
          success: true,
        },
      },
      {
        type: 'ApprovalRequested' as const,
        body: {
          kind: 'ApprovalRequested' as const,
          runId: 'run_123',
          approvalId: 'a1',
          toolCallId: 'c1',
        },
      },
      {
        type: 'ApprovalReceived' as const,
        body: {
          kind: 'ApprovalReceived' as const,
          runId: 'run_123',
          approvalId: 'a1',
          decision: 'APPROVED',
        },
      },
      {
        type: 'MemoryProposed' as const,
        body: {
          kind: 'MemoryProposed' as const,
          runId: 'run_123',
          proposalId: 'p1',
          scope: 'user',
        },
      },
      {
        type: 'RunWarning' as const,
        body: { kind: 'RunWarning' as const, runId: 'run_123', code: 'WARN', messageHash: 'h' },
      },
      {
        type: 'RunCompleted' as const,
        body: { kind: 'RunCompleted' as const, runId: 'run_123', resultType: 'SUCCEEDED' as const },
      },
      {
        type: 'RunFailed' as const,
        body: {
          kind: 'RunFailed' as const,
          runId: 'run_123',
          errorCode: 'E',
          errorMessageHash: 'h',
        },
      },
    ];
    for (const { type, body } of types) {
      const evt = createRuntimeEvent(
        {
          runId: 'run_123',
          organizationId: 'org_123',
          conversationId: 'conv_123',
          producerId: 'w1',
          correlationId: 'corr',
          type,
        },
        body as unknown as Parameters<typeof createRuntimeEvent>[1],
      );
      expect(evt.type).toBe(type);
      expect(evt.schemaVersion).toBe('1.0');
    }
    expect(MAX_EVENT_PAYLOAD_BYTES).toBe(8192);
    expect(MAX_EVENT_BATCH).toBe(32);
  });
});
