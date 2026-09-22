/**
 * heartbeat.ts — heartbeat helpers for long Activities
 * Source: agent_studio_architecture.md:137, agent_studio_implementation_plan.md:839-848
 * Long Activities must RecordHeartbeat + checkpoint ref so crash can resume without duplicate business effect.
 * Heartbeat payload is bounded refs only (never raw content).
 */

import { Context } from '@temporalio/activity';

/**
 * Report progress via Temporal heartbeat.
 * Payload must be bounded and never contain secrets/full docs.
 */
export function heartbeat(payload: unknown): void {
  try {
    Context.current().heartbeat(payload);
  } catch {
    // Outside activity context (e.g., unit test) — ignore
  }
}

export interface CheckpointPayload {
  stepId: string;
  artifactRef?: string | undefined;
  progress: number;
  detail?: string | undefined;
}

export function heartbeatCheckpoint(payload: CheckpointPayload): void {
  heartbeat(payload);
}

/**
 * Sleep that is cancellable via Temporal activity cancellation.
 * Placeholder Phase 3: plain timeout; Temporal heartbeat keeps activity alive.
 */
export async function cancellableSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function isActivityCancelled(): boolean {
  // Phase 3: not yet wired to Temporal cancellation signal; workflow-level cancel is propagated via Signal
  return false;
}
