/**
 * step-id.ts — stable logical step ID derivation
 * Source: agent_studio_implementation_plan.md:773-783
 * Stable ID = runId + workflow generation + step path
 * Used for: Temporal activity idempotency, tool side-effect idempotency, usage correlation, event dedup, trace links.
 * Retries of same logical step reuse same ID; attempt is separate.
 */

import { createHash } from 'node:crypto';

export type StepPath = string; // e.g., "model/1", "tool/search_tickets/1"

export function deriveStepId(params: {
  runId: string;
  workflowGeneration: number;
  stepPath: StepPath;
}): string {
  const raw = `${params.runId}:${params.workflowGeneration}:${params.stepPath}`;
  // Deterministic hash — first 12 chars of sha256 hex (not UUID, but stable)
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${params.runId}#${params.workflowGeneration}#${params.stepPath}#${hash}`;
}

export function deriveIdempotencyKey(params: {
  runId: string;
  stepId: string;
  toolVersion: string;
}): string {
  const raw = `${params.runId}:${params.stepId}:${params.toolVersion}`;
  return createHash('sha256').update(raw).digest('hex');
}

export function parseStepId(
  stepId: string,
): { runId: string; generation: number; path: string } | undefined {
  const parts = stepId.split('#');
  if (parts.length < 4) return undefined;
  const [runId, genStr, ...rest] = parts;
  if (runId === undefined || genStr === undefined) return undefined;
  const generation = Number(genStr);
  if (Number.isNaN(generation)) return undefined;
  // Last part is hash, rest is path
  const path = rest.slice(0, -1).join('#');
  return { runId, generation, path };
}
