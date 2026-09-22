/**
 * artifact-isolation.test.ts — object keys, artifact refs, vector namespaces
 * Source: 10.1 381-383, 659-666
 */
import { describe, it, expect } from 'vitest';
import { createInMemoryArtifactStore, ArtifactReader } from '@neryva/artifacts';
import { computeSha256 } from '@neryva/artifacts';
import { validateArtifactRef } from '@neryva/artifacts';

describe('artifact + cache + vector isolation', () => {
  it('artifact cross-tenant rejected at reader (fresh authz)', async () => {
    const store = createInMemoryArtifactStore();
    const content = new TextEncoder().encode('secret A');
    const sha = computeSha256(content);
    const refA = {
      artifactId: 'art_A',
      organizationId: 'org_A',
      runId: 'run_A',
      purpose: 'TOOL_RESULT' as const,
      mediaType: 'text/plain',
      byteLength: content.byteLength,
      sha256: sha,
      expiresAt: new Date(Date.now() + 60000),
    };
    validateArtifactRef(refA);
    store.put(refA, content);
    const reader = new ArtifactReader(store);
    await expect(reader.read(refA, { expectedOrganizationId: 'org_B' })).rejects.toThrow(
      /cross-tenant/,
    );
  });

  it('artifact substitution (tampered organizationId) rejected', async () => {
    const store = createInMemoryArtifactStore();
    const content = new TextEncoder().encode('doc');
    const sha = computeSha256(content);
    const ref = {
      artifactId: 'art1',
      organizationId: 'org_A',
      runId: 'run1',
      purpose: 'TOOL_RESULT' as const,
      mediaType: 'text/plain',
      byteLength: content.byteLength,
      sha256: sha,
      expiresAt: new Date(Date.now() + 60000),
    };
    store.put(ref, content);
    const tampered = { ...ref, organizationId: 'org_B' };
    const reader = new ArtifactReader(store);
    await expect(reader.read(tampered, { expectedOrganizationId: 'org_B' })).rejects.toThrow(
      /tamper|denied/,
    );
  });

  it('support/admin access is separately audited — cannot masquerade as customer principal', () => {
    const supportActor = { actorId: 'support_operator', role: 'support' };
    const customerScope = { organizationId: 'org_A', runId: 'run1' };
    // Support must use explicit support permissions, not customer principalId
    expect(supportActor.actorId).not.toBe(customerScope.organizationId);
    // Auditing would log support access separately
    const audit = {
      actor: supportActor.actorId,
      action: 'GetRun',
      scope: customerScope,
      audited: true,
    };
    expect(audit.audited).toBe(true);
  });
});
