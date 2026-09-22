/**
 * updates.ts — Temporal Updates for sync validation/tracking
 * Source: agent_studio_implementation_plan.md:1102-1117
 * Update only when sync validation/tracking needed; otherwise Signal (drain at safe points).
 */

import { defineUpdate } from '@temporalio/workflow';
import type { DeliverRunInputSignalPayload } from './signals.js';

export interface UpdateResult {
  accepted: boolean;
  reason?: string | undefined;
  signalId: string;
}

export const deliverRunInputUpdate: ReturnType<
  typeof defineUpdate<UpdateResult, [DeliverRunInputSignalPayload]>
> = defineUpdate<UpdateResult, [DeliverRunInputSignalPayload]>('DeliverRunInputUpdate');

export const UPDATE_NAMES = {
  deliverRunInput: 'DeliverRunInputUpdate',
} as const;
