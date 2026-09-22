/**
 * budgets.ts — pure budget counters and reservations
 * Source: agent_studio_architecture.md:338-351, agent_studio_implementation_plan.md:773-783
 * All limits are bounded; exhaustion is deterministic error.
 */

import { StudioError } from './errors.js';

export interface BudgetLimits {
  maxModelCalls: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxTokenBudget: number;
  maxCostCents: number;
  maxRecursionDepth: number;
  maxTurns?: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxModelCalls: 8,
  maxToolCalls: 8,
  maxWallClockMs: 120_000,
  maxTokenBudget: 50_000,
  maxCostCents: 1000,
  maxRecursionDepth: 5,
  maxTurns: 16,
};

export interface BudgetUsage {
  modelCalls: number;
  toolCalls: number;
  tokens: number;
  costCents: number;
  recursionDepth: number;
  turns: number;
  wallClockMs: number;
}

export function createInitialUsage(): BudgetUsage {
  return {
    modelCalls: 0,
    toolCalls: 0,
    tokens: 0,
    costCents: 0,
    recursionDepth: 0,
    turns: 0,
    wallClockMs: 0,
  };
}

export type BudgetCheckResult =
  { ok: true } | { ok: false; exhausted: string; limit: number; used: number };

export function checkBudgets(usage: BudgetUsage, limits: BudgetLimits): BudgetCheckResult {
  if (usage.modelCalls > limits.maxModelCalls) {
    return {
      ok: false,
      exhausted: 'maxModelCalls',
      limit: limits.maxModelCalls,
      used: usage.modelCalls,
    };
  }
  if (usage.toolCalls > limits.maxToolCalls) {
    return {
      ok: false,
      exhausted: 'maxToolCalls',
      limit: limits.maxToolCalls,
      used: usage.toolCalls,
    };
  }
  if (usage.tokens > limits.maxTokenBudget) {
    return {
      ok: false,
      exhausted: 'maxTokenBudget',
      limit: limits.maxTokenBudget,
      used: usage.tokens,
    };
  }
  if (usage.costCents > limits.maxCostCents) {
    return {
      ok: false,
      exhausted: 'maxCostCents',
      limit: limits.maxCostCents,
      used: usage.costCents,
    };
  }
  if (usage.recursionDepth > limits.maxRecursionDepth) {
    return {
      ok: false,
      exhausted: 'maxRecursionDepth',
      limit: limits.maxRecursionDepth,
      used: usage.recursionDepth,
    };
  }
  if (usage.wallClockMs > limits.maxWallClockMs) {
    return {
      ok: false,
      exhausted: 'maxWallClockMs',
      limit: limits.maxWallClockMs,
      used: usage.wallClockMs,
    };
  }
  if (limits.maxTurns !== undefined && usage.turns > limits.maxTurns) {
    return { ok: false, exhausted: 'maxTurns', limit: limits.maxTurns, used: usage.turns };
  }
  return { ok: true };
}

export function assertBudgets(usage: BudgetUsage, limits: BudgetLimits): void {
  const res = checkBudgets(usage, limits);
  if (!res.ok) {
    throw new StudioError({
      code: 'BUDGET_EXHAUSTED',
      message: `budget exhausted: ${res.exhausted} limit ${res.limit} used ${res.used}`,
      retryable: 'non-retryable',
      details: { exhausted: res.exhausted, limit: res.limit, used: res.used },
    });
  }
}

function assertFiniteNonNegative(kind: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new StudioError({
      code: 'INTERNAL',
      message: `budget reservation for ${kind} must be a finite non-negative number, got ${String(value)}`,
      retryable: 'non-retryable',
      details: { kind, value },
    });
  }
}

export function reserveModelCall(usage: BudgetUsage): BudgetUsage {
  assertFiniteNonNegative('modelCalls', usage.modelCalls);
  return { ...usage, modelCalls: usage.modelCalls + 1, turns: usage.turns + 1 };
}

export function reserveToolCall(usage: BudgetUsage): BudgetUsage {
  assertFiniteNonNegative('toolCalls', usage.toolCalls);
  return { ...usage, toolCalls: usage.toolCalls + 1 };
}

export function reserveTokens(usage: BudgetUsage, tokens: number): BudgetUsage {
  assertFiniteNonNegative('tokens', tokens);
  return { ...usage, tokens: usage.tokens + tokens };
}

export function reserveCost(usage: BudgetUsage, cents: number): BudgetUsage {
  assertFiniteNonNegative('costCents', cents);
  return { ...usage, costCents: usage.costCents + cents };
}
