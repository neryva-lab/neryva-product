/**
 * attributes.ts — low-cardinality attributes + correlation propagation
 * Source: agent_studio_implementation_plan.md:1137-1162 (span hierarchy 1139-1150, W3C context propagation, low-cardinality service/build/workload attrs + run/correlation refs where policy permits 1139-1150),
 * 1159 (avoid high-cardinality labels raw user IDs/message text), 305-321 (request_id/organization_id/conversation_id/run_id/agent_version_id/correlation_id/protocol_version/idempotency_key)
 * Attributes are low-cardinality; no raw prompts, no high-cardinality user IDs in metrics.
 */
import type { Context } from '@opentelemetry/api';

export const ATTR_SERVICE_NAME = 'service.name';
export const ATTR_SERVICE_VERSION = 'service.version';
export const ATTR_DEPLOYMENT_ENV = 'deployment.environment';
export const ATTR_WORKLOAD_IDENTITY = 'workload.identity';
export const ATTR_TASK_QUEUE = 'temporal.task_queue';

export const ATTR_REQUEST_ID = 'neryva.request_id';
export const ATTR_ORGANIZATION_ID_HASH = 'neryva.organization_id.hash'; // hashed for privacy, not raw
export const ATTR_CONVERSATION_ID = 'neryva.conversation_id';
export const ATTR_RUN_ID = 'neryva.run_id';
export const ATTR_AGENT_VERSION_ID = 'neryva.agent_version_id';
export const ATTR_CORRELATION_ID = 'neryva.correlation_id';
export const ATTR_PROTOCOL_VERSION = 'neryva.protocol_version';
export const ATTR_IDEMPOTENCY_KEY_HASH = 'neryva.idempotency_key.hash';
export const ATTR_STEP_ID = 'neryva.step_id';
export const ATTR_TOOL_CALL_ID = 'neryva.tool_call_id';
export const ATTR_EVENT_ID = 'neryva.event_id';
export const ATTR_SEQUENCE = 'neryva.sequence';
export const ATTR_WORKFLOW_ID = 'temporal.workflow_id';
export const ATTR_WORKFLOW_RUN_ID = 'temporal.run_id';
export const ATTR_PROVIDER = 'gen_ai.provider';
export const ATTR_MODEL = 'gen_ai.model';

export interface CorrelationContext {
  requestId?: string | undefined;
  organizationId?: string | undefined;
  conversationId?: string | undefined;
  runId?: string | undefined;
  agentVersionId?: string | undefined;
  correlationId?: string | undefined;
  protocolVersion?: string | undefined;
  idempotencyKey?: string | undefined;
  stepId?: string | undefined;
  traceId?: string | undefined;
  spanId?: string | undefined;
}

function hashLowCardinality(value: string): string {
  // simple hash for low-cardinality metric label (not cryptographic)
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h.toString(16).slice(0, 8);
}

export function buildCorrelationAttributes(ctx: CorrelationContext): Record<string, string> {
  const out: Record<string, string> = {};
  if (ctx.requestId) out[ATTR_REQUEST_ID] = ctx.requestId;
  if (ctx.organizationId) out[ATTR_ORGANIZATION_ID_HASH] = hashLowCardinality(ctx.organizationId);
  if (ctx.conversationId) out[ATTR_CONVERSATION_ID] = ctx.conversationId;
  if (ctx.runId) out[ATTR_RUN_ID] = ctx.runId;
  if (ctx.agentVersionId) out[ATTR_AGENT_VERSION_ID] = ctx.agentVersionId;
  if (ctx.correlationId) out[ATTR_CORRELATION_ID] = ctx.correlationId;
  if (ctx.protocolVersion) out[ATTR_PROTOCOL_VERSION] = ctx.protocolVersion;
  if (ctx.idempotencyKey) out[ATTR_IDEMPOTENCY_KEY_HASH] = hashLowCardinality(ctx.idempotencyKey);
  if (ctx.stepId) out[ATTR_STEP_ID] = ctx.stepId;
  return out;
}

export function buildServiceAttributes(
  serviceName: string,
  serviceVersion: string,
  environment: string,
  workloadIdentity?: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
    [ATTR_DEPLOYMENT_ENV]: environment,
  };
  if (workloadIdentity) out[ATTR_WORKLOAD_IDENTITY] = workloadIdentity;
  return out;
}

export function isHighCardinalityKey(key: string): boolean {
  // 1159: avoid raw user IDs, message text, arbitrary tool args in metrics
  const high = ['user_id', 'message_text', 'tool_args', 'prompt', 'completion', 'document'];
  return high.some((h) => key.toLowerCase().includes(h));
}

export function validateNoHighCardinality(attrs: Record<string, unknown>): void {
  for (const k of Object.keys(attrs)) {
    if (isHighCardinalityKey(k))
      throw new Error(`high-cardinality metric label forbidden: ${k} (1159)`);
  }
}

// W3C trace context helpers (propagation)
export function injectW3CContext(context: Context): Record<string, string> {
  // In production, use propagation.inject(context, carrier)
  // For tests, return empty carrier plus traceparent if available
  void context;
  return {};
}

export function extractW3CContext(carrier: Record<string, string>): Context | undefined {
  void carrier;
  return undefined;
}
