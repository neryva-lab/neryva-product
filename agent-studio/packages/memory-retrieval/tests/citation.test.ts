import { describe, it, expect } from 'vitest';
import { mapToCitation, mapBatchToCitations, createCitationId } from '../src/citation-mapper.js';
import { computeSha256, toHex } from '@neryva/artifacts';

describe('citation-mapper (1042-1055 per result provenance; 477 citation tracking)', () => {
  it('createCitationId deterministic stable hash of sourceId:documentVersionId:chunkId', () => {
    const id1 = createCitationId({ sourceId: 'doc1', documentVersionId: 'v2', chunkId: 'c3' });
    const id2 = createCitationId({ sourceId: 'doc1', documentVersionId: 'v2', chunkId: 'c3' });
    expect(id1).toBe(id2);
    expect(id1.length).toBe(16);
    const diff = createCitationId({ sourceId: 'doc1', documentVersionId: 'v2', chunkId: 'c4' });
    expect(diff).not.toBe(id1);
  });
  it('mapToCitation requires sourceId, organizationId, citation, policyVersion — fail closed 1055', () => {
    expect(() =>
      mapToCitation({
        sourceId: '',
        organizationId: 'org_123',
        citation: 'c',
        policyVersion: 'v1',
        content: 'x',
      } as unknown as Parameters<typeof mapToCitation>[0]),
    ).toThrow(/sourceId required/);
    expect(() =>
      mapToCitation({
        sourceId: 's1',
        organizationId: '',
        citation: 'c',
        policyVersion: 'v1',
      } as unknown as Parameters<typeof mapToCitation>[0]),
    ).toThrow();
    expect(() =>
      mapToCitation({
        sourceId: 's1',
        organizationId: 'org_123',
        citation: '',
        policyVersion: 'v1',
      } as unknown as Parameters<typeof mapToCitation>[0]),
    ).toThrow(/citation text required/);
  });
  it('contentHash is sha256 hex of inline content; artifactHash if artifactRef', () => {
    const content = 'hello knowledge chunk';
    const c = mapToCitation({
      sourceId: 'doc1',
      organizationId: 'org_123',
      citation: 'doc1#1',
      policyVersion: 'v1',
      content,
    });
    const expected = toHex(computeSha256(new TextEncoder().encode(content)));
    expect(c.contentHash).toBe(expected);
    const artSha = computeSha256(new TextEncoder().encode('artifact content'));
    const c2 = mapToCitation({
      sourceId: 'doc2',
      organizationId: 'org_123',
      citation: 'doc2#1',
      policyVersion: 'v1',
      artifactRef: { artifactId: 'art_1', byteLength: 10, sha256: artSha },
    });
    expect(c2.contentHash).toBe(toHex(artSha));
    expect(c2.artifactId).toBe('art_1');
  });
  it('mapBatchToCitations deterministic ordering by citationId', () => {
    const inputs = [
      {
        sourceId: 'b',
        organizationId: 'org_123',
        citation: 'b',
        policyVersion: 'v1',
        content: 'x',
        documentVersionId: 'v1',
        chunkId: 'c1',
      },
      {
        sourceId: 'a',
        organizationId: 'org_123',
        citation: 'a',
        policyVersion: 'v1',
        content: 'y',
        documentVersionId: 'v1',
        chunkId: 'c2',
      },
    ];
    const batch = mapBatchToCitations(inputs);
    expect(batch[0].citationId.localeCompare(batch[1].citationId)).toBeLessThanOrEqual(0);
    // stable across reorder
    const reverse = mapBatchToCitations([...inputs].reverse());
    expect(reverse.map((c) => c.citationId)).toEqual(batch.map((c) => c.citationId));
  });
  it('per result contract: source_id/document_version_id/chunk_id, organization scope, citation, policy version', () => {
    const input = {
      sourceId: 'doc_123',
      documentVersionId: 'ver_456',
      chunkId: 'chunk_789',
      organizationId: 'org_123',
      citation: 'support-docs/doc123 ver456 chunk789',
      policyVersion: 'policy_v2',
      content: 'bounded content',
      sourceRange: { fromSequence: 1, toSequence: 5 },
    };
    const cit = mapToCitation(input);
    expect(cit.sourceId).toBe('doc_123');
    expect(cit.documentVersionId).toBe('ver_456');
    expect(cit.chunkId).toBe('chunk_789');
    expect(cit.organizationId).toBe('org_123');
    expect(cit.citation).toBe('support-docs/doc123 ver456 chunk789');
    expect(cit.policyVersion).toBe('policy_v2');
    expect(cit.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('artifact-backed long result carries artifactId/byteLength not raw content in citation', () => {
    const sha = computeSha256(new TextEncoder().encode('long transcript 50000 bytes '.repeat(100)));
    const cit = mapToCitation({
      sourceId: 'transcript_1',
      organizationId: 'org_123',
      citation: 'transcript run_abc',
      policyVersion: 'v1',
      artifactRef: { artifactId: 'art_transcript', byteLength: 50000, sha256: sha },
    });
    expect(cit.artifactId).toBe('art_transcript');
    expect(cit.byteLength).toBe(50000);
    expect(cit.contentHash).toBe(toHex(sha));
  });
});
