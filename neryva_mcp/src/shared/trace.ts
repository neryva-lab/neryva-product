/**
 * W3C Trace Context propagation helpers.
 * Reference: neryva_mcp_implementation_plan.md:725-727, opentelemetry context propagation
 *
 * For Phase 0 spike we implement minimal traceparent handling without full OTel SDK.
 * Production: replace with @opentelemetry/api + propagation.
 */

export interface TraceContext {
  traceId: string; // 32 hex
  spanId: string; // 16 hex
  traceFlags: string; // 2 hex
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceParent(header: string | undefined): TraceContext | undefined {
  if (!header) return undefined;
  const m = TRACEPARENT_RE.exec(header.trim());
  if (!m) return undefined;
  return { traceId: m[1], spanId: m[2], traceFlags: m[3] };
}

export function formatTraceParent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`;
}

export function generateTraceContext(): TraceContext {
  // Node 24 crypto.randomUUID is available, but we need hex trace/span IDs
  // Use crypto.getRandomValues for 16 + 8 bytes.
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  const traceId = Array.from(buf.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  const spanId = Array.from(buf.subarray(16, 24), (b) => b.toString(16).padStart(2, "0")).join("");
  return { traceId, spanId, traceFlags: "01" };
}

/**
 * Connect header helper — reads traceparent from request headers,
 * generates if missing, returns context for downstream propagation.
 */
export function getOrCreateTraceContext(headers: Headers | Map<string, string> | Record<string, string>): TraceContext {
  let raw: string | undefined;
  if (headers instanceof Headers) raw = headers.get("traceparent") ?? undefined;
  else if (headers instanceof Map) raw = headers.get("traceparent");
  else raw = headers["traceparent"] ?? headers["Traceparent"];
  return parseTraceParent(raw) ?? generateTraceContext();
}
