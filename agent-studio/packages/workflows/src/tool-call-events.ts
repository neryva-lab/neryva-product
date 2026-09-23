/**
 * tool-call-events.ts — durable-event params for executed tool calls.
 *
 * Regression for the Wave 4 smoke gap: the workflow's tool loop executed an
 * approved MUTATING call (create_ticket) and emitted its ToolCallCompleted,
 * but the event never reached durable storage — while the run still
 * COMPLETED, so the loss was silent.
 *
 * Root cause: executeOne emitted ToolCallCompleted WITHOUT the top-level
 * stepId, so createRuntimeEvent derived the idempotency key
 * `<runId>:ToolCallCompleted:none:0` — IDENTICAL for every tool call in the
 * run. The Engine's appendRunEvents dedups on (run_id, event_id) via
 * onConflictDoNothing, so the second toolResult was accepted as a
 * "duplicate" (HTTP 200, duplicate:true) and no row was written. Verified
 * against the smoke DB: the derived id `evt_01a0cb73_ej10eg` exactly matches
 * the first (search_tickets) toolResult row, and the create_ticket append
 * returned 200 with no row.
 *
 * Fix: the stepId IS the stable identity of the tool execution
 * (`<runId>#<gen>#tool/<name>/<turn>/<r|m><i>`) — pass it as the event's
 * top-level stepId so each completion derives a distinct eventId, while
 * retries of the same execution still derive the same id (idempotent).
 *
 * Pure + deterministic: safe to import from workflow code and to unit test.
 */
import type {
  EventType,
  RuntimeEventBody,
} from '@neryva/contracts/events/runtime-events';

export interface ToolCallCompletedEmitScope {
  organizationId: string;
  conversationId: string;
  runId: string;
  correlationId: string;
}

export interface ToolCallCompletedEmitParams {
  scope: ToolCallCompletedEmitScope;
  /** Stable identity of the tool execution — MUST be the execution stepId. */
  stepId: string;
  toolName: string;
  toolCallId: string;
  success: boolean;
}

export interface ToolCallCompletedEmit {
  scope: ToolCallCompletedEmitScope;
  type: EventType;
  stepId: string;
  body: RuntimeEventBody;
}

/** Build the ToolCallCompleted emit params for one executed tool call. */
export function buildToolCallCompletedEmit(
  params: ToolCallCompletedEmitParams,
): ToolCallCompletedEmit {
  return {
    scope: params.scope,
    type: 'ToolCallCompleted',
    stepId: params.stepId,
    body: {
      kind: 'ToolCallCompleted',
      runId: params.scope.runId,
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      stepId: params.stepId,
      success: params.success,
    },
  };
}
