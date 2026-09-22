/**
 * size-policy.ts — bounded payload enforcement
 * Source: agent_studio_implementation_plan.md:589-594 (max inline bytes, max artifact bytes, allowed purposes),
 * 341-352 (reject oversized workflow args, sensitive-classification oversize), 839-848 (workflow payload protection),
 * 1484 (large data never enters workflow args)
 */

export const DEFAULT_MAX_INLINE_BYTES = 8192;
export const DEFAULT_MAX_ARTIFACT_BYTES = 10_485_760; // 10 MiB from config artifacts.maxArtifactBytes
export const ABSOLUTE_MAX_ARTIFACT_BYTES = 1_073_741_824; // proto 1GiB cap
export const SENSITIVE_CLASSIFICATIONS = new Set(['SENSITIVE', 'RESTRICTED', 'CONFIDENTIAL']);

export interface SizePolicy {
  maxInlineBytes: number;
  maxArtifactBytes: number;
}

export function createSizePolicy(overrides?: Partial<SizePolicy>): SizePolicy {
  return {
    maxInlineBytes: overrides?.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES,
    maxArtifactBytes: overrides?.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
  };
}

export function shouldClaimCheck(
  byteLength: number,
  classification: string,
  policy: SizePolicy = createSizePolicy(),
): boolean {
  if (SENSITIVE_CLASSIFICATIONS.has(classification)) return true;
  return byteLength > policy.maxInlineBytes;
}

export function validateInlineSize(
  byteLength: number,
  policy: SizePolicy = createSizePolicy(),
): void {
  if (byteLength > policy.maxInlineBytes) {
    throw new Error(`inline payload ${byteLength} exceeds maxInlineBytes ${policy.maxInlineBytes}`);
  }
}

export function validateArtifactSize(
  byteLength: number,
  policy: SizePolicy = createSizePolicy(),
): void {
  if (byteLength <= 0) throw new Error('byteLength must be >0');
  if (byteLength > policy.maxArtifactBytes) {
    throw new Error(
      `artifact byteLength ${byteLength} exceeds maxArtifactBytes ${policy.maxArtifactBytes}`,
    );
  }
  if (byteLength > ABSOLUTE_MAX_ARTIFACT_BYTES) {
    throw new Error(`artifact byteLength ${byteLength} exceeds absolute 1GiB proto cap`);
  }
}

export function validateWorkflowArgSize(
  byteLength: number,
  policy: SizePolicy = createSizePolicy(),
): void {
  // Workflow args must be bounded: IDs/refs only, not full docs. Inline content exceeding threshold must be claim-checked.
  if (byteLength > policy.maxInlineBytes) {
    throw new Error(
      `workflow arg byteLength ${byteLength} exceeds maxInlineBytes ${policy.maxInlineBytes} — must use claim-check ArtifactRef`,
    );
  }
}

export function getClassificationForPurpose(purpose: string): string {
  // Map purpose to classification for policy decisions
  if (purpose === 'CHECKPOINT' || purpose === 'TOOL_RESULT' || purpose === 'TRANSCRIPT')
    return 'standard';
  if (purpose === 'SOURCE_DOCUMENT' || purpose === 'KNOWLEDGE_CHUNK') return 'standard';
  if (purpose === 'EXPORT') return 'SENSITIVE';
  return 'standard';
}
