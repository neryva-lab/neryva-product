/**
 * token-budget.ts — token counting and budgeting (pure, deterministic)
 * Source: agent_studio_architecture.md:466, agent_studio_implementation_plan.md:935-956
 * Simple heuristic: ~4 chars per token (English). Pluggable counter for tests.
 * Never let truncation remove system/policy constraints without safe failure (960).
 */

export interface TokenBudget {
  maxTokens: number;
  reservedForOutput: number;
  used: number;
  remaining: number;
}

export function countTokensHeuristic(text: string): number {
  // ~4 chars per token, plus overhead for role markers
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4) + 2; // +2 for role/message overhead
}

export function createBudget(maxTokens: number, reservedForOutput = 4096): TokenBudget {
  return {
    maxTokens,
    reservedForOutput,
    used: 0,
    remaining: maxTokens - reservedForOutput,
  };
}

export function reserve(budget: TokenBudget, tokens: number): TokenBudget {
  const used = budget.used + tokens;
  return {
    ...budget,
    used,
    remaining: budget.maxTokens - budget.reservedForOutput - used,
  };
}

export function canFit(budget: TokenBudget, tokens: number): boolean {
  return tokens <= budget.remaining;
}

export function mustTruncate(budget: TokenBudget): boolean {
  return budget.remaining < 0;
}

// For diagnostics: track what was omitted due to budget
export interface BudgetDiagnostics {
  maxTokens: number;
  reservedForOutput: number;
  used: number;
  remaining: number;
  wouldExceedBy?: number | undefined;
}

export function toDiagnostics(budget: TokenBudget): BudgetDiagnostics {
  return {
    maxTokens: budget.maxTokens,
    reservedForOutput: budget.reservedForOutput,
    used: budget.used,
    remaining: budget.remaining,
    wouldExceedBy: budget.remaining < 0 ? -budget.remaining : undefined,
  };
}
