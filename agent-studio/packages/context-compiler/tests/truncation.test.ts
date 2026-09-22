/**
 * truncation.test.ts — deterministic truncation, never remove system/policy without safe failure
 * Source: ledger 5.3, agent_studio_architecture.md:474, 960
 */

import { describe, it, expect } from 'vitest';
import { truncate } from '../src/truncation.js';
import { countTokensHeuristic } from '../src/token-budget.js';
import type { HistoryMessage } from '../src/context-inputs.js';

describe('truncation', () => {
  it('fits without truncation when budget large', () => {
    const input = {
      system: 'system',
      policy: 'policy',
      history: [
        {
          messageId: 'm1',
          organizationId: 'org1',
          conversationId: 'conv1',
          sequence: 1,
          role: 'user' as const,
          content: 'hi',
          createdAt: new Date().toISOString(),
        },
      ],
      summaries: [],
      memories: [],
      knowledge: [],
      userMessage: 'hello',
    };
    const res = truncate(input, { maxTokens: 1000, countTokens: countTokensHeuristic });
    expect('error' in res).toBe(false);
    if (!('error' in res)) expect(res.omitted.history.length).toBe(0);
  });

  it('truncates oldest history first deterministically', () => {
    const history: HistoryMessage[] = Array.from({ length: 5 }, (_, i) => ({
      messageId: `m${i}`,
      organizationId: 'org1',
      conversationId: 'conv1',
      sequence: i + 1,
      role: 'user' as const,
      content: 'x'.repeat(500),
      createdAt: new Date().toISOString(),
    }));
    const input = {
      system: 's',
      policy: 'p',
      history,
      summaries: [],
      memories: [],
      knowledge: [],
      userMessage: 'u',
    };
    const res = truncate(input, { maxTokens: 200, countTokens: countTokensHeuristic });
    expect('error' in res).toBe(false);
    if (!('error' in res)) {
      // Oldest removed first
      expect(res.omitted.history[0]?.sequence).toBe(1);
      expect(res.truncated.history[0]?.sequence).toBeGreaterThan(1);
    }
  });

  it('fails safe when mandatory (system+policy+user) exceeds budget — InsufficientContext', () => {
    const input = {
      system: 'x'.repeat(5000),
      policy: 'y'.repeat(5000),
      history: [],
      summaries: [],
      memories: [],
      knowledge: [],
      userMessage: 'z'.repeat(5000),
    };
    const res = truncate(input, { maxTokens: 10, countTokens: countTokensHeuristic });
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toBe('InsufficientContext');
  });

  it('never removes system/policy without safe failure', () => {
    const input = {
      system: 'system must stay',
      policy: 'policy must stay',
      history: Array.from({ length: 10 }, (_, i) => ({
        messageId: `m${i}`,
        organizationId: 'org1',
        conversationId: 'conv1',
        sequence: i,
        role: 'user' as const,
        content: 'content ' + i,
        createdAt: new Date().toISOString(),
      })),
      summaries: [],
      memories: [],
      knowledge: [],
      userMessage: 'user',
    };
    const res = truncate(input, { maxTokens: 50, countTokens: countTokensHeuristic });
    if (!('error' in res)) {
      expect(res.truncated.system).toBe('system must stay');
      expect(res.truncated.policy).toBe('policy must stay');
    } else {
      expect(res.error).toBe('InsufficientContext');
    }
  });
});
