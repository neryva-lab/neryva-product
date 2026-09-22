/**
 * model-catalog.ts — catalog sourced from Engine policy snapshot + local capability registry
 * Source: agent_studio_architecture.md:409-426
 */

import {
  CapabilityRegistry,
  DEFAULT_CAPABILITIES,
  type NeryvaModelCapabilities,
} from './capabilities.js';

export interface PolicySnapshot {
  organizationId: string;
  allowedModels: string[]; // org allowlist from Engine
  retention?: string | undefined;
  residency?: string | undefined;
}

export interface ModelCatalog {
  registry: CapabilityRegistry;
  get(modelId: string): NeryvaModelCapabilities | undefined;
  isAllowed(modelId: string, snapshot: PolicySnapshot): boolean;
  listAllowed(snapshot: PolicySnapshot): NeryvaModelCapabilities[];
}

export function createCatalog(
  caps: NeryvaModelCapabilities[] = DEFAULT_CAPABILITIES,
): ModelCatalog {
  const registry = new CapabilityRegistry(caps);
  return {
    registry,
    get: (id) => registry.get(id),
    isAllowed: (modelId, snapshot) => {
      const cap = registry.get(modelId);
      if (!cap || !cap.available || cap.deprecated) return false;
      // Org allowlist — must be in snapshot.allowedModels if snapshot non-empty
      if (snapshot.allowedModels.length > 0 && !snapshot.allowedModels.includes(modelId))
        return false;
      return true;
    },
    listAllowed: (snapshot) => {
      return registry.listAvailable().filter((c) => {
        if (snapshot.allowedModels.length > 0) return snapshot.allowedModels.includes(c.modelId);
        return true;
      });
    },
  };
}
