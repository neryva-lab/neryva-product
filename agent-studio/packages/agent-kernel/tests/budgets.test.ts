/**
 * budgets.test.ts — budget exhaustion deterministic
 * Source: agent_studio_architecture.md:338-351, ledger.md:1.8
 */

import { describe, it, expect } from 'vitest';
import {
  checkBudgets,
  createInitialUsage,
  DEFAULT_BUDGET_LIMITS,
  reserveModelCall,
} from '../src/budgets.js';

describe('budgets', () => {
  it('default limits are bounded', () => {
    expect(DEFAULT_BUDGET_LIMITS.maxModelCalls).toBeGreaterThan(0);
    expect(DEFAULT_BUDGET_LIMITS.maxToolCalls).toBeGreaterThan(0);
    expect(DEFAULT_BUDGET_LIMITS.maxRecursionDepth).toBeLessThanOrEqual(16);
  });

  it('checkBudgets passes when within limits', () => {
    const usage = createInitialUsage();
    expect(checkBudgets(usage, DEFAULT_BUDGET_LIMITS).ok).toBe(true);
  });

  it('exhaustion is deterministic', () => {
    const usage = { ...createInitialUsage(), modelCalls: 100 };
    const res = checkBudgets(usage, DEFAULT_BUDGET_LIMITS);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.exhausted).toBe('maxModelCalls');
      expect(res.limit).toBe(DEFAULT_BUDGET_LIMITS.maxModelCalls);
    }
    // Same input → same result
    const res2 = checkBudgets(usage, DEFAULT_BUDGET_LIMITS);
    expect(res2).toEqual(res);
  });

  it('reserveModelCall increments deterministically', () => {
    let usage = createInitialUsage();
    usage = reserveModelCall(usage);
    usage = reserveModelCall(usage);
    expect(usage.modelCalls).toBe(2);
    expect(usage.turns).toBe(2);
  });

  it('token budget exhaustion', () => {
    const usage = { ...createInitialUsage(), tokens: 100_000 };
    const res = checkBudgets(usage, { ...DEFAULT_BUDGET_LIMITS, maxTokenBudget: 50_000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.exhausted).toBe('maxTokenBudget');
  });
});
