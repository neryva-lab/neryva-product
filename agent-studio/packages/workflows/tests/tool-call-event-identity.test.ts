/**
 * tool-call-event-identity.test.ts — every executed tool call must derive a
 * distinct durable eventId.
 *
 * Regression for the Wave 4 smoke gap: the workflow executed the approved
 * MUTATING call (create_ticket) but its ToolCallCompleted never reached
 * durable events — the run COMPLETED with only the search_tickets toolResult
 * recorded. Root cause: executeOne emitted ToolCallCompleted without the
 * top-level stepId, so both completions derived the identical idempotency
 * key `<runId>:ToolCallCompleted:none:0` → identical eventId
 * (`evt_01a0cb73_ej10eg`, verified against the smoke DB), and the Engine's
 * (run_id, event_id) dedup accepted the second append as a duplicate
 * (HTTP 200, duplicate:true, no row written).
 *
 * These tests pin the builder contract the workflow relies on: the
 * execution stepId is the event's identity. Revert the builder to omit
 * stepId and the first test fails (both completions collapse to one id).
 */
import { describe, it, expect } from 'vitest';
import {
  buildToolCallCompletedEmit,
  type ToolCallCompletedEmit,
} from '../src/tool-call-events.js';
import { createRuntimeEvent } from '@neryva/contracts/events/runtime-events';

const RUN_ID = '01a0cb73-bf54-7471-bd12-9771ddc3f5b4';
const SCOPE = {
  organizationId: '28c165ea-69c4-4046-a10b-d801aa36d37d',
  conversationId: '01a0cb45-96a5-7e39-86e6-0907d3aa8e01',
  runId: RUN_ID,
  correlationId: RUN_ID,
} as const;

/** What the emitEvent activity does with the builder output (minus transport). */
function toRuntimeEvent(emit: ToolCallCompletedEmit) {
  return createRuntimeEvent(
    {
      runId: emit.scope.runId,
      organizationId: emit.scope.organizationId,
      conversationId: emit.scope.conversationId,
      stepId: emit.stepId,
      type: emit.type,
      producerId: 'test-producer',
      correlationId: emit.scope.correlationId,
    },
    emit.body,
  );
}

describe('tool-call event identity', () => {
  it('READ_ONLY then approved MUTATING completions derive distinct eventIds', () => {
    // The exact Wave 4 smoke shape: turn 1 search_tickets (READ_ONLY, wave
    // r0), turn 2 create_ticket (MUTATING, approved, wave m0).
    const search = toRuntimeEvent(
      buildToolCallCompletedEmit({
        scope: { ...SCOPE },
        stepId: `${RUN_ID}#1#tool/search_tickets/1/r0`,
        toolName: 'search_tickets',
        toolCallId: 'call_6383521c8c69933d',
        success: true,
      }),
    );
    const create = toRuntimeEvent(
      buildToolCallCompletedEmit({
        scope: { ...SCOPE },
        stepId: `${RUN_ID}#1#tool/create_ticket/2/m0`,
        toolName: 'create_ticket',
        toolCallId: 'call_6b92c1d178c14ad',
        success: true,
      }),
    );
    // Without the fix both derive evt_01a0cb73_ej10eg and the Engine
    // dedups the second — this assertion fails on that code.
    expect(create.eventId).not.toBe(search.eventId);
    // The derivation is deterministic: the same execution always maps to
    // the same id (see the idempotency test below).
    expect(create.eventId).toBe(
      toRuntimeEvent(
        buildToolCallCompletedEmit({
          scope: { ...SCOPE },
          stepId: `${RUN_ID}#1#tool/create_ticket/2/m0`,
          toolName: 'create_ticket',
          toolCallId: 'call_6b92c1d178c14ad',
          success: true,
        }),
      ).eventId,
    );
  });

  it('omitting the execution stepId collapses both completions to one eventId', () => {
    // Characterizes the pre-fix derivation the smoke hit: stepId absent
    // from the event identity → both toolResults share one id.
    const base = {
      runId: RUN_ID,
      organizationId: SCOPE.organizationId,
      conversationId: SCOPE.conversationId,
      type: 'ToolCallCompleted' as const,
      producerId: 'test-producer',
      correlationId: SCOPE.correlationId,
    };
    const a = createRuntimeEvent(base, {
      kind: 'ToolCallCompleted',
      runId: RUN_ID,
      toolName: 'search_tickets',
      toolCallId: 'call_aaa',
      stepId: `${RUN_ID}#1#tool/search_tickets/1/r0`,
      success: true,
    });
    const b = createRuntimeEvent(base, {
      kind: 'ToolCallCompleted',
      runId: RUN_ID,
      toolName: 'create_ticket',
      toolCallId: 'call_bbb',
      stepId: `${RUN_ID}#1#tool/create_ticket/2/m0`,
      success: true,
    });
    expect(a.eventId).toBe(b.eventId);
    expect(a.eventId).toBe('evt_01a0cb73_ej10eg');
  });

  it('retries of the same execution stay idempotent (same stepId → same eventId)', () => {
    const params = {
      scope: { ...SCOPE },
      stepId: `${RUN_ID}#1#tool/create_ticket/2/m0`,
      toolName: 'create_ticket',
      toolCallId: 'call_6b92c1d178c14ad',
      success: true,
    } as const;
    const first = toRuntimeEvent(buildToolCallCompletedEmit({ ...params }));
    const retry = toRuntimeEvent(buildToolCallCompletedEmit({ ...params }));
    expect(retry.eventId).toBe(first.eventId);
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('the builder carries the execution stepId at the top level (not only in the body)', () => {
    const emit = buildToolCallCompletedEmit({
      scope: { ...SCOPE },
      stepId: `${RUN_ID}#1#tool/create_ticket/2/m0`,
      toolName: 'create_ticket',
      toolCallId: 'call_6b92c1d178c14ad',
      success: true,
    });
    expect(emit.stepId).toBe(`${RUN_ID}#1#tool/create_ticket/2/m0`);
    expect(emit.type).toBe('ToolCallCompleted');
  });
});
