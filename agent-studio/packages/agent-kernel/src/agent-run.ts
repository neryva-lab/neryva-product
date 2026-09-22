/**
 * agent-run.ts — pure AgentRun simulation for bounded read-only runs
 * Source: agent_studio_implementation_plan.md:736-754, ledger.md:1.1
 * No network, no Temporal, no provider SDKs. Deterministic.
 */

import { createInitialState, type KernelState } from './state.js';
import { transition, type KernelEvent } from './transitions.js';
import { deriveStepId } from './step-id.js';
import {
  checkBudgets,
  type BudgetLimits,
  type BudgetUsage,
  DEFAULT_BUDGET_LIMITS,
} from './budgets.js';
import type {
  AgentVersionId,
  ConversationId,
  OrganizationId,
  PolicyVersionId,
  RunId,
} from './state.js';

export interface AgentRunParams {
  runId: RunId;
  organizationId: OrganizationId;
  conversationId: ConversationId;
  agentVersionId: AgentVersionId;
  policyVersionId: PolicyVersionId;
  workflowGeneration?: number;
  limits?: Partial<BudgetLimits>;
}

export class AgentRun {
  private state: KernelState;
  private readonly generation: number;
  private readonly limits: BudgetLimits;
  private usage: BudgetUsage;

  constructor(params: AgentRunParams) {
    this.generation = params.workflowGeneration ?? 1;
    this.limits = { ...DEFAULT_BUDGET_LIMITS, ...params.limits };
    this.usage = {
      modelCalls: 0,
      toolCalls: 0,
      tokens: 0,
      costCents: 0,
      recursionDepth: 0,
      turns: 0,
      wallClockMs: 0,
    };
    const stepId = deriveStepId({
      runId: params.runId,
      workflowGeneration: this.generation,
      stepPath: 'admission',
    });
    this.state = createInitialState({
      runId: params.runId,
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      agentVersionId: params.agentVersionId,
      policyVersionId: params.policyVersionId,
      stepId,
    });
  }

  getState(): KernelState {
    return this.state;
  }

  getLimits(): BudgetLimits {
    return this.limits;
  }

  getUsage(): BudgetUsage {
    return this.usage;
  }

  private nextStep(path: string): string {
    return deriveStepId({
      runId: this.state.runId,
      workflowGeneration: this.generation,
      stepPath: path,
    });
  }

  apply(event: KernelEvent): KernelState {
    if (event.type === 'MODEL_COMPLETED') {
      const nextUsage: BudgetUsage = {
        ...this.usage,
        modelCalls: this.usage.modelCalls + 1,
        turns: this.usage.turns + 1,
      };
      const check = checkBudgets(nextUsage, this.limits);
      if (!check.ok) {
        const exhaustedEvent: KernelEvent = { type: 'BUDGET_EXHAUSTED', budget: check.exhausted };
        const next = transition(
          this.state,
          exhaustedEvent,
          this.nextStep(`budget-exhausted/${check.exhausted}`),
        );
        this.state = next;
        return next;
      }
      this.usage = nextUsage;
    }
    if (event.type === 'TOOL_COMPLETED') {
      const nextUsage: BudgetUsage = { ...this.usage, toolCalls: this.usage.toolCalls + 1 };
      const check = checkBudgets(nextUsage, this.limits);
      if (!check.ok) {
        const exhaustedEvent: KernelEvent = { type: 'BUDGET_EXHAUSTED', budget: check.exhausted };
        const next = transition(
          this.state,
          exhaustedEvent,
          this.nextStep(`budget-exhausted/${check.exhausted}`),
        );
        this.state = next;
        return next;
      }
      this.usage = nextUsage;
    }

    let nextStepId: string | undefined;
    if (event.type === 'ADMITTED') nextStepId = this.nextStep('load-context');
    else if (event.type === 'CONTEXT_LOADED') nextStepId = this.nextStep('policy-check');
    else if (event.type === 'POLICY_PASSED') nextStepId = this.nextStep('model/1');
    else if (event.type === 'MODEL_COMPLETED') nextStepId = this.nextStep('interpret');
    else if (event.type === 'INTERPRET_FINAL_ANSWER') nextStepId = this.nextStep('finalize');
    else if (event.type === 'INTERPRET_READ_ONLY_TOOL')
      nextStepId = this.nextStep(`tool/${event.toolId}`);
    else if (event.type === 'INTERPRET_EFFECTFUL_TOOL')
      nextStepId = this.nextStep(`approval/${event.toolId}`);
    else if (event.type === 'TOOL_COMPLETED') nextStepId = this.nextStep('model/next');
    else if (event.type === 'FINALIZE') nextStepId = this.nextStep('commit');

    const next = transition(this.state, event, nextStepId);
    this.state = next;
    return next;
  }

  /**
   * Simulate a bounded read-only run without network.
   * ADMISSION → LOAD_CONTEXT → POLICY_CHECK → MODEL_STEP (stop) → INTERPRET_FINAL_ANSWER → FINALIZE → COMMIT_RESULT
   */
  simulateReadOnlyRun(): KernelState {
    this.apply({ type: 'ADMITTED' });
    this.apply({ type: 'CONTEXT_LOADED' });
    this.apply({ type: 'POLICY_PASSED' });
    this.apply({ type: 'MODEL_COMPLETED', finishReason: 'stop', toolCallCount: 0 });
    this.apply({ type: 'INTERPRET_FINAL_ANSWER' });
    this.apply({ type: 'FINALIZE' });
    return this.state;
  }

  /**
   * Simulate a read-only tool loop: model proposes tool, gateway executes, back to model, then finalize.
   */
  simulateToolLoop(toolId: string): KernelState {
    this.apply({ type: 'ADMITTED' });
    this.apply({ type: 'CONTEXT_LOADED' });
    this.apply({ type: 'POLICY_PASSED' });
    this.apply({ type: 'MODEL_COMPLETED', finishReason: 'tool-call', toolCallCount: 1 });
    this.apply({ type: 'INTERPRET_READ_ONLY_TOOL', toolId });
    this.apply({ type: 'TOOL_COMPLETED', toolId, success: true });
    this.apply({ type: 'MODEL_COMPLETED', finishReason: 'stop', toolCallCount: 0 });
    this.apply({ type: 'INTERPRET_FINAL_ANSWER' });
    this.apply({ type: 'FINALIZE' });
    return this.state;
  }
}
