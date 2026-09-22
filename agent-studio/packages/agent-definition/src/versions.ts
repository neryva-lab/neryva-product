/**
 * versions.ts — schema version handling
 * Source: agent_studio_implementation_plan.md:688-724
 */

export const CURRENT_SCHEMA_VERSION = 'v1' as const;
export type SchemaVersion = 'v1';

export function parseSchemaVersion(raw: unknown): SchemaVersion {
  if (raw === undefined || raw === 'v1') return 'v1';
  throw new Error(`unsupported schema_version: ${String(raw)} (only v1 supported)`);
}

export function isSupportedVersion(version: string): boolean {
  return version === 'v1';
}
