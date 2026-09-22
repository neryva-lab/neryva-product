/**
 * state.ts — bounded, reference-based kernel state
 * Source: agent_studio_implementation_plan.md:756-783, agent_studio_architecture.md:322-351
 * No full history/docs/prompts — only refs.
 */

export type RunId = string;
export type OrganizationId = string;
export type ConversationId = string;
export type AgentVersionId = string;
export type PolicyVersionId = string;
export type StepId = string;
export type ArtifactId = string;

export type AgentRunStatus =
  | 'ADMISSION'
  | 'LOAD_CONTEXT'
  | 'POLICY_CHECK'
  | 'MODEL_STEP'
  | 'INTERPRET_MODEL_RESULT'
  | 'EXECUTE_TOOL'
  | 'REQUEST_APPROVAL'
  | 'WAIT_FOR_SIGNAL'
  | 'BUDGET_CHECK'
  | 'FINALIZE'
  | 'COMMIT_RESULT'
  | 'FAILED'
  | 'CANCELLED';

export type TerminalIntent = 'FINALIZE' | 'FAILED' | 'CANCELLED' | undefined;

export interface BudgetReservations {
  modelCalls: number;
  toolCalls: number;
  tokens: number;
  costCents: number;
  recursionDepth: number;
}

export interface KernelState {
  // Identity and scope — 756-770
  runId: RunId;
  organizationId: OrganizationId;
  conversationId: ConversationId;
  agentVersionId: AgentVersionId;
  policyVersionId: PolicyVersionId;

  // Current step
  status: AgentRunStatus;
  stepId: StepId;
  attempt: number;

  // Loop counters and budgets
  budgets: BudgetReservations;
  loopCounters: {
    modelCalls: number;
    toolCalls: number;
    turns: number;
  };

  // Last outcomes (refs, not full content)
  lastModelOutcomeRef?: { stepId: StepId; toolCallCount: number; finishReason: string } | undefined;
  lastToolOutcomeRef?: { stepId: StepId; toolId: string; success: boolean } | undefined;

  // Pending
  pendingApprovalRef?: { approvalId: string; toolCallId: string; stepId: StepId } | undefined;
  pendingInputRef?: { signalId: string } | undefined;

  // Checkpoint / artifact refs (bounded)
  checkpointRef?: ArtifactId | undefined;
  artifactRefs: ArtifactId[];

  // Terminal
  terminalIntent: TerminalIntent;
  terminalReason?: string | undefined;

  // Cancellation
  cancelled: boolean;
}

export function createInitialState(params: {
  runId: RunId;
  organizationId: OrganizationId;
  conversationId: ConversationId;
  agentVersionId: AgentVersionId;
  policyVersionId: PolicyVersionId;
  stepId: StepId;
}): KernelState {
  return {
    runId: params.runId,
    organizationId: params.organizationId,
    conversationId: params.conversationId,
    agentVersionId: params.agentVersionId,
    policyVersionId: params.policyVersionId,
    status: 'ADMISSION',
    stepId: params.stepId,
    attempt: 1,
    budgets: { modelCalls: 0, toolCalls: 0, tokens: 0, costCents: 0, recursionDepth: 0 },
    loopCounters: { modelCalls: 0, toolCalls: 0, turns: 0 },
    artifactRefs: [],
    terminalIntent: undefined,
    cancelled: false,
  };
}

export function isTerminal(status: AgentRunStatus): boolean {
  return status === 'COMMIT_RESULT' || status === 'FAILED' || status === 'CANCELLED';
}
