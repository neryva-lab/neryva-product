/**
 * payload.ts — workflow payload protection
 * Source: agent_studio_implementation_plan.md:839-848, agent_studio_architecture.md:133-143, 558-598
 * - Default: IDs/refs/bounded metadata + artifact refs only; never raw prompts/docs/credentials/full provider responses
 * - Encrypted codec for bounded non-public values (classification, key source, rotation)
 * - Max inline payload size enforced before scheduling
 * - Claim-check for large/sensitive/long-retained
 */

export const MAX_INLINE_BYTES = 8192; // matches ARTIFACTS_MAX_INLINE_BYTES, 3.10 config
export const MAX_WORKFLOW_INPUT_BYTES = 16_384;
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export type PayloadClassification = 'PUBLIC' | 'INTERNAL' | 'SENSITIVE' | 'RESTRICTED';

export interface PayloadMetadata {
  byteLength: number;
  classification: PayloadClassification;
  requiresClaimCheck: boolean;
  reason?: string | undefined;
}

/**
 * Validate that workflow inputs/results are bounded and do not contain prohibited classes.
 * Must be called in workflow (deterministic) and in activities (before scheduling).
 */
export function validatePayloadSize(
  payload: unknown,
  classification: PayloadClassification = 'INTERNAL',
): PayloadMetadata {
  const serialized = JSON.stringify(payload);
  const byteLength = new TextEncoder().encode(serialized).length;

  if (byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `payload too large: ${byteLength}B > MAX_ARTIFACT_BYTES ${MAX_ARTIFACT_BYTES} (use claim-check)`,
    );
  }

  const requiresClaimCheck =
    byteLength > MAX_INLINE_BYTES ||
    classification === 'SENSITIVE' ||
    classification === 'RESTRICTED';

  return {
    byteLength,
    classification,
    requiresClaimCheck,
    reason: requiresClaimCheck
      ? byteLength > MAX_INLINE_BYTES
        ? `exceeds MAX_INLINE_BYTES ${MAX_INLINE_BYTES}`
        : `classification ${classification} requires claim-check`
      : undefined,
  };
}

/**
 * Forbidden patterns that must never appear in workflow args/activity results/logs/default traces.
 * Enforced by check:generated + unit tests (847).
 */
const FORBIDDEN_CONTENT_PATTERNS = [
  /sk-(proj-)?[A-Za-z0-9]{20,}/, // tentative OpenAI key
  /AKIA[0-9A-Z]{16}/, // AWS key
  /-----BEGIN (RSA )?PRIVATE KEY-----/,
  /"password"\s*:\s*".+"/i,
] as const;

export function containsForbiddenContent(text: string): string | undefined {
  for (const re of FORBIDDEN_CONTENT_PATTERNS) {
    if (re.test(text)) return re.source;
  }
  return undefined;
}

export function assertNoForbiddenContent(payload: unknown): void {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const hit = containsForbiddenContent(text);
  if (hit) {
    throw new Error(
      `payload contains forbidden content pattern ${hit} — use secret-provider or claim-check`,
    );
  }
}

/**
 * Claim-check reference shape (must match @neryva/neryva-mcp-client claim-check).
 * Tenant/run scoped, purpose-bound, checksum-verified, expiring, re-auth on read (846).
 */
export interface ClaimCheckRef {
  artifactId: string;
  organizationId: string;
  runId: string;
  purpose: string;
  byteLength: number;
  sha256: string; // hex 64 chars = 32B
  expiresAt: string; // ISO 8601
}

export function isValidClaimCheckRef(ref: unknown): ref is ClaimCheckRef {
  if (typeof ref !== 'object' || ref === null) return false;
  const r = ref as Record<string, unknown>;
  return (
    typeof r['artifactId'] === 'string' &&
    typeof r['organizationId'] === 'string' &&
    typeof r['runId'] === 'string' &&
    typeof r['purpose'] === 'string' &&
    typeof r['byteLength'] === 'number' &&
    typeof r['sha256'] === 'string' &&
    (r['sha256'] as string).length === 64 &&
    typeof r['expiresAt'] === 'string'
  );
}

/**
 * Assert workflow input is bounded refs only (595).
 * Throws if payload contains large inline content that should be claim-check.
 */
export function assertWorkflowInputBounded(input: unknown): void {
  const meta = validatePayloadSize(input, 'INTERNAL');
  if (meta.byteLength > MAX_WORKFLOW_INPUT_BYTES) {
    throw new Error(
      `workflow input ${meta.byteLength}B > MAX_WORKFLOW_INPUT_BYTES ${MAX_WORKFLOW_INPUT_BYTES} — pass artifact refs, not raw docs (595)`,
    );
  }
  assertNoForbiddenContent(input);
}
