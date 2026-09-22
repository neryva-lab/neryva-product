/**
 * traces.ts — span hierarchy + W3C propagation
 * Source: agent_studio_implementation_plan.md:1137-1162 (span hierarchy 1139-1150),
 * W3C context propagation across MCP/Temporal/provider/tool/broker, low-cardinality attrs + run/correlation refs where policy permits
 * Hierarchy: Engine/MCP request → Agent Studio workflow run → context compilation → model call → provider request → tool call → external request → approval wait → finalization
 */
import { trace, context, propagation, type Span, SpanStatusCode } from '@opentelemetry/api';
import { buildCorrelationAttributes, type CorrelationContext } from './attributes.js';
import { redactAttributes } from './redaction.js';

export type SpanKind =
  | 'workflow'
  | 'context'
  | 'model'
  | 'provider'
  | 'tool'
  | 'external'
  | 'approval'
  | 'finalization'
  | 'mcp'
  | 'temporal';

export interface SpanOptions {
  kind: SpanKind;
  name: string;
  correlation: CorrelationContext;
  attributes?: Record<string, unknown> | undefined;
  parentContext?: ReturnType<typeof context.active> | undefined;
}

const tracer = trace.getTracer('neryva-agent-studio', '0.1.0');

export function startSpan(opts: SpanOptions): Span {
  const attrs = {
    ...buildCorrelationAttributes(opts.correlation),
    ...(opts.attributes ?? {}),
  };
  const redacted = redactAttributes(attrs as Record<string, unknown>);
  const span = tracer.startSpan(`${opts.kind}:${opts.name}`, {
    attributes: redacted as Record<string, string>,
  });
  return span;
}

export function endSpan(span: Span, error?: Error | undefined): void {
  if (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}

export function withSpan<T>(opts: SpanOptions, fn: (span: Span) => Promise<T> | T): Promise<T> {
  const span = startSpan(opts);
  const ctx = trace.setSpan(context.active(), span);
  return context.with(ctx, async () => {
    try {
      const res = await fn(span);
      endSpan(span);
      return res;
    } catch (e) {
      endSpan(span, e as Error);
      throw e;
    }
  });
}

export function injectTraceContext(carrier: Record<string, string>): void {
  propagation.inject(context.active(), carrier);
}

export function extractTraceContext(
  carrier: Record<string, string>,
): ReturnType<typeof context.active> {
  return propagation.extract(context.active(), carrier);
}

export function getCurrentTraceIds(): { traceId: string; spanId: string } | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  if (!ctx.traceId || ctx.traceId === '00000000000000000000000000000000') return undefined;
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}
