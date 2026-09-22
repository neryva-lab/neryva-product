/**
 * credentials.ts — scoped credential resolution (never ambient, never in logs)
 * Source: agent_studio_architecture.md:483-511 (7 execute with scoped credential), 507-510
 * Credentials are resolved via secret-provider at execution time, never stored in workflow history or definitions.
 */

import type { SecretProvider, SecretRef } from '@neryva/security';

export interface ScopedCredential {
  toolId: string;
  organizationId: string;
  runId: string;
  // Resolved value is only available inside Activity, never logged
  value: string;
  resolvedAt: string;
  expiresAt?: string | undefined;
}

export async function resolveCredential(params: {
  toolId: string;
  organizationId: string;
  runId: string;
  credentialRef?: string | undefined;
  secretProvider: SecretProvider;
}): Promise<ScopedCredential | undefined> {
  if (!params.credentialRef) return undefined;
  const ref: SecretRef = { ref: params.credentialRef };
  const value = await params.secretProvider.resolve(ref);
  // Never log value
  return {
    toolId: params.toolId,
    organizationId: params.organizationId,
    runId: params.runId,
    value,
    resolvedAt: new Date().toISOString(),
  };
}

export function isCredentialExpired(cred: ScopedCredential, now: Date = new Date()): boolean {
  if (!cred.expiresAt) return false;
  return new Date(cred.expiresAt) <= now;
}
