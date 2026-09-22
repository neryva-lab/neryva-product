/**
 * Short-lived tool capability — bound to run_id/step_id/tool_call_id/version/digest/org/expiry/audience.
 * Reference: neryva_mcp_implementation_plan.md:605, 682-693, 697-706
 *
 * Capability is NOT a replacement for Engine-side authorization; it's compact proof of granted scope.
 * Must be audience-bound `neryva-agent-studio`, scope-bound, nonce, kid, lease epoch aware, short-lived.
 */

import { createHash, createHmac } from "node:crypto";

const HMAC_SECRET = "neryva_spike_secret_do_not_use_in_prod"; // spike: symmetric; prod: KMS + asymmetric
const AUDIENCE = "neryva-agent-studio";
const DEFAULT_TTL_MS = 60_000; // 1m spike, prod short-lived

export interface ToolCapability {
  runId: string;
  stepId: string;
  toolCallId: string;
  toolVersion: string;
  argumentDigest: string; // hex 64 (sha256)
  organizationId: string;
  expiryMs: number;
  audience: string;
  kid: string;
  nonce: string;
  leaseEpoch?: bigint;
}

export function createToolCapability(opts: {
  runId: string;
  stepId: string;
  toolCallId: string;
  toolVersion: string;
  argumentDigest: Uint8Array | string; // 32B
  organizationId: string;
  ttlMs?: number;
  leaseEpoch?: bigint;
}): { token: string; capability: ToolCapability } {
  const digestHex = typeof opts.argumentDigest === "string" ? opts.argumentDigest : Buffer.from(opts.argumentDigest).toString("hex");
  if (digestHex.length !== 64) throw new Error("argumentDigest must be 32B sha256 hex 64");
  const cap: ToolCapability = {
    runId: opts.runId,
    stepId: opts.stepId,
    toolCallId: opts.toolCallId,
    toolVersion: opts.toolVersion,
    argumentDigest: digestHex,
    organizationId: opts.organizationId,
    expiryMs: Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS),
    audience: AUDIENCE,
    kid: "kid_spike_1",
    nonce: Math.random().toString(16).slice(2, 10),
    leaseEpoch: opts.leaseEpoch,
  };
  const payload = Buffer.from(JSON.stringify({ ...cap, leaseEpoch: cap.leaseEpoch !== undefined ? String(cap.leaseEpoch) : undefined })).toString("base64url");
  const sig = createHmac("sha256", HMAC_SECRET).update(payload).digest("base64url");
  const token = `${payload}.${sig}`;
  return { token, capability: cap };
}

export function verifyToolCapability(token: string, expected: { runId: string; stepId: string; toolCallId: string; argumentDigest: Uint8Array | string; organizationId: string }): ToolCapability {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) throw new Error("invalid capability token format");
  const expectedSig = createHmac("sha256", HMAC_SECRET).update(payload).digest("base64url");
  if (sig !== expectedSig) throw new Error("capability signature mismatch (audience/issuer tamper)");
  const cap = JSON.parse(Buffer.from(payload, "base64url").toString()) as ToolCapability & { leaseEpoch?: string };
  const capTyped: ToolCapability = { ...cap, leaseEpoch: cap.leaseEpoch ? BigInt(cap.leaseEpoch as unknown as string) : undefined } as unknown as ToolCapability;
  // 6 reject cases per 697-706
  if (capTyped.audience !== AUDIENCE) throw new Error(`wrong audience ${capTyped.audience}`);
  if (capTyped.expiryMs < Date.now()) throw new Error("capability expired");
  // not-yet-valid not needed for spike (iat == now)
  if (capTyped.organizationId !== expected.organizationId) throw new Error("scope mismatch organization_id");
  if (capTyped.runId !== expected.runId) throw new Error("scope mismatch run_id");
  if (capTyped.stepId !== expected.stepId) throw new Error("scope mismatch step_id");
  if (capTyped.toolCallId !== expected.toolCallId) throw new Error("capability not reusable for another tool_call_id");
  const expectedHex = typeof expected.argumentDigest === "string" ? expected.argumentDigest : Buffer.from(expected.argumentDigest).toString("hex");
  if (capTyped.argumentDigest !== expectedHex) throw new Error("argument digest mismatch (tool args tampered)");
  return capTyped;
}

export function hashArgs(args: unknown): Uint8Array {
  const json = JSON.stringify(args, (_, v) => typeof v === "bigint" ? String(v) : v);
  return createHash("sha256").update(json).digest();
}
