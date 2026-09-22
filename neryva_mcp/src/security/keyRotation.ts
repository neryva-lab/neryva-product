/**
 * Key/capability rotation — 6 steps per 829-836.
 * - publish verification keys with overlap during rotation
 * - include kid in signed tokens
 * - reject unknown key IDs after bounded cache refresh
 * - rotate workload certificates without process restarts where supported
 * - test rotation during active runs
 * - retain audit evidence of key version used
 */

import { rotateRunCapabilityKey, getCurrentKid } from "./runCapability.js";
import { rotateWorkloadIdentity, getCurrentIdentity } from "./workloadIdentity.js";

export interface RotationState {
  oldKid: string;
  newKid: string;
  overlapMs: number;
  startedAt: number;
}

let rotationState: RotationState | null = null;

export function startKeyRotation(overlapMs = 300_000): RotationState {
  const oldKid = getCurrentKid();
  const newKid = rotateRunCapabilityKey();
  rotationState = { oldKid, newKid, overlapMs, startedAt: Date.now() };
  return rotationState;
}

export function isInOverlap(kid: string): boolean {
  if (!rotationState) return false;
  if (Date.now() - rotationState.startedAt > rotationState.overlapMs) return false;
  return kid === rotationState.oldKid || kid === rotationState.newKid;
}

export function shouldRejectUnknownKid(kid: string, cacheAgeMs: number): boolean {
  // Reject unknown key IDs after bounded cache refresh (e.g., 60s)
  if (cacheAgeMs > 60_000) return true;
  return !isInOverlap(kid);
}

export function rotateWorkloadCertWithoutRestart(): void {
  rotateWorkloadIdentity();
}

export function getRotationAudit(): RotationState | null {
  return rotationState;
}

export function clearRotation(): void {
  rotationState = null;
}
