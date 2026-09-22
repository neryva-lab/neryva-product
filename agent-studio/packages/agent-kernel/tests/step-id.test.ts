/**
 * step-id.test.ts — stable step ID derivation
 * Source: agent_studio_implementation_plan.md:773-783
 */

import { describe, it, expect } from 'vitest';
import { deriveStepId, deriveIdempotencyKey, parseStepId } from '../src/step-id.js';

describe('step-id', () => {
  it('deriveStepId is deterministic', () => {
    const a = deriveStepId({ runId: 'run_123', workflowGeneration: 1, stepPath: 'model/1' });
    const b = deriveStepId({ runId: 'run_123', workflowGeneration: 1, stepPath: 'model/1' });
    expect(a).toBe(b);
  });

  it('different path → different id', () => {
    const a = deriveStepId({ runId: 'run_123', workflowGeneration: 1, stepPath: 'model/1' });
    const b = deriveStepId({ runId: 'run_123', workflowGeneration: 1, stepPath: 'model/2' });
    expect(a).not.toBe(b);
  });

  it('different generation → different id', () => {
    const a = deriveStepId({ runId: 'run_123', workflowGeneration: 1, stepPath: 'model/1' });
    const b = deriveStepId({ runId: 'run_123', workflowGeneration: 2, stepPath: 'model/1' });
    expect(a).not.toBe(b);
  });

  it('idempotency key stable and derived from run+step+version', () => {
    const k1 = deriveIdempotencyKey({
      runId: 'run_123',
      stepId: 'run_123#1#model/1#abc',
      toolVersion: '1.0.0',
    });
    const k2 = deriveIdempotencyKey({
      runId: 'run_123',
      stepId: 'run_123#1#model/1#abc',
      toolVersion: '1.0.0',
    });
    expect(k1).toBe(k2);
    expect(k1).toHaveLength(64); // sha256 hex
  });

  it('parseStepId round-trips', () => {
    const id = deriveStepId({
      runId: 'run_abc',
      workflowGeneration: 3,
      stepPath: 'tool/search_tickets',
    });
    const parsed = parseStepId(id);
    expect(parsed?.runId).toBe('run_abc');
    expect(parsed?.generation).toBe(3);
    expect(parsed?.path).toBe('tool/search_tickets');
  });

  it('retries reuse same logical step id (attempt separate)', () => {
    const stepId = deriveStepId({
      runId: 'run_123',
      workflowGeneration: 1,
      stepPath: 'tool/search_tickets/1',
    });
    // Attempt is not part of stepId; same stepId for retries
    const same = deriveStepId({
      runId: 'run_123',
      workflowGeneration: 1,
      stepPath: 'tool/search_tickets/1',
    });
    expect(stepId).toBe(same);
  });
});
