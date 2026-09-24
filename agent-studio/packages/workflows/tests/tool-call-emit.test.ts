/**
 * tool-call-emit.test.ts — A3-21: the producer emits a toolCall run event at
 * tool invocation carrying the tool name, the model-assigned call id, and a
 * SANITIZED argument summary (never raw secrets/credentials).
 *
 * Pins:
 *  - summarizeToolArguments redacts sensitive fields (case/separator
 *    insensitive, same rule as the argumentDigest redaction) and truncates
 *    long values;
 *  - unsummarizable args yield an explicit {"withheld": ...} marker, never
 *    raw JSON;
 *  - buildToolCallEmit produces a ToolCallProposed event whose identity is
 *    the execution stepId (distinct invocations → distinct eventIds; retries
 *    → identical eventIds);
 *  - the event-mapper puts the summary on the wire as ToolCallBody.arguments
 *    (read by the console's parseRunEvent as value.arguments) with a REAL
 *    32-byte argumentDigest (the proto requires bytes.len = 32).
 */
import { describe, it, expect } from 'vitest';
import {
  buildToolCallEmit,
  summarizeToolArguments,
  MAX_TOOLCALL_ARGUMENT_SUMMARY_CHARS,
  type ToolCallEmit,
} from '../src/tool-call-events.js';
import {
  createRuntimeEvent,
  type RuntimeEvent,
} from '@neryva/contracts/events/runtime-events';
import { toMcpRunEvent } from '../../neryva-mcp-client/src/event-mapper.js';
import { EventType } from '@neryva/mcp-contract/gen/ts/neryva/mcp/event/v1/event_pb.js';

const RUN_ID = '01a0cb73-bf54-7471-bd12-9771ddc3f5b4';
const SCOPE = {
  organizationId: '28c165ea-69c4-4046-a10b-d801aa36d37d',
  conversationId: '01a0cb45-96a5-7e39-86e6-0907d3aa8e01',
  runId: RUN_ID,
  correlationId: RUN_ID,
} as const;

/** What the emitEvent activity does with the builder output (minus transport). */
function toRuntimeEvent(emit: ToolCallEmit): RuntimeEvent {
  return createRuntimeEvent(
    {
      runId: emit.scope.runId,
      organizationId: emit.scope.organizationId,
      conversationId: emit.scope.conversationId,
      stepId: emit.stepId,
      type: emit.type,
      producerId: 'test-producer',
      correlationId: emit.scope.correlationId,
    },
    emit.body,
  );
}

describe('summarizeToolArguments', () => {
  it('passes through ordinary args as JSON', () => {
    expect(summarizeToolArguments({ query: 'my tickets', limit: 10 })).toBe(
      JSON.stringify({ query: 'my tickets', limit: 10 }),
    );
  });

  it('redacts sensitive fields case- and separator-insensitively', () => {
    const summary = summarizeToolArguments({
      query: 'tickets',
      api_key: 'sk-secret-123',
      apiKey: 'sk-secret-456',
      'API-KEY': 'sk-secret-789',
      token: 'tok_abc',
      credential: { user: 'u', pass: 'p' },
      nested: { secret: 'shh' },
    });
    const parsed = JSON.parse(summary) as Record<string, unknown>;
    expect(parsed['query']).toBe('tickets');
    expect(parsed['api_key']).toBe('[REDACTED]');
    expect(parsed['apiKey']).toBe('[REDACTED]');
    expect(parsed['API-KEY']).toBe('[REDACTED]');
    expect(parsed['token']).toBe('[REDACTED]');
    expect(parsed['credential']).toBe('[REDACTED]');
    expect((parsed['nested'] as Record<string, unknown>)['secret']).toBe('[REDACTED]');
    expect(summary).not.toContain('sk-secret');
    expect(summary).not.toContain('tok_abc');
  });

  it('withholds oversized summaries instead of emitting raw JSON', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 500; i++) big[`field_${i}`] = 'x'.repeat(50);
    const summary = summarizeToolArguments(big);
    const parsed = JSON.parse(summary) as Record<string, unknown>;
    expect(parsed['withheld']).toContain('exceeded');
    expect(summary.length).toBeLessThanOrEqual(MAX_TOOLCALL_ARGUMENT_SUMMARY_CHARS);
  });

  it('withholds circular structures instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const summary = summarizeToolArguments(circular);
    expect(JSON.parse(summary)).toEqual({
      withheld: 'arguments withheld: could not be safely summarized',
    });
  });

  it('handles non-object args without leaking', () => {
    expect(summarizeToolArguments(null)).toBe('{}');
    expect(summarizeToolArguments('short')).toBe(JSON.stringify('short'));
    expect(summarizeToolArguments('x'.repeat(2000))).toBe(JSON.stringify('[TRUNCATED 2000B]'));
  });

  it('redacts credential-shaped VALUES regardless of the field name', () => {
    const summary = summarizeToolArguments({
      value: 'sk-' + 'K'.repeat(32),
      note: 'Bearer ' + 'K'.repeat(32),
      nested: { innocuous: 'xoxb-' + '1'.repeat(12) + '-' + '2'.repeat(12) },
      list: ['plain', 'AKIA' + 'K'.repeat(16)],
    });
    const parsed = JSON.parse(summary) as Record<string, unknown>;
    expect(parsed['value']).toBe('[REDACTED]');
    expect(parsed['note']).toBe('[REDACTED]');
    expect((parsed['nested'] as Record<string, unknown>)['innocuous']).toBe('[REDACTED]');
    expect((parsed['list'] as unknown[])[0]).toBe('plain');
    expect((parsed['list'] as unknown[])[1]).toBe('[REDACTED]');
    expect(summary).not.toContain('sk-');
    expect(summary).not.toContain('AKIA');
  });

  it('redacts every supported credential shape (OpenAI/AWS/GitHub/Slack/Bearer/JWT)', () => {
    // NOTE: fixtures are assembled at runtime (never as string literals) so
    // secret-scanning push protection cannot mistake these inert values for
    // real credentials. The 'K'-repeat bodies are obviously fake and match
    // only the SHAPE regexes in security.isCredentialShapedString.
    const shapes: Record<string, string> = {
      openai: 'sk-' + 'K'.repeat(32),
      aws: 'AKIA' + 'K'.repeat(16),
      github: 'ghp_' + 'K'.repeat(36),
      slack: 'xoxb-' + '1'.repeat(12) + '-' + '2'.repeat(12),
      bearer: 'Bearer ' + 'K'.repeat(32),
      jwt: 'eyJ' + 'K'.repeat(20) + '.' + 'K'.repeat(20) + '.sig',
    };
    for (const [kind, secret] of Object.entries(shapes)) {
      const summary = summarizeToolArguments({ innocuous_key: secret });
      expect(JSON.parse(summary)['innocuous_key'], kind).toBe('[REDACTED]');
      expect(summary, kind).not.toContain(secret);
    }
  });

  it('redacts a top-level credential-shaped string', () => {
    const summary = summarizeToolArguments('sk-' + 'K'.repeat(40));
    expect(JSON.parse(summary)).toBe('[REDACTED]');
  });

  it('withholds BigInt, functions, and non-finite numbers instead of leaking or throwing', () => {
    for (const bad of [
      { n: 10n as unknown },
      { fn: (() => 1) as unknown },
      { v: Number.NaN },
      { v: Number.POSITIVE_INFINITY },
    ]) {
      const summary = summarizeToolArguments(bad);
      expect(JSON.parse(summary)).toEqual({
        withheld: 'arguments withheld: could not be safely summarized',
      });
    }
  });

  it('bounds depth and collection sizes instead of exploding', () => {
    let deep: Record<string, unknown> = { leaf: 'ok' };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const deepSummary = summarizeToolArguments(deep);
    expect(deepSummary).toContain('[DEPTH-LIMITED]');
    expect(deepSummary.length).toBeLessThanOrEqual(MAX_TOOLCALL_ARGUMENT_SUMMARY_CHARS);

    const wide: Record<string, string> = {};
    for (let i = 0; i < 200; i++) wide[`k${i}`] = 'v';
    const wideSummary = summarizeToolArguments(wide);
    const wideParsed = JSON.parse(wideSummary) as Record<string, unknown>;
    expect(wideParsed['[TRUNCATED]']).toBe('150 more keys');
    expect(wideSummary.length).toBeLessThanOrEqual(MAX_TOOLCALL_ARGUMENT_SUMMARY_CHARS);
  });
});

describe('buildToolCallEmit', () => {
  const stepId = `${RUN_ID}#1#tool/search_tickets/1/r0`;

  it('builds a ToolCallProposed event with name, call id, and sanitized summary', () => {
    const emit = buildToolCallEmit({
      scope: { ...SCOPE },
      stepId,
      toolName: 'search_tickets',
      toolCallId: 'call_6383521c8c69933d',
      args: { query: 'my tickets', api_key: 'sk-should-not-appear' },
    });
    expect(emit.type).toBe('ToolCallProposed');
    expect(emit.stepId).toBe(stepId);
    expect(emit.body.kind).toBe('ToolCallProposed');
    if (emit.body.kind !== 'ToolCallProposed') throw new Error('narrow');
    expect(emit.body.toolName).toBe('search_tickets');
    expect(emit.body.toolCallId).toBe('call_6383521c8c69933d');
    const summary = JSON.parse(emit.body.argumentSummary) as Record<string, unknown>;
    expect(summary['query']).toBe('my tickets');
    expect(summary['api_key']).toBe('[REDACTED]');
    expect(emit.body.argumentSummary).not.toContain('sk-should-not-appear');
  });

  it('derives distinct eventIds per invocation, stable ids per retry', () => {
    const mk = (sid: string) =>
      toRuntimeEvent(
        buildToolCallEmit({
          scope: { ...SCOPE },
          stepId: sid,
          toolName: 'search_tickets',
          toolCallId: 'call_aaa',
          args: { query: 'x' },
        }),
      );
    const first = mk(`${RUN_ID}#1#tool/search_tickets/1/r0`);
    const second = mk(`${RUN_ID}#1#tool/search_tickets/2/r0`);
    const retry = mk(`${RUN_ID}#1#tool/search_tickets/1/r0`);
    expect(first.eventId).not.toBe(second.eventId);
    expect(first.eventId).toBe(retry.eventId);
    expect(first.idempotencyKey).toBe(retry.idempotencyKey);
  });
});

describe('toolCall wire mapping', () => {
  it('maps ToolCallProposed to TOOL_CALL with arguments + 32-byte digest', () => {
    const event = toRuntimeEvent(
      buildToolCallEmit({
        scope: { ...SCOPE },
        stepId: `${RUN_ID}#1#tool/search_tickets/1/r0`,
        toolName: 'search_tickets',
        toolCallId: 'call_6383521c8c69933d',
        args: { query: 'my tickets' },
      }),
    );
    const wire = toMcpRunEvent(event);
    expect(wire.type).toBe(EventType.TOOL_CALL);
    if (wire.body.case !== 'toolCall') throw new Error(`unexpected case ${wire.body.case}`);
    expect(wire.body.value.toolCallId).toBe('call_6383521c8c69933d');
    expect(wire.body.value.toolName).toBe('search_tickets');
    // The console's parseRunEvent reads value.arguments.
    expect(wire.body.value.arguments).toBe(JSON.stringify({ query: 'my tickets' }));
    // Proto requires bytes.len = 32 — the digest is real now, not empty.
    expect(wire.body.value.argumentDigest).toHaveLength(32);
  });
});
