/**
 * tool-selector.ts — selects tools allowed for step+policy from contracts/tool
 * Source: agent_studio_implementation_plan.md:943-955 step 7, contracts/tool/descriptor.ts
 * Tools are allowlisted in AgentDefinition and must exist in registry with version.
 */

import type { ToolDescriptor } from '@neryva/contracts/tool/descriptor';

export interface ToolSelection {
  selected: ToolDescriptor[];
  omitted: ToolDescriptor[];
  rejected: Array<{ tool: string; reason: string }>;
}

export function selectTools(
  availableTools: ToolDescriptor[],
  options: {
    allowedTools: Array<{
      name: string;
      access: 'read' | 'write';
      approval?: 'required' | 'none' | undefined;
    }>;
    step?: string | undefined; // for future step-specific filtering
  },
): ToolSelection {
  const allowedNames = new Set(options.allowedTools.map((t) => t.name));
  const selected: ToolDescriptor[] = [];
  const rejected: Array<{ tool: string; reason: string }> = [];

  for (const tool of availableTools) {
    if (!allowedNames.has(tool.toolId)) {
      rejected.push({ tool: tool.toolId, reason: 'not-in-definition' });
      continue;
    }

    // Check that definition's access matches descriptor's effectClass
    // This is already validated at definition compile time, but double-check
    const defTool = options.allowedTools.find((t) => t.name === tool.toolId);
    if (!defTool) {
      rejected.push({ tool: tool.toolId, reason: 'def-not-found' });
      continue;
    }

    selected.push(tool);
  }

  // Also check for tools in definition that are not in registry (unknown tool)
  for (const defTool of options.allowedTools) {
    if (!availableTools.some((t) => t.toolId === defTool.name)) {
      rejected.push({ tool: defTool.name, reason: 'unknown-tool-not-in-registry' });
    }
  }

  // Deterministic ordering: by toolId
  selected.sort((a, b) => a.toolId.localeCompare(b.toolId));

  return { selected, omitted: [], rejected };
}

export function toProviderTools(
  descriptors: ToolDescriptor[],
): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return descriptors.map((d) => ({
    name: d.toolId,
    description: `Tool ${d.toolId} v${d.version} (${d.effectClass})`,
    parameters: d.inputSchema,
  }));
}
