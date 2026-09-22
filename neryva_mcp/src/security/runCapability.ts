/**
 * Run capability — 9 core fields + 6 reject cases + interceptor order.
 * Reference: neryva_mcp_implementation_plan.md:682-693, 697-706, 710-723
 *
 * 9 fields (core): audience, organization_id, conversation_id, run_id, assistant_version, policy_version,
 * allowed_operations, capability_id/nonce, issued_at/expiry, issuer/kid, lease_epoch (optional)
 * We implement all 13 to be precise, but ledger counts 9 core.
 */

import { createHmac, createHash } from "node:crypto";

const AUDIENCE = "neryva-agent-studio";
const ISSUER = "neryva-engine";
const HMAC_SECRET = "neryva_run_cap_secret_spike"; // prod: KMS + asymmetric

export interface RunCapability {
  audience: string; // neryva-agent-studio
  organizationId: string;
  conversationId: string;
  runId: string;
  assistantVersionId: string;
  policyVersion: string;
  allowedOperations: string[]; // e.g., ["AppendRunEvents", "CommitRunResult"]
  capabilityId: string;
  nonce: string;
  issuedAt: number; // ms
  expiresAt: number; // ms
  issuer: string; // neryva-engine
  kid: string; // key ID for rotation
  leaseEpoch?: string; // bigint string optional
}

const NONCE_SEEN = new Set<string>();
const ACTIVE_KEYS = new Map<string, { secret: string; expiresAt: number }>();
let kidCounter = 1;
let currentKid = "kid_run_1";
ACTIVE_KEYS.set(currentKid, { secret: HMAC_SECRET + currentKid, expiresAt: Infinity });

export function createRunCapability(opts: {
  organizationId: string;
  conversationId: string;
  runId: string;
  assistantVersionId?: string;
  policyVersion?: string;
  allowedOperations?: string[];
  ttlMs?: number;
  leaseEpoch?: bigint;
}): { token: string; capability: RunCapability } {
  const cap: RunCapability = {
    audience: AUDIENCE,
    organizationId: opts.organizationId,
    conversationId: opts.conversationId,
    runId: opts.runId,
    assistantVersionId: opts.assistantVersionId ?? "asst_v1",
    policyVersion: opts.policyVersion ?? "policy_v1",
    allowedOperations: opts.allowedOperations ?? ["AppendRunEvents", "GetAuthorizedRunContext", "CommitRunResult"],
    capabilityId: `cap_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
    nonce: Math.random().toString(16).slice(2, 12),
    issuedAt: Date.now(),
    expiresAt: Date.now() + (opts.ttlMs ?? 300_000), // 5m spike, prod short-lived
    issuer: ISSUER,
    kid: currentKid,
    leaseEpoch: opts.leaseEpoch !== undefined ? String(opts.leaseEpoch) : undefined,
  };
  const payload = Buffer.from(JSON.stringify(cap)).toString("base64url");
  const sig = createHmac("sha256", HMAC_SECRET + currentKid).update(payload).digest("base64url");
  const token = `${payload}.${sig}`;
  return { token, capability: cap };
}

export function verifyRunCapability(token: string, expected: { operation?: string; organizationId?: string; conversationId?: string; runId?: string; leaseEpoch?: bigint }): RunCapability {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) throw new Error("missing or invalid workload/capability (697)");

  let cap: RunCapability;
  try {
    cap = JSON.parse(Buffer.from(payload, "base64url").toString()) as RunCapability;
  } catch {
    throw new Error("missing or invalid workload/capability (697)");
  }

  // Look up key in active key ring
  const keyEntry = ACTIVE_KEYS.get(cap.kid ?? currentKid);
  if (!keyEntry || (keyEntry.expiresAt !== Infinity && keyEntry.expiresAt < Date.now())) {
    throw new Error("wrong audience or issuer or kid mismatch (698)");
  }

  const expectedSig = createHmac("sha256", keyEntry.secret).update(payload).digest("base64url");
  if (sig !== expectedSig) {
    throw new Error("wrong audience or issuer or kid mismatch (698)");
  }
  // 6 reject cases (697-706)
  if (cap.audience !== AUDIENCE) throw new Error(`wrong audience ${cap.audience} (698)`);
  if (cap.issuer !== ISSUER) throw new Error(`wrong issuer ${cap.issuer} (698)`);
  if (cap.expiresAt < Date.now()) throw new Error("expired capability (699)");
  if (cap.issuedAt > Date.now() + 5_000) throw new Error("not-yet-valid capability (699)");
  if (expected.organizationId && cap.organizationId !== expected.organizationId) throw new Error(`scope mismatch organization_id ${cap.organizationId} vs ${expected.organizationId} (700)`);
  if (expected.conversationId && cap.conversationId !== expected.conversationId) throw new Error(`scope mismatch conversation_id (700)`);
  if (expected.runId && cap.runId !== expected.runId) throw new Error(`scope mismatch run_id ${cap.runId} vs ${expected.runId} (700)`);
  if (NONCE_SEEN.has(cap.nonce)) throw new Error(`replayed nonce ${cap.nonce} (701)`);
  // Only mark nonce seen after all other checks pass, and only for one-time operations (spike: all)
  // For spike we don't auto-mark, caller must check via isNonceReplayed? We mark here for test
  // But to allow same token reuse for multiple calls in same run, we don't mark by default — test will check replay via explicit second verify
  if (expected.leaseEpoch !== undefined && cap.leaseEpoch !== undefined && BigInt(cap.leaseEpoch) !== expected.leaseEpoch) {
    throw new Error(`stale lease epoch ${cap.leaseEpoch} vs ${expected.leaseEpoch} (702)`);
  }
  if (expected.operation && !cap.allowedOperations.includes(expected.operation)) {
    throw new Error(`operation ${expected.operation} not listed in capability (703)`);
  }
  // Cross-organization check already via org mismatch, but also check conversation/run cross
  return cap;
}

export function markNonceSeen(nonce: string): void {
  NONCE_SEEN.add(nonce);
}

export function isNonceReplayed(nonce: string): boolean {
  return NONCE_SEEN.has(nonce);
}

export function rotateRunCapabilityKey(overlapMs = 300_000): string {
  const oldKid = currentKid;
  ACTIVE_KEYS.set(oldKid, { secret: HMAC_SECRET + oldKid, expiresAt: Date.now() + overlapMs });
  kidCounter++;
  currentKid = `kid_run_${kidCounter}`;
  ACTIVE_KEYS.set(currentKid, { secret: HMAC_SECRET + currentKid, expiresAt: Infinity });
  return currentKid;
}

export function getCurrentKid(): string {
  return currentKid;
}

export function clearRunCapabilityState(): void {
  NONCE_SEEN.clear();
  ACTIVE_KEYS.clear();
  kidCounter = 1;
  currentKid = "kid_run_1";
  ACTIVE_KEYS.set(currentKid, { secret: HMAC_SECRET + currentKid, expiresAt: Infinity });
}
