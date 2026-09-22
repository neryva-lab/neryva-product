/**
 * citations.ts — citation tracking (source IDs/versions, hashes/sizes, not raw text)
 * Source: agent_studio_architecture.md:477, agent_studio_implementation_plan.md:1042-1055, 963
 * Record source IDs/versions not just prompt; diagnostics use hashes/sizes to avoid leaking content.
 */

import { createHash } from 'node:crypto';

export interface Citation {
  sourceId: string;
  documentVersionId?: string | undefined;
  chunkId?: string | undefined;
  version?: number | undefined;
  purpose?: string | undefined;
  // For diagnostics: hash and size, not raw text
  contentHash: string; // sha256 hex 64
  byteLength: number;
  citation: string; // human-readable, e.g., "support-docs#v3#chunk_123"
}

export interface CitationMap {
  citations: Citation[];
  // Map from compiled message index to citation indices
  messageCitations: Map<number, number[]>;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function createCitation(params: {
  sourceId: string;
  documentVersionId?: string | undefined;
  chunkId?: string | undefined;
  version?: number | undefined;
  purpose?: string | undefined;
  content: string;
  citation: string;
}): Citation {
  const hash = hashContent(params.content);
  const byteLength = Buffer.byteLength(params.content, 'utf8');
  return {
    sourceId: params.sourceId,
    documentVersionId: params.documentVersionId,
    chunkId: params.chunkId,
    version: params.version,
    purpose: params.purpose,
    contentHash: hash,
    byteLength,
    citation: params.citation,
  };
}

export function createCitationMap(): CitationMap {
  return { citations: [], messageCitations: new Map() };
}

export function addCitation(
  map: CitationMap,
  citation: Citation,
  messageIndex?: number | undefined,
): number {
  const idx = map.citations.length;
  map.citations.push(citation);
  if (messageIndex !== undefined) {
    const existing = map.messageCitations.get(messageIndex) ?? [];
    existing.push(idx);
    map.messageCitations.set(messageIndex, existing);
  }
  return idx;
}

export function toDiagnostics(map: CitationMap): Array<{
  sourceId: string;
  version?: number | undefined;
  hash: string;
  bytes: number;
  citation: string;
}> {
  return map.citations.map((c) => ({
    sourceId: c.sourceId,
    version: c.version,
    hash: c.contentHash.slice(0, 12),
    bytes: c.byteLength,
    citation: c.citation,
  }));
}
