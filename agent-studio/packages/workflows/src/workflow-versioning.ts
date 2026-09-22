/**
 * workflow-versioning.ts — Temporal-compatible version markers
 * Source: agent_studio_implementation_plan.md:850-853, 1236-1247
 * Keep old paths until executions finish. Never replay-break.
 * Uses Temporal patched() / deprecatePatch() via @temporalio/workflow.
 */

// Version identifiers — must be stable strings, never reused.
export const WORKFLOW_VERSIONS = {
  // Initial generation of AgentRunWorkflow (Phase 3)
  INITIAL: 'agent-run-v1',
  // Future: add tool-isolation or context-citation path without breaking replay
  // TOOL_SANDBOX_V2: 'tool-sandbox-v2',
} as const;

export type WorkflowVersion = (typeof WORKFLOW_VERSIONS)[keyof typeof WORKFLOW_VERSIONS];

/**
 * Maximum supported workflow version for this worker build.
 * Older executions keep running on old path until finished.
 */
export const CURRENT_WORKFLOW_VERSION: WorkflowVersion = WORKFLOW_VERSIONS.INITIAL;

/**
 * Helper for workflow code to check version.
 * Wraps Temporal's patched() deterministically — workflow must call patched(id) at same point on replay.
 * See Temporal versioning docs: patched vs deprecatePatch lifecycle.
 *
 * Usage in workflow:
 *   if (patched('agent-run-v2')) { newPath(); } else { oldPath(); }
 */
export const PATCH_IDS = {
  APPROVAL_SIGNAL_V2: 'approval-signal-v2',
  CONTINUE_AS_NEW_V2: 'continue-as-new-v2',
} as const;
