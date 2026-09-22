/**
 * usage-activities.ts — usage recording via MCP
 * Source: agent_studio_implementation_plan.md:1427, agent_studio_architecture.md:422
 * Usage via Engine/MCP, not local ledger (billing is Engine-owned).
 */

import { heartbeat } from './heartbeat.js';
import type { NeryvaMcpClient } from '@neryva/neryva-mcp-client';

export interface RecordUsageParams {
  runId: string;
  organizationId: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export function createUsageActivities(_client: NeryvaMcpClient) {
  return {
    async recordUsage(params: RecordUsageParams): Promise<{ recorded: true }> {
      heartbeat({ step: 'recordUsage', runId: params.runId, model: params.model });
      // Via MCP RecordUsage/CommitRunResult — Engine writes usage_ledger_entries drizzle/0027
      // For Phase 3: stub, eventually call client with NeryvaUsage normalized
      void params;
      return { recorded: true };
    },
  };
}

export type UsageActivities = ReturnType<typeof createUsageActivities>;
