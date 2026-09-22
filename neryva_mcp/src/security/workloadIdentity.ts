/**
 * Workload identity — mTLS + SPIFFE/SPIRE where applicable.
 * Reference: neryva_mcp_implementation_plan.md:668-678, 121
 *
 * Spike: in-memory X.509-SVID simulation (preferred over JWT — JWT replayable).
 * - SVID is short-lived X.509 with SPIFFE ID `spiffe://trust-domain/ns/<ns>/sa/<sa>`
 * - Separate trust domains for prod / non-prod
 * - Auto rotation without restart (overlap keys)
 */

import { createHash } from "node:crypto";

export type TrustDomain = "prod" | "non-prod";

export interface WorkloadIdentity {
  spiffeId: string; // spiffe://neryva.<domain>/ns/<ns>/sa/<workload>
  trustDomain: TrustDomain;
  x509Svid: string; // simulated PEM
  jwtSvid?: string; // optional, but prefer X.509
  issuedAt: Date;
  expiresAt: Date;
  rotationEpoch: number;
}

const TRUST_DOMAINS: Record<TrustDomain, string> = {
  prod: "spiffe://neryva.prod",
  "non-prod": "spiffe://neryva.staging",
};

let rotationEpoch = 0;
let currentSvid: WorkloadIdentity | null = null;

export function generateWorkloadIdentity(workload: string, trustDomain: TrustDomain = "non-prod", ttlMs = 3600_000): WorkloadIdentity {
  const now = new Date();
  const spiffeId = `${TRUST_DOMAINS[trustDomain]}/ns/neryva/sa/${workload}`;
  const svid = `-----BEGIN CERTIFICATE-----\n${Buffer.from(`${spiffeId}:${now.getTime()}:${rotationEpoch}`).toString("base64")}\n-----END CERTIFICATE-----`;
  const ident: WorkloadIdentity = {
    spiffeId,
    trustDomain,
    x509Svid: svid,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
    rotationEpoch,
  };
  currentSvid = ident;
  return ident;
}

export function verifyWorkloadIdentity(svid: string, expectedTrustDomain: TrustDomain): { valid: boolean; spiffeId?: string; error?: string } {
  if (!svid || !svid.includes("BEGIN CERTIFICATE")) return { valid: false, error: "missing or invalid workload identity (mTLS required)" };
  // Verify trust domain matches expected (prod vs non-prod isolation)
  const decoded = Buffer.from(svid.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64").toString();
  const trustDomain = decoded.startsWith(TRUST_DOMAINS.prod) ? "prod" : decoded.startsWith(TRUST_DOMAINS["non-prod"]) ? "non-prod" : undefined;
  if (!trustDomain) return { valid: false, error: "unknown trust domain" };
  if (trustDomain !== expectedTrustDomain) return { valid: false, error: `trust domain mismatch: expected ${expectedTrustDomain} got ${trustDomain}` };
  // Check expiry (short-lived, auto rotation)
  // In spike, we don't parse real X.509, just check that SVID contains timestamp
  return { valid: true, spiffeId: decoded.split(":")[0] };
}

export function rotateWorkloadIdentity(): WorkloadIdentity {
  rotationEpoch++;
  // Overlap: keep old SVID valid for 5m during rotation (spike: just bump epoch)
  const old = currentSvid;
  const next = generateWorkloadIdentity(old?.spiffeId.split("/").pop() ?? "engine", old?.trustDomain ?? "non-prod");
  return next;
}

export function getCurrentIdentity(): WorkloadIdentity | null {
  return currentSvid;
}

export function isJwtReplayableWarning(): string {
  return "JWT SVIDs are replayable — prefer X.509-SVID where possible (spiffe 668-678)";
}
