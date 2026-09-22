/**
 * scope.ts — tenant scope validation, no widening
 * Source: agent_studio_implementation_plan.md:1164-1192, 662, main.md:308-310
 * Every operation must verify organization_id, conversation_id, run_id, agent_version_id match Engine-granted scope.
 */

import { StudioError } from '@neryva/agent-kernel';

export interface Scope {
  organizationId: string;
  conversationId: string;
  runId: string;
  agentVersionId: string;
  actorId: string;
}

export function assertScopeImmutability(granted: Scope, requested: Partial<Scope>): void {
  const fields: (keyof Scope)[] = ['organizationId', 'conversationId', 'runId', 'agentVersionId'];
  for (const field of fields) {
    const requestedValue = requested[field];
    if (requestedValue !== undefined && requestedValue !== granted[field]) {
      throw new StudioError({
        code: 'SCOPE_MISMATCH',
        message: `scope mismatch: ${field} expected ${granted[field]}, got ${requestedValue}`,
        retryable: 'non-retryable',
        details: { field, expected: granted[field], got: requestedValue },
      });
    }
  }
}

export function validateScopeFields(
  scope: Partial<Scope>,
): { ok: true } | { ok: false; field: keyof Scope } {
  const required: (keyof Scope)[] = ['organizationId', 'conversationId', 'runId', 'agentVersionId'];
  for (const f of required) {
    if (!scope[f] || typeof scope[f] !== 'string' || (scope[f] as string).trim().length === 0) {
      return { ok: false, field: f };
    }
  }
  return { ok: true };
}
