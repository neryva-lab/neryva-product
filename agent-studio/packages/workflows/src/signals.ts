/**
 * signals.ts — Temporal Signals for approval/cancellation/user-input
 * Source: agent_studio_implementation_plan.md:1102-1117, agent_studio_architecture.md:145-152
 * StartRun deterministic Workflow ID from run_id → no duplicate workflow (1106)
 * CancelRun; DeliverRunInput → Signal by default, Update only when sync validation needed; drain at safe points.
 *
 * Determinism: only import from @temporalio/workflow.
 */

import { defineSignal } from '@temporalio/workflow';

export interface CancelSignalPayload {
  reason: string;
  requestedBy: string; // actorId or organizationId
  requestedAt: string; // ISO
}

export interface ApprovalSignalPayload {
  approvalId: string;
  toolCallId: string;
  stepId: string;
  decision: 'APPROVED' | 'DENIED';
  /** One-time ID correlated to tool_call_id/step_id, idempotent, scoped org/run/tool_call (1116) */
  correlationId: string;
  decidedBy: string;
  decidedAt: string;
  /** Optional artifact ref for denial reason */
  reason?: string | undefined;
}

export interface UserInputSignalPayload {
  signalId: string;
  /** Bounded ref — never raw large document, use artifact if > MAX_INLINE_BYTES */
  inputRef?: string | undefined;
  /** Inline bounded text (<= MAX_INLINE_BYTES) */
  text?: string | undefined;
  receivedAt: string;
}

export interface DeliverRunInputSignalPayload {
  requestId: string;
  inputType: 'USER_MESSAGE' | 'TOOL_RESULT' | 'APPROVAL_DECISION';
  payload: unknown;
  idempotencyKey: string;
}

// Temporal signal definitions — workflow registers handlers via setHandler()
export const cancelSignal = defineSignal<[CancelSignalPayload]>('CancelRun');
export const approvalSignal = defineSignal<[ApprovalSignalPayload]>('ApprovalDecision');
export const userInputSignal = defineSignal<[UserInputSignalPayload]>('UserInput');
export const deliverInputSignal = defineSignal<[DeliverRunInputSignalPayload]>('DeliverRunInput');

// Legacy / compatibility — some callers use generic name
export const CANCEL_SIGNAL_NAME = 'CancelRun';
export const APPROVAL_SIGNAL_NAME = 'ApprovalDecision';
export const USER_INPUT_SIGNAL_NAME = 'UserInput';
export const DELIVER_INPUT_SIGNAL_NAME = 'DeliverRunInput';
