/**
 * capability.ts — run-scoped capability token handling for Studio
 * Source: agent_studio_implementation_plan.md:356-364, 1177-1192, neryva_mcp_implementation_plan.md:682-693
 * Capability is short-lived, audience-bound, scope-bound, replay-resistant.
 */

import { StudioError } from '@neryva/agent-kernel';

export interface CapabilityToken {
  capabilityId: string;
  organizationId: string;
  conversationId: string;
  runId: string;
  agentVersionId: string;
  actorId: string;
  allowedMethods: string[];
  issuedAt: number;
  expiresAt: number;
  notBefore?: number;
  keyId: string;
  leaseEpoch?: number;
}

export function isExpired(token: CapabilityToken, now: number = Date.now()): boolean {
  if (now >= token.expiresAt) return true;
  if (token.notBefore !== undefined && now < token.notBefore) return true;
  return false;
}

export function assertNotExpired(token: CapabilityToken, now: number = Date.now()): void {
  if (isExpired(token, now)) {
    throw new StudioError({
      code: 'CAPABILITY_DENIED',
      message: `capability ${token.capabilityId} expired`,
      retryable: 'non-retryable',
      details: { capabilityId: token.capabilityId },
    });
  }
}

export function assertAllowedMethod(token: CapabilityToken, method: string): void {
  if (!token.allowedMethods.includes(method) && !token.allowedMethods.includes('*')) {
    throw new StudioError({
      code: 'CAPABILITY_DENIED',
      message: `capability ${token.capabilityId} not allowed for ${method}`,
      retryable: 'non-retryable',
      details: { capabilityId: token.capabilityId, method },
    });
  }
}

export function assertScopeMatches(
  token: CapabilityToken,
  scope: { organizationId: string; conversationId: string; runId: string; agentVersionId: string },
): void {
  if (token.organizationId !== scope.organizationId) {
    throw new StudioError({
      code: 'SCOPE_MISMATCH',
      message: 'capability org mismatch',
      retryable: 'non-retryable',
    });
  }
  if (token.conversationId !== scope.conversationId) {
    throw new StudioError({
      code: 'SCOPE_MISMATCH',
      message: 'capability conversation mismatch',
      retryable: 'non-retryable',
    });
  }
  if (token.runId !== scope.runId) {
    throw new StudioError({
      code: 'SCOPE_MISMATCH',
      message: 'capability run mismatch',
      retryable: 'non-retryable',
    });
  }
  if (token.agentVersionId !== scope.agentVersionId) {
    throw new StudioError({
      code: 'SCOPE_MISMATCH',
      message: 'capability agent version mismatch',
      retryable: 'non-retryable',
    });
  }
}
