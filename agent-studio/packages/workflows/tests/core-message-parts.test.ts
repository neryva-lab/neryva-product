/**
 * core-message-parts.test.ts — Wave 4 regression: the workflow's accumulated
 * conversation history must be valid AI SDK CoreMessages.
 *
 * Root cause of the 2026-09-22 smoke failure: after the first tool turn the
 * workflow pushed `{ role: 'tool', content: <JSON string> }` (and a JSON-string
 * assistant tool-call blob). `generateText` validates every message against
 * `coreMessageSchema` and rejects the whole prompt with
 * "Invalid prompt: message must be a CoreMessage or a UI message" — so every
 * multi-turn tool run died on turn 2 with `NeryvaProviderError: Invalid prompt`.
 *
 * These tests validate the real message builders against the REAL AI SDK
 * `coreMessageSchema` (not a re-implementation), so SDK upgrades that change
 * the accepted shape fail loudly here instead of in production.
 */
import { describe, expect, it } from 'vitest';
// The workflow-determinism lint block forbids provider SDKs in
// packages/workflows/** — including tests. This test's entire purpose is
// validating the workflow's message builders against the REAL AI SDK
// coreMessageSchema (not a re-implementation), so it is the one deliberate
// exception. Determinism is unaffected: this import runs in the test
// process, never inside a workflow execution.
// eslint-disable-next-line no-restricted-imports
import { coreMessageSchema } from 'ai';
import {
  buildAssistantHistoryMessage,
  buildToolResultHistoryMessage,
} from '../src/index.js';

function assertCoreMessages(messages: unknown[]): void {
  const parsed = coreMessageSchema.array().safeParse(messages);
  expect(
    parsed.success,
    parsed.success ? '' : `not valid CoreMessages: ${parsed.error.message}`,
  ).toBe(true);
}

describe('buildAssistantHistoryMessage', () => {
  it('builds a plain text assistant message for non-tool turns', () => {
    const m = buildAssistantHistoryMessage('hello', undefined);
    expect(m).toEqual({ role: 'assistant', content: 'hello' });
    assertCoreMessages([m]);
  });

  it('builds tool-call parts (not a JSON string) for tool proposal turns', () => {
    const m = buildAssistantHistoryMessage(undefined, [
      { id: 'call_1', name: 'search_tickets', args: { query: 'smoke' } },
      { id: 'call_2', name: 'create_ticket', args: { title: 't' } },
    ]);
    expect(m.role).toBe('assistant');
    expect(m.content).toEqual([
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'search_tickets', args: { query: 'smoke' } },
      { type: 'tool-call', toolCallId: 'call_2', toolName: 'create_ticket', args: { title: 't' } },
    ]);
    assertCoreMessages([m]);
  });

  it('keeps accompanying text as a leading text part', () => {
    const m = buildAssistantHistoryMessage('working on it', [
      { id: 'call_1', name: 'search_tickets', args: {} },
    ]);
    expect(m.content).toEqual([
      { type: 'text', text: 'working on it' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'search_tickets', args: {} },
    ]);
    assertCoreMessages([m]);
  });

  it('does not fall back to the legacy JSON-string tool-call blob', () => {
    // The pre-fix representation serialized tool calls as a JSON string in
    // the assistant message. That shape *validates* (string content is
    // legal) but is semantically lossy — the next model turn cannot see real
    // tool calls, and the fake/real provider tool-call parsing breaks. The
    // builder must always emit structured parts for tool proposals.
    const m = buildAssistantHistoryMessage(undefined, [
      { id: 'call_1', name: 'search_tickets', args: {} },
    ]);
    expect(typeof m.content).not.toBe('string');
    expect(Array.isArray(m.content)).toBe(true);
  });
});

describe('buildToolResultHistoryMessage', () => {
  it('builds tool-result parts for executed tools', () => {
    const m = buildToolResultHistoryMessage([
      { tool_call_id: 'call_1', tool: 'search_tickets', status: 'EXECUTED', result: { tickets: [] } },
    ]);
    expect(m.role).toBe('tool');
    expect(m.content).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'search_tickets',
        result: { tickets: [] },
      },
    ]);
    assertCoreMessages([m]);
  });

  it('marks non-executed outcomes as errors', () => {
    const m = buildToolResultHistoryMessage([
      { tool_call_id: 'call_9', tool: 'create_ticket', status: 'DENIED', result: { reason: 'no' } },
      { tool_call_id: 'call_10', tool: 'x', status: 'FAILED', result: null },
    ]);
    expect(m.content).toEqual([
      { type: 'tool-result', toolCallId: 'call_9', toolName: 'create_ticket', result: { reason: 'no' }, isError: true },
      { type: 'tool-result', toolCallId: 'call_10', toolName: 'x', result: null, isError: true },
    ]);
    assertCoreMessages([m]);
  });

  it('rejects the legacy string-content tool message shape', () => {
    // The pre-fix representation — must NOT validate.
    const legacy = { role: 'tool', content: '[{"tool_call_id":"call_1"}]' };
    const parsed = coreMessageSchema.safeParse(legacy);
    expect(parsed.success).toBe(false);
  });

  it('truncates unbounded tool results instead of blowing up the prompt', () => {
    const big = { blob: 'x'.repeat(10_000) };
    const m = buildToolResultHistoryMessage([
      { tool_call_id: 'call_1', tool: 'search_tickets', status: 'EXECUTED', result: big },
    ]);
    assertCoreMessages([m]);
    const part = (m.content as Array<{ result: unknown }>)[0];
    expect(typeof part.result).toBe('string');
    expect((part.result as string)).toContain('[truncated]');
    expect((part.result as string).length).toBeLessThan(10_000);
  });
});

describe('multi-turn conversation history', () => {
  it('a full two-turn tool history validates as CoreMessages', () => {
    // Mirrors the smoke: system + user, assistant tool proposal, tool result.
    const history = [
      { role: 'system', content: 'You are the wave-4 smoke assistant.' },
      { role: 'user', content: 'Find my open support tickets.' },
      buildAssistantHistoryMessage(undefined, [
        { id: 'call_1', name: 'search_tickets', args: { query: 'smoke' } },
      ]),
      buildToolResultHistoryMessage([
        { tool_call_id: 'call_1', tool: 'search_tickets', status: 'EXECUTED', result: { tickets: [] } },
      ]),
    ];
    assertCoreMessages(history);
  });
});
