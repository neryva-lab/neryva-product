/**
 * terminal-failure.test.ts — A2-68: the workflow catch-all must unwrap the
 * Temporal failure chain so the terminal run event/row names the real cause
 * instead of the generic "Activity task failed".
 */
import { describe, it, expect } from 'vitest';
import { classifyTerminalFailure } from '../src/terminal-failure.js';

/** Mimic Temporal's wire shape: ActivityFailure → ApplicationFailure. */
function activityFailure(root: Error): Error {
  const activity = new Error('Activity task failed');
  activity.name = 'ActivityFailure';
  (activity as { cause?: unknown }).cause = root;
  return activity;
}

function applicationFailure(type: string, message: string): Error {
  const app = new Error(message);
  app.name = 'ApplicationFailure';
  (app as { type?: unknown }).type = type;
  return app;
}

describe('classifyTerminalFailure', () => {
  it('names the denied tool when the model proposes an unavailable tool', () => {
    const root = applicationFailure(
      'NeryvaProviderError',
      "Model tried to call unavailable tool 'create_ticket'. Available tools: search_tickets.",
    );
    const out = classifyTerminalFailure(activityFailure(root));
    expect(out.code).toBe('TOOL_POLICY_DENIED');
    expect(out.message).toBe('tool policy denied: create_ticket');
  });

  it('keeps a stable code for other provider failures with the root message', () => {
    const root = applicationFailure('NeryvaProviderError', 'rate limited by provider');
    const out = classifyTerminalFailure(activityFailure(root));
    expect(out.code).toBe('PROVIDER_ERROR');
    expect(out.message).toBe('rate limited by provider');
  });

  it('falls back to FAILED with the deepest message for untyped errors', () => {
    const out = classifyTerminalFailure(activityFailure(new Error('boom')));
    expect(out.code).toBe('FAILED');
    expect(out.message).toBe('boom');
  });

  it('handles a bare non-wrapped error', () => {
    const out = classifyTerminalFailure(new Error('BUDGET_EXHAUSTED:maxTurns'));
    expect(out.code).toBe('FAILED');
    expect(out.message).toBe('BUDGET_EXHAUSTED:maxTurns');
  });

  it('handles non-error input without throwing', () => {
    const out = classifyTerminalFailure('string failure');
    expect(out.code).toBe('FAILED');
    expect(out.message).toBe('string failure');
  });
});
