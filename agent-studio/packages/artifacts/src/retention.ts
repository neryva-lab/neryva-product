/**
 * retention.ts — expiry, legal hold, deletion, stale ref handling
 * Source: agent_studio_implementation_plan.md:325-340 (retention_class, expiry), 1478, 1486 (deletion/expiry makes stale refs unusable)
 * Engine is authoritative for retention; Studio checks expiry/legalHold before using refs and excludes stale.
 */

export type RetentionClass = 'TEMPORARY' | 'STANDARD' | 'LONG_TERM' | 'LEGAL_HOLD';

export const RETENTION_TTL_MS: Record<RetentionClass, number> = {
  TEMPORARY: 24 * 60 * 60 * 1000, // 24h
  STANDARD: 7 * 24 * 60 * 60 * 1000, // 7d
  LONG_TERM: 30 * 24 * 60 * 60 * 1000, // 30d
  LEGAL_HOLD: Number.MAX_SAFE_INTEGER,
};

export interface RetentionInfo {
  expiresAt: Date;
  retentionClass: RetentionClass;
  legalHold?: boolean;
  deletedAt?: Date;
  quarantinedAt?: Date;
}

export function isStale(ref: {
  expiresAt: Date;
  deletedAt?: Date;
  quarantinedAt?: Date;
  legalHold?: boolean;
}): boolean {
  if (ref.deletedAt) return true;
  if (ref.quarantinedAt) return true;
  if (ref.expiresAt.getTime() <= Date.now()) return true;
  return false;
}

export function isQuarantined(ref: { quarantinedAt?: Date }): boolean {
  return Boolean(ref.quarantinedAt);
}

export function isDeleted(ref: { deletedAt?: Date }): boolean {
  return Boolean(ref.deletedAt);
}

export function validateRetentionExpiresAt(
  expiresAt: Date,
  retentionClass: RetentionClass = 'STANDARD',
): void {
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()))
    throw new Error('expiresAt must be valid Date');
  // For non-LEGAL_HOLD, expiry must be in future and within max TTL + margin
  if (retentionClass !== 'LEGAL_HOLD' && expiresAt.getTime() <= Date.now()) {
    throw new Error('retention expiresAt must be in future');
  }
}

export function computeExpiry(retentionClass: RetentionClass, from = new Date()): Date {
  if (retentionClass === 'LEGAL_HOLD') return new Date(8640000000000000); // max date
  const ttl = RETENTION_TTL_MS[retentionClass];
  return new Date(from.getTime() + ttl);
}

export function shouldExcludeFromContext(ref: {
  expiresAt: Date;
  deletedAt?: Date;
  quarantinedAt?: Date;
  status?: string;
}): boolean {
  if (ref.status && ref.status !== 'READY' && ref.status !== 'AVAILABLE') return true;
  if (isStale(ref)) return true;
  return false;
}
