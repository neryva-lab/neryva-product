/**
 * capability-checker.ts — validates model/tool refs against registries
 * Source: agent_studio_architecture.md:406, agent_studio_implementation_plan.md:725-732
 */

import type { ToolDescriptor } from '../../../contracts/tool/descriptor.js';

// Minimal capability registry for Phase 1 — in production, sourced from Model Gateway.
// Extended 2026-09-13 (TPL-3.2): the original three IDs were stale
// (claude-3-5-sonnet retired 2026-02, gpt-4o ChatGPT-retired) while omitting
// every current model. Additive only — old IDs stay valid for existing
// definitions. Current IDs verified against provider docs 2026-09-13
// (aliases preferred over date-stamped snapshots: aliases resolve, snapshots rot).
export const DEFAULT_MODEL_CAPABILITIES = new Set<string>([
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-3-5-sonnet',
  'google/gemini-1.5-pro',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-haiku-4-5',
  'anthropic/claude-opus-4-5',
  'openai/gpt-5.4',
  'openai/gpt-5.4-mini',
]);

export function isKnownModel(
  model: string,
  registry: Set<string> = DEFAULT_MODEL_CAPABILITIES,
): boolean {
  return registry.has(model);
}

export function validateAllowedModels(
  allowedModels: string[],
  registry: Set<string> = DEFAULT_MODEL_CAPABILITIES,
): { unknown: string[] } {
  const unknown = allowedModels.filter((m) => !isKnownModel(m, registry));
  return { unknown };
}

// Tool registry check — uses DEFAULT_TOOL_DESCRIPTORS from contracts/tool
import { DEFAULT_TOOL_DESCRIPTORS } from '../../../contracts/tool/descriptor.js';

export function isKnownTool(
  toolName: string,
  registry: ToolDescriptor[] = DEFAULT_TOOL_DESCRIPTORS,
): boolean {
  return registry.some((d) => d.toolId === toolName);
}

export function getToolDescriptor(
  toolName: string,
  registry: ToolDescriptor[] = DEFAULT_TOOL_DESCRIPTORS,
): ToolDescriptor | undefined {
  return registry.find((d) => d.toolId === toolName);
}
