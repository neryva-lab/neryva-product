/**
 * capabilities.ts — capability token per operation enforcement
 * Source: agent_studio_implementation_plan.md:1177-1192, neryva_mcp_implementation_plan.md:682-693
 * For every operation, verify: signature/key version, expiry, not-before, org/conv/run/agent version, actor, allowed method/capability set, replay protection.
 */

import { StudioError } from '@neryva/agent-kernel';

export interface Capability {
  signatureVersion: string; // kid / key version
  notBefore?: number; // epoch ms
  expiresAt: number; // epoch ms
  organizationId: string;
  conversationId: string;
  runId: string;
  agentVersionId: string;
  actorId: string;
  allowedMethods: string[]; // e.g., ['GetAuthorizedRunContext', 'AppendRunEvents']
  capabilityId: string; // nonce / jti
  replaySeen?: Set<string>; // for replay protection (in-memory for tests)
}

export function isCapabilityExpired(cap: Capability, now: number = Date.now()): boolean {
  if (now >= cap.expiresAt) return true;
  if (cap.notBefore !== undefined && now < cap.notBefore) return true;
  return false;
}

export function assertCapabilityForMethod(
  cap: Capability,
  method: string,
  now: number = Date.now(),
): void {
  if (isCapabilityExpired(cap, now)) {
    throw new StudioError({
      code: 'CAPABILITY_DENIED',
      message: `capability expired: ${cap.capabilityId}`,
      retryable: 'non-retryable',
      details: { capabilityId: cap.capabilityId, method },
    });
  }
  if (!cap.allowedMethods.includes(method) && !cap.allowedMethods.includes('*')) {
    throw new StudioError({
      code: 'CAPABILITY_DENIED',
      message: `capability ${cap.capabilityId} not allowed for ${method}`,
      retryable: 'non-retryable',
      details: { capabilityId: cap.capabilityId, method, allowed: cap.allowedMethods },
    });
  }
}

export function assertCapabilityScope(
  cap: Capability,
  scope: { organizationId: string; conversationId: string; runId: string; agentVersionId: string },
): void {
  if (cap.organizationId !== scope.organizationId) {
    throw new StudioError({
      code: 'SCOPE_MISMATCH',
      message: 'capability org mismatch',
      retryable: 'non-retryable',
    });
  }
  if (cap.conversationId !== scope.conversationId) {
    throw new StudioError({
      code: 'SCOPE_MISMATCH',
      message: 'capability conversation mismatch',
      retryable: 'non-retryable',
    });
  }
  if (cap.runId !== scope.runId) {
    throw new StudioError({
      code: 'SCOPE_MISMATCH',
      message: 'capability run mismatch',
      retryable: 'non-retryable',
    });
  }
  if (cap.agentVersionId !== scope.agentVersionId) {
    throw new StudioError({
      code: 'SCOPE_MISMATCH',
      message: 'capability agent version mismatch',
      retryable: 'non-retryable',
    });
  }
}

export function checkReplay(cap: Capability, nonce: string): void {
  const seen = cap.replaySeen ?? new Set<string>();
  if (seen.has(nonce)) {
    throw new StudioError({
      code: 'CAPABILITY_DENIED',
      message: `replay detected for capability ${cap.capabilityId} nonce ${nonce}`,
      retryable: 'non-retryable',
    });
  }
  seen.add(nonce);
  cap.replaySeen = seen;
}
