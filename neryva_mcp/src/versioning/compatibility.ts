/**
 * Versioning — additive v1, unknown-field tolerance, old RPCs during migration, capability negotiation, v2 only for wire incompatibility.
 * Reference: neryva_mcp_implementation_plan.md:795-802, 804-813, 820-825, 827
 */

export const PROTOCOL_VERSION = "1.0";
export const SUPPORTED_RANGES = {
  mcp: "1.x",
  agentDefinition: "1.x",
  artifactFormats: ["v1"],
  capabilityVersions: ["v1"],
  modelGateway: "1.x",
};

export function isAdditiveChange(fieldNumber: number, existingNumbers: Set<number>): boolean {
  return !existingNumbers.has(fieldNumber);
}

export function shouldTolerateUnknownFields(): boolean {
  return true; // additive evolution within v1
}

export function requiresV2(isWireIncompatible: boolean): boolean {
  return isWireIncompatible;
}

export const CI_CHECKS = [
  "buf format --diff --exit-code",
  "buf lint",
  "buf breaking --against '.git#branch=main'",
  "buf generate",
  "typecheck generated clients",
  "conformance tests",
] as const;

export function checkRuntimeCompatibility(deployment: { mcpVersion: string; agentVersion: string }): { compatible: boolean; reason?: string } {
  if (!deployment.mcpVersion.startsWith("1.")) return { compatible: false, reason: `unsupported mcp ${deployment.mcpVersion}` };
  if (!deployment.agentVersion.startsWith("1.")) return { compatible: false, reason: `unsupported agent ${deployment.agentVersion}` };
  return { compatible: true };
}

// Temporal versioning — use Temporal's versioning API, not in-place workflow changes (827)
export function temporalVersioningNote(): string {
  return "Use Temporal's safe deployment/versioning mechanisms rather than changing deterministic workflow behavior in place (827)";
}
