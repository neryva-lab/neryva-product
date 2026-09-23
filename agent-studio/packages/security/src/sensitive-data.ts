/**
 * sensitive-data.ts — redaction and sensitive data handling
 * Source: agent_studio_implementation_plan.md:1153-1161, 491-503
 * Default: no raw prompts, full docs, tool args, credentials in logs.
 */

export const SENSITIVE_FIELDS = new Set<string>([
  'prompt',
  'instructions',
  'tool_args',
  'tool_result',
  'document',
  'credential',
  'api_key',
  'secret',
  'authorization',
  'capability_token',
  'token',
]);

/**
 * Field-name matching is case- and separator-insensitive: `apiKey`,
 * `api-key`, `API_KEY`, and `api_key` all denote the same secret carrier.
 * Wave-3 evidence flagged that `redactObject` missed camelCase `apiKey`;
 * normalizing closes the whole class rather than adding one-off entries.
 */
const normalizeField = (field: string): string => field.toLowerCase().replace(/[^a-z0-9]/g, '');

const NORMALIZED_SENSITIVE_FIELDS = new Set<string>(
  [...SENSITIVE_FIELDS].map(normalizeField),
);

export function isSensitiveField(field: string): boolean {
  return NORMALIZED_SENSITIVE_FIELDS.has(normalizeField(field));
}

export function redactValue(field: string, value: unknown, depth = 0): unknown {
  if (isSensitiveField(field)) return '[REDACTED]';
  if (typeof value === 'string' && value.length > 1000) return `[TRUNCATED ${value.length}B]`;
  if (depth < 4 && typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      return value.map((v) => redactValue(field, v, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = redactValue(k, v);
  }
  return out;
}

/** Credential-shaped patterns: provider keys, AWS keys, GitHub tokens, JWTs, Bearer headers. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI-style keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access keys
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub PATs
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i, // Bearer headers
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWTs
];

export function assertNoSensitiveInLog(message: string): void {
  const lower = message.toLowerCase();
  for (const field of SENSITIVE_FIELDS) {
    if (lower.includes(field) && lower.includes('sk-')) {
      throw new Error(`potential secret leakage in log: ${field}`);
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(message)) {
      throw new Error('potential credential-shaped secret leaked in log');
    }
  }
}
