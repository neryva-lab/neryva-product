/**
 * result-limits.ts — bounded result enforcement, max inline vs artifact
 * Source: agent_studio_implementation_plan.md:1034-1055 (bounded content or ArtifactRef), 341-352 (size limits), 589-594 (max inline/artifact bytes),
 * 1478 (long tool results/transcripts via ArtifactRef)
 */
import {
  createSizePolicy,
  shouldClaimCheck,
  type SizePolicy,
  type StudioArtifactRef,
} from '@neryva/artifacts';

export interface BoundedResult<T> {
  value: T;
  asArtifact?: StudioArtifactRef | undefined;
  wasTruncated: boolean;
  byteLength: number;
}

export interface ResultLimitsOptions {
  maxResults: number; // 1..20 per proto
  maxInlineBytes: number;
  maxArtifactBytes: number;
  sizePolicy?: SizePolicy;
}

export function createResultLimits(overrides?: Partial<ResultLimitsOptions>): ResultLimitsOptions {
  const spOverrides: Partial<SizePolicy> = {};
  if (overrides?.maxInlineBytes !== undefined)
    spOverrides.maxInlineBytes = overrides.maxInlineBytes;
  if (overrides?.maxArtifactBytes !== undefined)
    spOverrides.maxArtifactBytes = overrides.maxArtifactBytes;
  const policy = createSizePolicy(Object.keys(spOverrides).length > 0 ? spOverrides : undefined);
  return {
    maxResults: overrides?.maxResults ?? 20,
    maxInlineBytes: overrides?.maxInlineBytes ?? policy.maxInlineBytes,
    maxArtifactBytes: overrides?.maxArtifactBytes ?? policy.maxArtifactBytes,
    sizePolicy: policy,
  };
}

export function enforceResultCount<T>(
  results: T[],
  limits: ResultLimitsOptions,
): { kept: T[]; omitted: T[] } {
  if (results.length <= limits.maxResults) return { kept: results, omitted: [] };
  return { kept: results.slice(0, limits.maxResults), omitted: results.slice(limits.maxResults) };
}

export function shouldUseArtifactForContent(
  content: string,
  classification: string,
  limits: ResultLimitsOptions,
): boolean {
  const byteLength = new TextEncoder().encode(content).byteLength;
  const policy =
    limits.sizePolicy ??
    createSizePolicy({
      maxInlineBytes: limits.maxInlineBytes,
      maxArtifactBytes: limits.maxArtifactBytes,
    });
  return shouldClaimCheck(byteLength, classification, policy);
}

export function validateResultByteLength(byteLength: number, limits: ResultLimitsOptions): void {
  if (byteLength > limits.maxArtifactBytes)
    throw new Error(
      `result byteLength ${byteLength} exceeds maxArtifactBytes ${limits.maxArtifactBytes}`,
    );
}
