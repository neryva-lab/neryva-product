/**
 * redaction.ts — gateway redaction (no raw prompts/creds in logs/traces by default)
 * Source: agent_studio_implementation_plan.md:1153-1161, agent_studio_architecture.md:669
 */

export type RedactionMode = 'strict' | 'permissive';

const SENSITIVE_KEYS = new Set([
  'apiKey',
  'api_key',
  'authorization',
  'credential',
  'secret',
  'password',
  'token',
]);

export function redactValue(value: string, mode: RedactionMode = 'strict'): string {
  if (mode === 'permissive') return value.slice(0, 200);
  // strict: hash prefix + length
  const hash = simpleHash(value);
  return `[REDACTED hash=${hash} len=${value.length}]`;
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16).slice(0, 8);
}

export function redactObject<T>(obj: T, mode: RedactionMode = 'strict'): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactValue(obj, mode) as unknown as T;
  if (Array.isArray(obj)) return obj.map((v) => redactObject(v, mode)) as unknown as T;
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (
        SENSITIVE_KEYS.has(k) ||
        k.toLowerCase().includes('key') ||
        k.toLowerCase().includes('secret')
      ) {
        out[k] = '[REDACTED]';
      } else if (k === 'messages' || k === 'content' || k === 'text') {
        // Messages are derived artifacts, not stored raw in traces by default
        if (mode === 'strict') {
          const str = typeof v === 'string' ? v : JSON.stringify(v);
          out[k] = `[REDACTED len=${str.length} hash=${simpleHash(str)}]`;
        } else {
          out[k] = v;
        }
      } else {
        out[k] = redactObject(v as unknown, mode);
      }
    }
    return out as unknown as T;
  }
  return obj;
}

export function isRedacted(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('[REDACTED');
  if (value && typeof value === 'object') {
    const s = JSON.stringify(value);
    return s.includes('[REDACTED');
  }
  return false;
}
