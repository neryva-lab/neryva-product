/**
 * Temporal guard — ensures no raw customer documents/secrets/unbounded prompts in Temporal args/event metadata.
 * Reference: neryva_mcp_implementation_plan.md:579, 640, 113-115
 *
 * For Phase 2: validates that workflow inputs contain only IDs/refs, not large content.
 */

import { validationError } from "./errors.js";
import { MAX_INLINE_BYTES } from "../artifacts/claimCheck.js";

const FORBIDDEN_KEYS = new Set(["documentContent", "rawDocument", "secret", "password", "apiKey", "prompt", "transcript", "customerData"]);
const MAX_STRING_LENGTH = 1024; // for Temporal args, strings should be bounded
const MAX_ARGS_BYTES = 64 * 1024; // 64KiB

export function assertTemporalArgsSafe(args: unknown): void {
  const json = JSON.stringify(args, (_, v) => typeof v === "bigint" ? String(v) : v);
  if (json.length > MAX_ARGS_BYTES) throw validationError(`Temporal args too large: ${json.length} > ${MAX_ARGS_BYTES} — use ArtifactRef`);
  // Check for forbidden keys
  const lower = json.toLowerCase();
  for (const key of FORBIDDEN_KEYS) {
    if (lower.includes(key.toLowerCase())) throw validationError(`Temporal args contains forbidden key: ${key} — use ArtifactRef claim-check`);
  }
  // Check for unbounded strings
  function check(obj: unknown): void {
    if (typeof obj === "string" && obj.length > MAX_STRING_LENGTH) {
      // Allow if it's a ref URI (artifact://) — those are safe
      if (!obj.startsWith("artifact://") && !obj.startsWith("urn:")) {
        throw validationError(`Temporal arg string too long (${obj.length} > ${MAX_STRING_LENGTH}) — use ArtifactRef`);
      }
    } else if (Array.isArray(obj)) {
      for (const item of obj) check(item);
    } else if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (FORBIDDEN_KEYS.has(k)) throw validationError(`Temporal args contains forbidden field: ${k}`);
        check(v);
      }
    }
  }
  check(args);
}

export function isArtifactRef(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const rec = obj as Record<string, unknown>;
  return typeof rec.artifactId === "string" && typeof rec.uri === "string" && typeof rec.purpose === "string";
}
