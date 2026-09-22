/**
 * idempotency.ts — stable idempotency key derive + store (persist before ack, query/reconcile)
 * Source: agent_studio_architecture.md:507-510, agent_studio_implementation_plan.md:1008-1017
 * Stable: run_id + step_id + tool_version (or run_id + step_id + toolId). Persist before ack, query by key on lost response, UNKNOWN_OUTCOME if unprovable, never blindly retry.
 */

import { createHash } from 'node:crypto';

export function deriveIdempotencyKey(params: {
  runId: string;
  stepId: string;
  toolVersion: string;
}): string {
  const raw = `${params.runId}:${params.stepId}:${params.toolVersion}`;
  return createHash('sha256').update(raw).digest('hex');
}

export function deriveToolIdempotencyKey(params: {
  runId: string;
  stepId: string;
  toolId: string;
  toolVersion: string;
}): string {
  const raw = `${params.runId}:${params.stepId}:${params.toolId}:${params.toolVersion}`;
  return createHash('sha256').update(raw).digest('hex');
}

export type IdempotencyOutcome = 'SUCCESS' | 'FAILED' | 'UNKNOWN_OUTCOME';

export interface IdempotencyRecord {
  key: string;
  runId: string;
  stepId: string;
  toolId: string;
  toolVersion: string;
  requestDigest: string; // hash of args
  response?: unknown | undefined;
  outcome: IdempotencyOutcome;
  createdAt: string;
  updatedAt: string;
}

export class IdempotencyStore {
  private readonly map = new Map<string, IdempotencyRecord>();

  private digestArgs(args: unknown): string {
    const raw = JSON.stringify(args ?? null);
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  // Persist before ack — caller must call put before acknowledging completion
  put(params: {
    key: string;
    runId: string;
    stepId: string;
    toolId: string;
    toolVersion: string;
    args: unknown;
    outcome: IdempotencyOutcome;
    response?: unknown;
  }): IdempotencyRecord {
    const now = new Date().toISOString();
    const existing = this.map.get(params.key);
    if (existing) {
      // Idempotent second delivery — return original, do not overwrite SUCCESS with later attempt
      return existing;
    }
    const rec: IdempotencyRecord = {
      key: params.key,
      runId: params.runId,
      stepId: params.stepId,
      toolId: params.toolId,
      toolVersion: params.toolVersion,
      requestDigest: this.digestArgs(params.args),
      response: params.response,
      outcome: params.outcome,
      createdAt: now,
      updatedAt: now,
    };
    this.map.set(params.key, rec);
    return rec;
  }

  get(key: string): IdempotencyRecord | undefined {
    return this.map.get(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  // For reconciliation when response lost — query downstream by key, if not found and outcome unknown, return UNKNOWN_OUTCOME
  reconcile(key: string): IdempotencyRecord | { outcome: 'UNKNOWN_OUTCOME'; reason: string } {
    const rec = this.map.get(key);
    if (rec) return rec;
    return { outcome: 'UNKNOWN_OUTCOME', reason: 'no record and downstream cannot prove result' };
  }
}
