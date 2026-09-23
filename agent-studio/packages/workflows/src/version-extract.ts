/**
 * version-extract.ts — lease-epoch / run-version extraction for workflows.
 *
 * The Engine claim carries the lease epoch and the run version as protobuf
 * uint64s (BigInt at the activity edge, already sanitized to plain numbers
 * by toSerializableClaim in the runtime worker). The workflow MUST keep these
 * as plain JSON numbers: Temporal's default payload converter cannot
 * serialize bigint, and scheduling an activity with a bigint arg fails INSIDE
 * the workflow (scheduleActivityNextHandler → toPayloadsWithContext) before
 * the activity ever runs — surfacing as "Unable to convert [object Object]
 * to payload". The MCP activity layer converts back to uint64 bigint at its
 * own edge (toUint64 in @neryva/activities).
 *
 * Pure + deterministic: safe to import from workflow code and to unit test.
 */

/**
 * Extract a non-negative safe-integer epoch/version from an Engine claim
 * response. Accepts the number form (normal) and the bigint form (defensive,
 * e.g. an unsanitized claim).
 *
 * Absent (missing key, null, undefined) → 0: no lease/version was issued,
 * and 0 keeps the existing "no lease" semantic (the workflow only releases
 * when leaseEpoch > 0).
 *
 * Present-but-invalid (negative, fractional, beyond MAX_SAFE_INTEGER, wrong
 * type) → THROWS. A corrupt epoch/version silently coerced to 0 would
 * disable lease fencing and CAS — that failure mode must be loud, never
 * silent.
 */
export function extractVersionNumber(raw: unknown, field: string, alt: string): number {
  if (typeof raw === 'object' && raw !== null) {
    const run = (raw as Record<string, unknown>)['run'];
    const pool: unknown[] = [raw, ...(typeof run === 'object' && run !== null ? [run] : [])];
    for (const source of pool) {
      const rec = source as Record<string, unknown>;
      for (const key of [field, alt]) {
        if (!(key in rec)) continue;
        const candidate = rec[key];
        if (candidate === undefined || candidate === null) continue; // absent — try next
        if (typeof candidate === 'number') {
          if (Number.isSafeInteger(candidate) && candidate >= 0) return candidate;
          throw new Error(
            `NON_SERIALIZABLE_VERSION: ${key} must be a non-negative safe integer, got ${String(candidate)}`,
          );
        }
        if (typeof candidate === 'bigint') {
          if (candidate >= 0n && candidate <= BigInt(Number.MAX_SAFE_INTEGER)) {
            return Number(candidate);
          }
          throw new Error(
            `NON_SERIALIZABLE_VERSION: ${key} bigint ${candidate.toString()} is out of the safe integer range`,
          );
        }
        throw new Error(
          `NON_SERIALIZABLE_VERSION: ${key} must be a number or bigint, got ${typeof candidate}`,
        );
      }
    }
  }
  return 0;
}

/** True when a value is safe to pass through a Temporal activity arg/result. */
export function isTemporalJsonSafe(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'bigint') return false;
  if (typeof value !== 'object') return false; // functions, symbols
  return Object.values(value as Record<string, unknown>).every(isTemporalJsonSafe);
}
