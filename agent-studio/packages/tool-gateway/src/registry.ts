/**
 * registry.ts — read-only tool registry interface for definition validation + context planning
 * Source: agent_studio_implementation_plan.md:1354-1355
 * Runtime execution remains unimplemented until Phase 6; this is the read-only view.
 */

import type { ToolDescriptor } from '@neryva/contracts/tool/descriptor';
import { DEFAULT_TOOL_DESCRIPTORS } from '@neryva/contracts/tool/descriptor';

export interface ToolRegistry {
  list(): ToolDescriptor[];
  get(toolId: string): ToolDescriptor | undefined;
  has(toolId: string): boolean;
}

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly map: Map<string, ToolDescriptor>;

  constructor(descriptors: ToolDescriptor[] = DEFAULT_TOOL_DESCRIPTORS) {
    this.map = new Map(descriptors.map((d) => [d.toolId, d]));
  }

  list(): ToolDescriptor[] {
    return [...this.map.values()];
  }

  get(toolId: string): ToolDescriptor | undefined {
    return this.map.get(toolId);
  }

  has(toolId: string): boolean {
    return this.map.has(toolId);
  }
}

export const defaultRegistry = new InMemoryToolRegistry();
