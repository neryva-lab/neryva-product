import { describe, it, expect } from 'vitest';
import {
  validateArtifactRef,
  type StudioArtifactRef,
  ALLOWED_PURPOSES,
  createArtifactId,
} from '../src/references.js';
import { computeSha256 } from '../src/checksums.js';
import { createInMemoryArtifactStore, ArtifactReader } from '../src/reader.js';
import { writeArtifact } from '../src/writer.js';

function makeRef(overrides: Partial<StudioArtifactRef> = {}): StudioArtifactRef {
  const content = new TextEncoder().encode('test content');
  const sha = computeSha256(content);
  return {
    artifactId: overrides.artifactId ?? `art_test_${Date.now()}`,
    organizationId: overrides.organizationId ?? 'org_123',
    runId: overrides.runId ?? 'run_abc',
    purpose: (overrides.purpose as StudioArtifactRef['purpose']) ?? 'TOOL_RESULT',
    mediaType: overrides.mediaType ?? 'text/plain',
    byteLength: overrides.byteLength ?? content.byteLength,
    sha256: overrides.sha256 ?? sha,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
    encryptionKeyId: overrides.encryptionKeyId ?? 'kms-default',
    uri: overrides.uri,
  };
}

describe('artifacts authorization (1485 substitution + cross-tenant; 1486 stale; 341-352)', () => {
  it('validateArtifactRef rejects missing artifactId', () => {
    const r = makeRef({ artifactId: '' as unknown as string });
    expect(() => validateArtifactRef(r)).toThrow(/artifactId required/);
  });
  it('purpose must be allowlisted enum', () => {
    const r = makeRef({ purpose: 'EVIL_PURPOSE' as unknown as StudioArtifactRef['purpose'] });
    expect(() => validateArtifactRef(r)).toThrow(/not allowlisted/);
    // each allowed purpose passes
    for (const p of ALLOWED_PURPOSES) {
      const ok = makeRef({ purpose: p as StudioArtifactRef['purpose'] });
      expect(() => validateArtifactRef(ok)).not.toThrow();
    }
  });
  it('sha256 must be 32B at boundary', () => {
    const r = makeRef({ sha256: new Uint8Array(16) });
    expect(() => validateArtifactRef(r)).toThrow(/32B/);
  });
  it('expiresAt must be in future', () => {
    const r = makeRef({ expiresAt: new Date(Date.now() - 1000) });
    expect(() => validateArtifactRef(r)).toThrow(/expired/);
  });
  it('reader re-authorizes fresh — cross-tenant denied', async () => {
    const ref = makeRef({ organizationId: 'org_123', runId: 'run_abc' });
    const store = createInMemoryArtifactStore();
    const content = new TextEncoder().encode('test content');
    store.put(ref, content);
    const reader = new ArtifactReader(store);
    await expect(reader.read(ref, { expectedOrganizationId: 'org_other' })).rejects.toThrow(
      /cross-tenant/,
    );
    await expect(
      reader.read(ref, { expectedOrganizationId: 'org_123', expectedRunId: 'run_other' }),
    ).rejects.toThrow(/wrong run/);
  });
  it('purpose-bound: mismatched purpose denied', async () => {
    const ref = makeRef({ purpose: 'TOOL_RESULT' });
    const store = createInMemoryArtifactStore();
    store.put(ref, new TextEncoder().encode('test content'));
    const reader = new ArtifactReader(store);
    await expect(
      reader.read(ref, { expectedOrganizationId: 'org_123', expectedPurpose: 'CHECKPOINT' }),
    ).rejects.toThrow(/purpose mismatch/);
  });
  it('checksum-verified: sha256 tamper detected', async () => {
    const content = new TextEncoder().encode('real content');
    const ref = makeRef({ byteLength: content.byteLength, sha256: computeSha256(content) });
    const store = createInMemoryArtifactStore();
    // Store with same artifactId but different sha (tamper at creation)
    const tamperedSha = computeSha256(new TextEncoder().encode('tampered'));
    const tamperedRef = makeRef({
      artifactId: ref.artifactId,
      byteLength: content.byteLength,
      sha256: tamperedSha,
    });
    store.put(tamperedRef, content);
    const reader = new ArtifactReader(store);
    await expect(reader.read(ref, { expectedOrganizationId: 'org_123' })).rejects.toThrow(
      /tamper|mismatch/,
    );
  });
  it('expiring: expired ref rejected via validate and read', async () => {
    const past = new Date(Date.now() - 10_000);
    const content = new TextEncoder().encode('test content');
    // Create valid expiry then mutate to past to bypass validate at creation
    const ref = makeRef({ expiresAt: new Date(Date.now() + 60000) });
    const store = createInMemoryArtifactStore();
    store.put(ref, content);
    const expiredRef = { ...ref, expiresAt: past };
    const reader = new ArtifactReader(store);
    expect(() => validateArtifactRef(expiredRef)).toThrow(/expired/);
    await expect(reader.read(expiredRef, { expectedOrganizationId: 'org_123' })).rejects.toThrow(
      /expired|stale/,
    );
  });
  it('ref is not bearer: re-auth on every read — store deletion makes old ref unusable (1486)', async () => {
    const content = new TextEncoder().encode('to be deleted');
    const ref = makeRef({ byteLength: content.byteLength, sha256: computeSha256(content) });
    const store = createInMemoryArtifactStore();
    store.put(ref, content);
    const reader = new ArtifactReader(store);
    expect(await reader.read(ref, { expectedOrganizationId: 'org_123' })).toEqual(content);
    store.delete(ref.artifactId);
    await expect(reader.read(ref, { expectedOrganizationId: 'org_123' })).rejects.toThrow(
      /deleted/,
    );
  });
  it('quarantined artifact unusable (1486)', async () => {
    const content = new TextEncoder().encode('quarantined');
    const ref = makeRef({ byteLength: content.byteLength, sha256: computeSha256(content) });
    const store = createInMemoryArtifactStore();
    store.put(ref, content);
    const reader = new ArtifactReader(store);
    store.quarantine(ref.artifactId);
    await expect(reader.read(ref, { expectedOrganizationId: 'org_123' })).rejects.toThrow(
      /quarantined/,
    );
  });
  it('artifact substitution (other org artifact unreadable) 1485', async () => {
    const orgAContent = new TextEncoder().encode('orgA secret');
    const orgARef = await writeArtifact(orgAContent, {
      organizationId: 'org_A',
      runId: 'run_A',
      purpose: 'TOOL_RESULT',
      mediaType: 'text/plain',
    });
    const orgBContent = new TextEncoder().encode('orgB secret');
    const orgBRef = await writeArtifact(orgBContent, {
      organizationId: 'org_B',
      runId: 'run_B',
      purpose: 'TOOL_RESULT',
      mediaType: 'text/plain',
    });
    // Simulate store with both
    const store = createInMemoryArtifactStore();
    store.put(orgARef, orgAContent);
    store.put(orgBRef, orgBContent);
    const reader = new ArtifactReader(store);
    // Org A cannot read Org B artifact
    await expect(reader.read(orgBRef, { expectedOrganizationId: 'org_A' })).rejects.toThrow(
      /cross-tenant/,
    );
    // Tampered organizationId in ref object
    const tampered = { ...orgARef, organizationId: 'org_B' } as StudioArtifactRef;
    await expect(reader.read(tampered, { expectedOrganizationId: 'org_B' })).rejects.toThrow(
      /tamper|denied/,
    );
  });
  it('writer enforces size-policy and creates valid ref', async () => {
    const big = new Uint8Array(11 * 1024 * 1024); // 11 MiB > 10 MiB
    await expect(
      writeArtifact(big, {
        organizationId: 'org_123',
        runId: 'run_123',
        purpose: 'TOOL_RESULT',
        mediaType: 'application/octet-stream',
      }),
    ).rejects.toThrow(/exceeds maxArtifactBytes/);
    const ok = new TextEncoder().encode('small');
    const ref = await writeArtifact(ok, {
      organizationId: 'org_123',
      runId: 'run_123',
      purpose: 'TOOL_RESULT',
      mediaType: 'text/plain',
    });
    expect(ref.byteLength).toBe(ok.byteLength);
    expect(ref.sha256.length).toBe(32);
    expect(() => validateArtifactRef(ref)).not.toThrow();
  });
  it('createArtifactId is unique per run', () => {
    const a = createArtifactId('run_abc');
    const b = createArtifactId('run_abc');
    expect(a).not.toBe(b);
    expect(a.startsWith('art_')).toBe(true);
  });
});
