import { describe, it, expect } from 'vitest';
import {
  createResultLimits,
  enforceResultCount,
  shouldUseArtifactForContent,
} from '../src/result-limits.js';
import { createKnowledgeClient } from '../src/knowledge-client.js';
import type { RetrievalCandidate } from '../src/retrieval-policy.js';

function makeCand(id: string, contentLen = 10): RetrievalCandidate {
  return {
    sourceId: id,
    documentVersionId: 'v1',
    chunkId: 'c1',
    organizationId: 'org_123',
    status: 'READY',
    citation: `c#${id}`,
    policyVersion: 'v1',
    content: 'x'.repeat(contentLen),
  };
}

describe('result-limits (bounded content or ArtifactRef; 1478 long results via ArtifactRef)', () => {
  it('enforceResultCount caps at maxResults 20 and returns omitted', () => {
    const limits = createResultLimits({ maxResults: 3 });
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => makeCand(id));
    const { kept, omitted } = enforceResultCount(many, limits);
    expect(kept.length).toBe(3);
    expect(omitted.length).toBe(2);
    expect(omitted.map((c) => c.sourceId)).toEqual(['d', 'e']);
  });
  it('shouldUseArtifactForContent true when > maxInlineBytes', () => {
    const limits = createResultLimits({ maxInlineBytes: 8192 });
    expect(shouldUseArtifactForContent('x'.repeat(8193), 'standard', limits)).toBe(true);
    expect(shouldUseArtifactForContent('x'.repeat(8192), 'standard', limits)).toBe(false);
    expect(shouldUseArtifactForContent('x'.repeat(10), 'SENSITIVE', limits)).toBe(true);
  });
  it('knowledge maxResults validated 1..20 via planner (1042)', () => {
    const fake = {
      getAuthorizedRunContext: async () => ({ knowledge_refs: [] }),
    } as unknown as import('@neryva/neryva-mcp-client').NeryvaMcpClient;
    const kc = createKnowledgeClient(fake);
    expect(() =>
      kc.planAndLimit(
        {
          organizationId: 'org_123',
          runId: 'run_1',
          text: 'q',
          maxResults: 0,
          engineCaps: { supportsHybrid: true, supportsVector: true, supportsKeyword: true },
        },
        {},
      ),
    ).toThrow(/maxResults must be 1\.\.20/);
    expect(() =>
      kc.planAndLimit(
        {
          organizationId: 'org_123',
          runId: 'run_1',
          text: 'q',
          maxResults: 21,
          engineCaps: { supportsHybrid: true, supportsVector: true, supportsKeyword: true },
        },
        {},
      ),
    ).toThrow();
  });
  it('createResultLimits uses artifact size-policy defaults', () => {
    const lim = createResultLimits({});
    expect(lim.maxInlineBytes).toBe(8192);
    expect(lim.maxArtifactBytes).toBe(10_485_760);
  });
  it('long tool transcript via artifact — 50000 bytes should be artifact not inline (7.7)', async () => {
    const limits = createResultLimits({ maxInlineBytes: 8192, maxResults: 20 });
    const longContent = 'long transcript '.repeat(4000); // >8192
    expect(shouldUseArtifactForContent(longContent, 'standard', limits)).toBe(true);
    // In activities, writer would have produced artifact ref; here we assert policy
  });
  it('citation preserved after limit — omitted still has provenance', () => {
    const limits = createResultLimits({ maxResults: 2 });
    const many = ['doc1', 'doc2', 'doc3'].map((id) => makeCand(id, 5));
    const { kept, omitted } = enforceResultCount(many, limits);
    expect(kept[0].citation).toBe('c#doc1');
    expect(omitted[0].citation).toBe('c#doc3');
    // Omitted diagnostics should carry citation ids
    expect(omitted.length).toBe(1);
  });
});
