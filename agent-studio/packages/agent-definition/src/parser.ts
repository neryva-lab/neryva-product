/**
 * parser.ts — parse raw JSON into validated AgentDefinitionV1
 * Source: agent_studio_implementation_plan.md:692-724
 */

import { AgentDefinitionV1Schema, type AgentDefinitionV1 } from './schema.js';
import { parseSchemaVersion } from './versions.js';
import { StudioError } from '@neryva/agent-kernel';

export type ParseResult =
  { ok: true; value: AgentDefinitionV1 } | { ok: false; error: StudioError };

export function parseAgentDefinition(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return {
      ok: false,
      error: new StudioError({
        code: 'DEFINITION_INVALID',
        message: 'definition must be an object',
        retryable: 'non-retryable',
      }),
    };
  }

  const obj = raw as Record<string, unknown>;
  // Early schema_version check for better error
  try {
    parseSchemaVersion(obj['schema_version']);
  } catch (err) {
    return {
      ok: false,
      error: new StudioError({
        code: 'DEFINITION_INVALID',
        message: (err as Error).message,
        retryable: 'non-retryable',
      }),
    };
  }

  const res = AgentDefinitionV1Schema.safeParse(raw);
  if (!res.success) {
    const details = res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return {
      ok: false,
      error: new StudioError({
        code: 'DEFINITION_INVALID',
        message: `schema validation failed: ${details}`,
        retryable: 'non-retryable',
        details: { issues: res.error.issues },
      }),
    };
  }

  return { ok: true, value: res.data };
}

export function mustParseAgentDefinition(raw: unknown): AgentDefinitionV1 {
  const res = parseAgentDefinition(raw);
  if (!res.ok) throw res.error;
  return res.value;
}
