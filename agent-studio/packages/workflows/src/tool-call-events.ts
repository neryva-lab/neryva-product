/**
 * tool-call-events.ts — durable-event params for executed tool calls.
 *
 * Regression for the Wave 4 smoke gap: the workflow's tool loop executed an
 * approved MUTATING call (create_ticket) and emitted its ToolCallCompleted,
 * but the event never reached durable storage — while the run still
 * COMPLETED, so the loss was silent.
 *
 * Root cause: executeOne emitted ToolCallCompleted WITHOUT the top-level
 * stepId, so createRuntimeEvent derived the idempotency key
 * `<runId>:ToolCallCompleted:none:0` — IDENTICAL for every tool call in the
 * run. The Engine's appendRunEvents dedups on (run_id, event_id) via
 * onConflictDoNothing, so the second toolResult was accepted as a
 * "duplicate" (HTTP 200, duplicate:true) and no row was written. Verified
 * against the smoke DB: the derived id `evt_01a0cb73_ej10eg` exactly matches
 * the first (search_tickets) toolResult row, and the create_ticket append
 * returned 200 with no row.
 *
 * Fix: the stepId IS the stable identity of the tool execution
 * (`<runId>#<gen>#tool/<name>/<turn>/<r|m><i>`) — pass it as the event's
 * top-level stepId so each completion derives a distinct eventId, while
 * retries of the same execution still derive the same id (idempotent).
 *
 * Pure + deterministic: safe to import from workflow code and to unit test.
 */
import type {
  EventType,
  RuntimeEventBody,
} from '@neryva/contracts/events/runtime-events';
// Deep import: @neryva/security's index re-exports capabilities/scope, which
// pull @neryva/agent-kernel's runtime (node:crypto via step-id) — forbidden in
// the deterministic Temporal workflow bundle. sensitive-data.ts is pure and
// dependency-free, so import the module file directly.
import {
  isCredentialShapedString,
  isSensitiveField,
} from '@neryva/security/dist/sensitive-data.js';

export interface ToolCallCompletedEmitScope {
  organizationId: string;
  conversationId: string;
  runId: string;
  correlationId: string;
}

export interface ToolCallCompletedEmitParams {
  scope: ToolCallCompletedEmitScope;
  /** Stable identity of the tool execution — MUST be the execution stepId. */
  stepId: string;
  toolName: string;
  toolCallId: string;
  success: boolean;
}

export interface ToolCallCompletedEmit {
  scope: ToolCallCompletedEmitScope;
  type: EventType;
  stepId: string;
  body: RuntimeEventBody;
}

/** Build the ToolCallCompleted emit params for one executed tool call. */
export function buildToolCallCompletedEmit(
  params: ToolCallCompletedEmitParams,
): ToolCallCompletedEmit {
  return {
    scope: params.scope,
    type: 'ToolCallCompleted',
    stepId: params.stepId,
    body: {
      kind: 'ToolCallCompleted',
      runId: params.scope.runId,
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      stepId: params.stepId,
      success: params.success,
    },
  };
}

/**
 * A3-21 — bound for the sanitized argument summary carried on the
 * ToolCallProposed event (mirrors ToolCallBody.arguments max_len = 2048).
 */
export const MAX_TOOLCALL_ARGUMENT_SUMMARY_CHARS = 2048;

/**
 * A3-21 — hard bounds for the recursive wire sanitizer. All deterministic;
 * the final JSON length gate (MAX_TOOLCALL_ARGUMENT_SUMMARY_CHARS) still
 * withholds anything that survives truncation but stays too large.
 */
const MAX_SANITIZE_DEPTH = 6;
const MAX_OBJECT_KEYS = 50;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_CHARS = 1000;

/**
 * Sentinel for "cannot be represented safely" — cyclic, BigInt, function,
 * symbol, or non-finite number. Never escapes this module; the caller maps
 * it to an explicit `{"withheld": ...}` marker.
 */
const UNSAFE: unique symbol = Symbol('toolCallArgsUnsafe');

/**
 * Recursively sanitize an arbitrary tool-argument value for the wire.
 *
 * - Sensitive FIELD names → '[REDACTED]' (case/separator-insensitive).
 * - Credential-SHAPED string values → '[REDACTED]', whatever the key —
 *   this is what field-name redaction alone misses (`{"value":"sk-..."}`).
 * - Strings longer than MAX_STRING_CHARS → '[TRUNCATED nB]'.
 * - Depth beyond MAX_SANITIZE_DEPTH → '[DEPTH-LIMITED]'.
 * - Objects/arrays larger than the key/item caps are truncated with an
 *   explicit marker (bounded output, no silent data loss of the head).
 * - Cyclic references, BigInt, functions, symbols, undefined, NaN and
 *   ±Infinity → UNSAFE (the whole summary is withheld, never partial-raw).
 *
 * Pure + deterministic: no I/O, no Date, no randomness. Safe in workflow
 * code and in unit tests.
 */
function sanitizeValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      if (isCredentialShapedString(value)) return '[REDACTED]';
      return value.length > MAX_STRING_CHARS ? `[TRUNCATED ${value.length}B]` : value;
    case 'number':
    case 'boolean':
      return typeof value === 'number' && !Number.isFinite(value) ? UNSAFE : value;
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      return UNSAFE;
    case 'object':
      break;
  }
  const obj = value as object;
  if (seen.has(obj)) return UNSAFE; // cycle → withhold the whole summary
  if (depth >= MAX_SANITIZE_DEPTH) return '[DEPTH-LIMITED]';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const out: unknown[] = [];
      const n = Math.min(obj.length, MAX_ARRAY_ITEMS);
      for (let i = 0; i < n; i++) {
        const item = sanitizeValue((obj as unknown[])[i], depth + 1, seen);
        if (item === UNSAFE) return UNSAFE;
        out.push(item);
      }
      if (obj.length > n) out.push(`[TRUNCATED ${obj.length - n} more items]`);
      return out;
    }
    const record = obj as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(record);
    const n = Math.min(keys.length, MAX_OBJECT_KEYS);
    for (let i = 0; i < n; i++) {
      const key = keys[i] as string;
      if (isSensitiveField(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      const item = sanitizeValue(record[key], depth + 1, seen);
      if (item === UNSAFE) return UNSAFE;
      out[key] = item;
    }
    if (keys.length > n) out['[TRUNCATED]'] = `${keys.length - n} more keys`;
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * A3-21 — summarize tool arguments for the wire WITHOUT leaking secrets.
 *
 * Defense in depth over the raw model-provided args:
 *  1. sensitive field names redacted (api_key, secret, token, …),
 *  2. credential-SHAPED string values redacted regardless of key
 *     (OpenAI/AWS/GitHub/Slack/Bearer/JWT patterns),
 *  3. depth / key-count / array-length / string-length bounded,
 *  4. total output bounded to MAX_TOOLCALL_ARGUMENT_SUMMARY_CHARS.
 *
 * Anything that cannot be safely summarized — cyclic, BigInt, functions,
 * non-finite numbers, or an over-budget summary — yields an explicit
 * `{"withheld": "..."}` marker. Never raw JSON, never a silent empty.
 *
 * Pure + deterministic: safe in workflow code and unit-testable.
 */
export function summarizeToolArguments(args: unknown): string {
  const withheld = (reason: string): string => JSON.stringify({ withheld: reason });
  try {
    let normalized: unknown;
    if (args === null || args === undefined) {
      normalized = {};
    } else if (typeof args === 'string') {
      normalized = sanitizeValue(args, 0, new Set());
    } else if (typeof args === 'object') {
      normalized = sanitizeValue(args, 0, new Set());
    } else {
      normalized = { value: sanitizeValue(args, 0, new Set()) };
    }
    if (normalized === UNSAFE) {
      return withheld('arguments withheld: could not be safely summarized');
    }
    const json = JSON.stringify(normalized);
    if (typeof json !== 'string') {
      return withheld('arguments withheld: could not be safely summarized');
    }
    if (json.length > MAX_TOOLCALL_ARGUMENT_SUMMARY_CHARS) {
      return withheld(
        `arguments withheld: summary exceeded ${MAX_TOOLCALL_ARGUMENT_SUMMARY_CHARS} chars`,
      );
    }
    return json;
  } catch {
    return withheld('arguments withheld: could not be safely summarized');
  }
}

export interface ToolCallEmitParams {
  scope: ToolCallCompletedEmitScope;
  /** Stable identity of the tool execution — MUST be the execution stepId. */
  stepId: string;
  toolName: string;
  /** The model-assigned call id — MUST match the later toolResult frame. */
  toolCallId: string;
  /** Raw proposal args — sanitized by summarizeToolArguments, never raw. */
  args: unknown;
}

export interface ToolCallEmit {
  scope: ToolCallCompletedEmitScope;
  type: EventType;
  stepId: string;
  body: RuntimeEventBody;
}

/**
 * A3-21 — build the toolCall (ToolCallProposed) emit params for one tool
 * invocation, carrying the tool name, the model-assigned call id, and the
 * SANITIZED argument summary. Emitted by the workflow BEFORE executeTool so
 * the chat's tool-call card can render name + args + in-progress state, with
 * the later ToolCallCompleted (toolResult) frame resolving the outcome.
 *
 * Identity mirrors ToolCallCompleted: the execution stepId scopes the
 * idempotency key, so each invocation derives a distinct eventId while
 * retries of the same invocation stay idempotent.
 */
export function buildToolCallEmit(params: ToolCallEmitParams): ToolCallEmit {
  return {
    scope: params.scope,
    type: 'ToolCallProposed',
    stepId: params.stepId,
    body: {
      kind: 'ToolCallProposed',
      runId: params.scope.runId,
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      stepId: params.stepId,
      argumentSummary: summarizeToolArguments(params.args),
    },
  };
}
