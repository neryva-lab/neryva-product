/**
 * descriptor.ts — provider-neutral tool descriptor
 * Source: agent_studio_implementation_plan.md:970-987, 1354
 * Read-only registry interface used for definition validation + context planning.
 * Runtime execution remains in tool-gateway (Phase 6).
 */

export type EffectClass = 'READ_ONLY' | 'MUTATING' | 'DESTRUCTIVE';
export type ApprovalRequirement = 'NONE' | 'REQUIRED';
export type ExecutionMode = 'in-process' | 'activity' | 'sandbox';

export interface ToolDescriptor {
  /** Stable tool identifier, e.g., search_tickets */
  toolId: string;
  /** Semantic version for the tool contract */
  version: string;
  /** JSON Schema for input validation */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for output (optional, for documentation) */
  outputSchema?: Record<string, unknown>;
  /** Effect class — orthogonal to approval */
  effectClass: EffectClass;
  /** Whether human approval is required (orthogonal to effectClass) */
  approvalRequirement: ApprovalRequirement;
  /** Opaque credential reference (not value) — resolved via secret-provider */
  credentialRef?: string;
  /** Allowed organization IDs (empty = all) — enforced in gateway */
  allowedOrganizations?: string[];
  /** Allowed agent IDs (empty = all) */
  allowedAgents?: string[];
  /** Network egress class */
  egressClass: 'none' | 'limited' | 'open';
  /** Timeout in ms */
  timeoutMs: number;
  /** Whether idempotency is supported by the underlying system */
  idempotency: 'supported' | 'unsupported';
  /** Redaction policy for args/results */
  redactionPolicy: 'strict' | 'permissive';
  /** Audit event type */
  auditEventType: string;
  /** Execution mode */
  executionMode: ExecutionMode;
}

// Minimal registry seed for Phase 1 definition validation (read-only)
export const DEFAULT_TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    toolId: 'search_tickets',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', minLength: 1, maxLength: 1000 } },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { tickets: { type: 'array', items: { type: 'object' } } },
    },
    effectClass: 'READ_ONLY',
    approvalRequirement: 'NONE',
    egressClass: 'limited',
    timeoutMs: 10_000,
    idempotency: 'supported',
    redactionPolicy: 'strict',
    auditEventType: 'tool.search_tickets',
    executionMode: 'activity',
  },
  {
    toolId: 'create_ticket',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      required: ['title', 'description'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', minLength: 1, maxLength: 5000 },
      },
      additionalProperties: false,
    },
    effectClass: 'MUTATING',
    approvalRequirement: 'REQUIRED',
    egressClass: 'limited',
    timeoutMs: 30_000,
    idempotency: 'supported',
    redactionPolicy: 'strict',
    auditEventType: 'tool.create_ticket',
    executionMode: 'activity',
  },
  // ── Platform built-ins (TPL-3.2) ─────────────────────────────────────
  // Platform-implemented retrieval/escalation tools: no per-org catalog row
  // exists for them (a catalog httpBinding would be meaningless — they run
  // inside the Engine/runtime). Effect/approval mirrors the Engine
  // BUILT_IN_TOOLS posture (engine/src/modules/assistants/tool-catalog.service.ts);
  // the two lists must stay aligned — see PLATFORM_BUILT_IN_TOOLS below.
  {
    toolId: 'search_knowledge',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', minLength: 1, maxLength: 2000 } },
      additionalProperties: false,
    },
    effectClass: 'READ_ONLY',
    approvalRequirement: 'NONE',
    egressClass: 'none',
    timeoutMs: 15_000,
    idempotency: 'supported',
    redactionPolicy: 'strict',
    auditEventType: 'tool.search_knowledge',
    executionMode: 'activity',
  },
  {
    toolId: 'search_memory',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', minLength: 1, maxLength: 2000 } },
      additionalProperties: false,
    },
    effectClass: 'READ_ONLY',
    approvalRequirement: 'NONE',
    egressClass: 'none',
    timeoutMs: 15_000,
    idempotency: 'supported',
    redactionPolicy: 'strict',
    auditEventType: 'tool.search_memory',
    executionMode: 'activity',
  },
  {
    toolId: 'request_human_handoff',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', minLength: 1, maxLength: 2000 },
        context: { type: 'string', maxLength: 8000 },
      },
      additionalProperties: false,
    },
    effectClass: 'MUTATING',
    approvalRequirement: 'NONE',
    egressClass: 'none',
    timeoutMs: 30_000,
    idempotency: 'supported',
    redactionPolicy: 'strict',
    auditEventType: 'tool.request_human_handoff',
    executionMode: 'activity',
  },
  {
    toolId: 'web_search',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', minLength: 1, maxLength: 1000 } },
      additionalProperties: false,
    },
    effectClass: 'READ_ONLY',
    approvalRequirement: 'NONE',
    egressClass: 'limited',
    timeoutMs: 15_000,
    idempotency: 'supported',
    redactionPolicy: 'strict',
    auditEventType: 'tool.web_search',
    executionMode: 'activity',
  },
  {
    toolId: 'generate_image',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: { prompt: { type: 'string', minLength: 1, maxLength: 2000 } },
      additionalProperties: false,
    },
    // Mirrors the Engine posture (tool-catalog.service.ts FL-3.2 comment):
    // READ_ONLY toward customer data — no org state is written; the output
    // artifact is claim-checked. The two registries must stay aligned.
    effectClass: 'READ_ONLY',
    approvalRequirement: 'NONE',
    egressClass: 'limited',
    timeoutMs: 60_000,
    idempotency: 'supported',
    redactionPolicy: 'strict',
    auditEventType: 'tool.generate_image',
    executionMode: 'activity',
  },
];

/**
 * Platform built-in tool names (TPL-3.2). Mirrors the Engine BUILT_IN_TOOLS
 * keys (engine/src/modules/assistants/tool-catalog.service.ts) — a tool is
 * added/removed here if and only if the Engine list changes. Built-ins
 * resolve by name (no catalog row, no schema_hash pin) and carry
 * platform-owned approval semantics, so the validator's strict
 * write+MUTATING rule does not apply to them (see validator.ts check 3).
 */
export const PLATFORM_BUILT_IN_TOOLS: ReadonlySet<string> = new Set([
  'search_knowledge',
  'search_memory',
  'request_human_handoff',
  'web_search',
  'generate_image',
]);
