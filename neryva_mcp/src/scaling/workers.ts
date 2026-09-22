/**
 * Scaling — shared multi-tenant workers, isolated pools for privileged/high-cost tools.
 * Reference: neryva_mcp_implementation_plan.md:898-905
 */

export type TaskQueue = "default" | "privileged" | "high_cost" | `tenant_${string}`;

export const SCALING_MODEL = {
  sharedWorkers: "many organizations share horizontally scaled Studio pool",
  orgConcurrency: "Engine enforces organization and conversation concurrency",
  taskQueues: "Temporal task queues separate workload classes",
  isolatedPools: "privileged or high-cost tools use isolated worker pools",
  dedicatedTenants: "large tenants may receive dedicated queues",
  noLocalState: "no organization is selected by worker-local mutable state",
} as const;

export function getTaskQueueForTool(toolName: string, isPrivileged: boolean, isHighCost: boolean): TaskQueue {
  if (isPrivileged) return "privileged";
  if (isHighCost) return "high_cost";
  return "default";
}

export function shouldNotUseOrgLocalState(): boolean {
  return true;
}
