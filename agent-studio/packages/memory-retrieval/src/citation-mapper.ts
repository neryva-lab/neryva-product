/**
 * citation-mapper.ts — preserves source document/version/chunk provenance
 * Source: agent_studio_implementation_plan.md:1040 (citation-mapper preserves source document/version/chunk provenance),
 * 477 (citation tracking), 1042-1055 (each result: source_id/document_version_id/chunk_id, ... citation, policy version)
 * Maps Engine retrieval results to citations with stable hashes; never exposes raw full doc in citation.
 */
import { computeSha256, toHex } from '@neryva/artifacts';

export interface CitationInput {
  sourceId: string;
  documentVersionId?: string | undefined;
  chunkId?: string | undefined;
  organizationId: string;
  content?: string | undefined;
  artifactRef?: { artifactId: string; byteLength: number; sha256: Uint8Array } | undefined;
  citation: string;
  sourceRange?: { fromSequence: number; toSequence: number } | undefined;
  policyVersion: string;
}

export interface Citation {
  citationId: string; // stable hash of sourceId+documentVersionId+chunkId
  sourceId: string;
  documentVersionId?: string | undefined;
  chunkId?: string | undefined;
  organizationId: string;
  citation: string; // e.g., "doc:ver:chunk"
  sourceRange?: { fromSequence: number; toSequence: number } | undefined;
  policyVersion: string;
  contentHash?: string | undefined; // sha256 hex of content if inline
  artifactId?: string | undefined;
  byteLength?: number | undefined;
}

export function createCitationId(
  input: Pick<CitationInput, 'sourceId' | 'documentVersionId' | 'chunkId'>,
): string {
  const raw = `${input.sourceId}:${input.documentVersionId ?? ''}:${input.chunkId ?? ''}`;
  const hash = computeSha256(new TextEncoder().encode(raw));
  return toHex(hash).slice(0, 16);
}

export function mapToCitation(input: CitationInput): Citation {
  if (!input.sourceId) throw new Error('citation sourceId required — fail closed 1055');
  if (!input.organizationId) throw new Error('citation organizationId required — fail closed');
  if (!input.citation) throw new Error('citation text required — fail closed');
  if (!input.policyVersion) throw new Error('policyVersion required');
  const citationId = createCitationId(input);
  let contentHash: string | undefined;
  if (input.content) {
    contentHash = toHex(computeSha256(new TextEncoder().encode(input.content)));
  } else if (input.artifactRef) {
    contentHash = toHex(input.artifactRef.sha256);
  }
  return {
    citationId,
    sourceId: input.sourceId,
    documentVersionId: input.documentVersionId,
    chunkId: input.chunkId,
    organizationId: input.organizationId,
    citation: input.citation,
    sourceRange: input.sourceRange,
    policyVersion: input.policyVersion,
    contentHash,
    artifactId: input.artifactRef?.artifactId,
    byteLength:
      input.artifactRef?.byteLength ??
      (input.content ? new TextEncoder().encode(input.content).byteLength : undefined),
  };
}

export function mapBatchToCitations(inputs: CitationInput[]): Citation[] {
  const mapped = inputs.map(mapToCitation);
  // Deterministic ordering: citationId
  mapped.sort((a, b) => a.citationId.localeCompare(b.citationId));
  return mapped;
}

export function toCitationDiagnostics(citations: Citation[]): {
  count: number;
  citationIds: string[];
  policyVersions: string[];
} {
  return {
    count: citations.length,
    citationIds: citations.map((c) => c.citationId),
    policyVersions: [...new Set(citations.map((c) => c.policyVersion))],
  };
}
