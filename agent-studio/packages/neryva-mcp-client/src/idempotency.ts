/**
 * idempotency.ts — stable idempotency key handling
 * Source: agent_studio_implementation_plan.md:663-671, neryva_mcp_implementation_plan.md:105-106, 780-789
 * Every mutating RPC requires RequestContext.idempotency_key.
 * Same digest → same result; different digest → conflict.
 */

import { createHash } from 'node:crypto';

export function deriveIdempotencyKey(input: {
  runId: string;
  stepId: string;
  method: string;
}): string {
  const raw = `${input.runId}:${input.stepId}:${input.method}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export function validateIdempotencyKey(key: string): boolean {
  return typeof key === 'string' && key.length >= 8 && key.length <= 128;
}

// In-memory dedup for tests — production Engine is authority
export class IdempotencyStore {
  private readonly seen = new Map<string, unknown>();

  has(key: string): boolean {
    return this.seen.has(key);
  }

  get<T>(key: string): T | undefined {
    return this.seen.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.seen.set(key, value);
  }

  clear(): void {
    this.seen.clear();
  }
}
