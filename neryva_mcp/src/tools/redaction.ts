/**
 * Redaction — ensure sensitive args never appear in logs/traces/Temporal history/frontend.
 * Reference: neryva_mcp_implementation_plan.md:122-123, 595, 992-1004
 */

import { getToolDescriptor } from "./registry.js";

export function redactArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const desc = getToolDescriptor(toolName);
  if (!desc) return { redacted: true };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (desc.redactedFields.includes(k) || k.toLowerCase().includes("secret") || k.toLowerCase().includes("api_key") || k.toLowerCase().includes("password")) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function safeLogEntry(toolName: string, args: Record<string, unknown>, result?: unknown): string {
  const redacted = redactArgs(toolName, args);
  const entry = {
    tool: toolName,
    args: redacted,
    result: result ? "[DIGEST_ONLY]" : undefined,
    ts: new Date().toISOString(),
  };
  const json = JSON.stringify(entry);
  // Assert no raw secret leaks
  if (/\b(api_key|password|secret)\b/i.test(json) && !json.includes("[REDACTED]")) {
    throw new Error("redaction failure: secret leaked to log");
  }
  return json;
}
