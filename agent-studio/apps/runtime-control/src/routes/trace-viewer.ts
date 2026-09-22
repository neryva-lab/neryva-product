/**
 * trace-viewer.ts — redacted trace viewer (artifact IDs/hashes not raw prompts)
 * Source: 11.4 820, 1547 (artifact IDs/hashes not raw prompts; uses telemetry + Engine ListRunEvents), 1157 (approval-gated diagnostic mode)
 * Uses telemetry redaction + Engine ListRunEvents (via MCP) to show correlated run without exposing secrets.
 */
import { redactAttributes } from '@neryva/telemetry';

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  name: string;
  kind: string;
  startTime: string;
  endTime: string;
  attributes: Record<string, unknown>;
  status: 'OK' | 'ERROR';
}

export interface RedactedTrace {
  runId: string;
  correlationId: string;
  spans: TraceSpan[];
  artifactIds: string[];
  diagnosticMode: boolean;
}

export function toRedactedTrace(spans: TraceSpan[], diagnosticModeActive = false): RedactedTrace {
  const runId = (spans[0]?.attributes['neryva.run_id'] as string | undefined) ?? 'unknown';
  const correlationId =
    (spans[0]?.attributes['neryva.correlation_id'] as string | undefined) ?? 'unknown';
  const artifactIds: string[] = [];
  const redactedSpans = spans.map((s) => {
    const redactedAttrs = diagnosticModeActive
      ? s.attributes
      : redactAttributes(s.attributes as Record<string, unknown>);
    // Collect artifact IDs (hashes not raw)
    for (const [k, v] of Object.entries(redactedAttrs)) {
      if (k.includes('artifact') && typeof v === 'string') artifactIds.push(v);
      if (k === 'artifactId' && typeof v === 'string') artifactIds.push(v as string);
    }
    return { ...s, attributes: redactedAttrs };
  });
  return {
    runId,
    correlationId,
    spans: redactedSpans,
    artifactIds: [...new Set(artifactIds)],
    diagnosticMode: diagnosticModeActive,
  };
}

export function getRedactedAttributes(span: TraceSpan): Record<string, unknown> {
  return redactAttributes(span.attributes as Record<string, unknown>);
}
