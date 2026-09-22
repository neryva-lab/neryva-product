/**
 * redaction.ts — telemetry data policy (no raw prompts/creds in logs)
 * Source: agent_studio_implementation_plan.md:1153-1161 (default: no raw prompts, full docs, tool args, credentials, model outputs; store hashes/sizes/classifications/artifact IDs; diagnostic content only under expiring authorized mode 1157; no high-cardinality labels 1159),
 * 1344 (bootstrap before app imports), docs/toolchain.md (hash-only default)
 * Also covers bootstrap.ts REDACTED_FIELDS consolidation.
 */
import { createHash } from 'node:crypto';

export const REDACTED_FIELDS = new Set([
  'prompt',
  'completion',
  'tool_args',
  'tool_result',
  'document',
  'credential',
  'api_key',
  'authorization',
  'capability_token',
  'secret',
  'password',
  'provider_response',
  'raw_message',
]);

export interface DiagnosticMode {
  enabled: boolean;
  expiresAt: Date;
  authorizedBy: string;
  reason: string;
}

let diagnosticMode: DiagnosticMode | undefined;

export function setDiagnosticMode(mode: DiagnosticMode | undefined): void {
  if (mode && mode.expiresAt.getTime() <= Date.now())
    throw new Error('diagnostic mode expired already');
  diagnosticMode = mode;
}

export function isDiagnosticModeActive(): boolean {
  if (!diagnosticMode) return false;
  if (diagnosticMode.expiresAt.getTime() <= Date.now()) {
    diagnosticMode = undefined;
    return false;
  }
  return diagnosticMode.enabled;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function redactField(key: string, value: unknown, depth = 0): unknown {
  const lower = key.toLowerCase();
  for (const f of REDACTED_FIELDS) {
    if (lower.includes(f)) return '[REDACTED]';
  }
  // Heuristic: if value is long string that looks like prompt/document, hash it
  if (typeof value === 'string' && value.length > 200) {
    if (lower.includes('text') || lower.includes('content') || lower.includes('args')) {
      return `[REDACTED hash:${hashContent(value)} len:${value.length}]`;
    }
  }
  // Recurse into nested objects/arrays — sensitive keys must not hide one level deep
  if (depth < 4 && typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      return value.map((v) => redactField(key, v, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactField(k, v, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  if (isDiagnosticModeActive()) {
    // In diagnostic mode (authorized, expiring), allow raw but still redact secrets
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(attrs)) {
      const lower = k.toLowerCase();
      if (
        lower.includes('credential') ||
        lower.includes('secret') ||
        lower.includes('capability_token') ||
        lower.includes('api_key') ||
        lower.includes('authorization')
      ) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = redactField(k, v);
  }
  return out;
}

export function redactLogRecord(record: Record<string, unknown>): Record<string, unknown> {
  // Store hashes/sizes/classifications/artifact IDs, not raw
  const redacted = redactAttributes(record);
  // Add size diagnostics instead of raw
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'string' && v.length > 0) {
      const sizeKey = `${k}_byte_length`;
      if (!(sizeKey in redacted)) redacted[sizeKey] = new TextEncoder().encode(v).byteLength;
    }
  }
  return redacted;
}

export function assertNoSensitiveInString(str: string): void {
  const lower = str.toLowerCase();
  for (const f of REDACTED_FIELDS) {
    if (lower.includes(f) && str.includes('[REDACTED]') === false) {
      // heuristic: if raw field name appears without redaction marker, fail
      // For tests, we check that logs do not contain raw credential patterns
      if (f === 'credential' || f === 'api_key' || f === 'capability_token' || f === 'secret') {
        if (/sk-[a-z0-9]{10,}/i.test(str) || /Bearer\s+[a-z0-9._-]{10,}/i.test(str)) {
          throw new Error(`sensitive content leaked in log/trace: ${f}`);
        }
      }
    }
  }
}
