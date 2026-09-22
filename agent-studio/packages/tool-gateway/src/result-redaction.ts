/**
 * result-redaction.ts — redact and bound tool results (strict by default)
 * Source: agent_studio_architecture.md:507-510 (10 return only permitted result), 1153-1161 (no prompts/secrets in logs)
 */

import { createHash } from 'node:crypto';

export type RedactionPolicy = 'strict' | 'permissive';

const SENSITIVE_KEYS = new Set([
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'credential',
  'authorization',
]);

export function redactResult(
  result: unknown,
  policy: RedactionPolicy = 'strict',
  maxBytes = 32_768,
): unknown {
  if (result === null || result === undefined) return result;
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    // Bound result — indicate truncated, return hash/size not raw
    const hash = createHash('sha256').update(serialized).digest('hex').slice(0, 12);
    return { __truncated: true, hash, byteLength: Buffer.byteLength(serialized, 'utf8'), maxBytes };
  }
  if (policy === 'permissive') return result;
  // Strict: redact sensitive keys
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- result is unknown, need object check
  if (result != null && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (
        SENSITIVE_KEYS.has(k) ||
        k.toLowerCase().includes('secret') ||
        k.toLowerCase().includes('password')
      ) {
        out[k] = '[REDACTED]';
      } else if (v != null && typeof v === 'object') {
        out[k] = redactResult(v, policy, maxBytes);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return result;
}

export function isRedacted(result: unknown): boolean {
  const s = JSON.stringify(result ?? {});
  return s.includes('[REDACTED]') || s.includes('__truncated');
}
