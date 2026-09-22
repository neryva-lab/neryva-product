/**
 * tool-context.ts — per-call context (tenant, user, run, policy version)
 * Source: agent_studio_architecture.md:483-511
 * Every tool call carries organization_id, conversation_id, run_id, agent_version_id, correlation_id, policy version.
 */

export interface ToolContext {
  organizationId: string;
  conversationId: string;
  runId: string;
  agentVersionId: string;
  policyVersion: string;
  correlationId: string;
  actorId?: string | undefined;
  // For rate/cost limits
  budget?: { maxToolCalls?: number | undefined; maxCostCents?: number | undefined } | undefined;
}

export function createToolContext(params: ToolContext): ToolContext {
  // Validate required fields — fail-closed
  if (!params.organizationId || !params.runId || !params.conversationId) {
    throw new Error('ToolContext missing required scope');
  }
  return { ...params };
}

export function isSameTenant(a: ToolContext, b: { organizationId: string }): boolean {
  return a.organizationId === b.organizationId;
}
