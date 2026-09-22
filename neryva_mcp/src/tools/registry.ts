/**
 * Tool Registry — every tool has explicit descriptor per agent_studio_implementation_plan.md:949-964
 * Reference: neryva_mcp_implementation_plan.md:618-623 (effect_class + approval_requirement orthogonal)
 *
 * Do NOT model DESTRUCTIVE and HUMAN_APPROVAL_REQUIRED as peers — first is effect_class, second is policy requirement.
 * This makes "create_support_ticket with approval required" unambiguous (MUTATING + REQUIRED, not DESTRUCTIVE).
 */

import { validationError } from "../shared/errors.js";

export enum ToolEffectClass {
  UNSPECIFIED = 0,
  READ_ONLY = 1,
  MUTATING = 2,
  DESTRUCTIVE = 3,
}

export enum ApprovalRequirement {
  UNSPECIFIED = 0,
  NONE = 1,
  REQUIRED = 2,
}

export type EgressClass = "internal" | "external_api" | "external_mcp";

export interface ToolDescriptor {
  toolName: string;
  toolVersion: string;
  effectClass: ToolEffectClass;
  approvalRequirement: ApprovalRequirement;
  egress: EgressClass;
  timeoutMs: number;
  idempotency: "supported" | "unsupported"; // external API supports idempotency key?
  credentialRef: string; // scoped credential identifier, never raw secret
  scope: "org" | "conversation" | "run"; // minimal scope
  redactedFields: string[]; // fields never logged
  schema: { required: string[]; properties: Record<string, { type: string }> };
}

// Registry entries — cover every tool per ledger 5.6
const REGISTRY: Record<string, ToolDescriptor> = {
  read_document: {
    toolName: "read_document",
    toolVersion: "v1",
    effectClass: ToolEffectClass.READ_ONLY,
    approvalRequirement: ApprovalRequirement.NONE,
    egress: "internal",
    timeoutMs: 5_000,
    idempotency: "supported",
    credentialRef: "cred_internal_ro",
    scope: "org",
    redactedFields: [],
    schema: { required: ["docId"], properties: { docId: { type: "string" }, query: { type: "string" } } },
  },
  list_conversations: {
    toolName: "list_conversations",
    toolVersion: "v1",
    effectClass: ToolEffectClass.READ_ONLY,
    approvalRequirement: ApprovalRequirement.NONE,
    egress: "internal",
    timeoutMs: 2_000,
    idempotency: "supported",
    credentialRef: "cred_internal_ro",
    scope: "org",
    redactedFields: [],
    schema: { required: [], properties: { limit: { type: "number" } } },
  },
  create_draft: {
    toolName: "create_draft",
    toolVersion: "v1",
    effectClass: ToolEffectClass.MUTATING,
    approvalRequirement: ApprovalRequirement.NONE,
    egress: "internal",
    timeoutMs: 10_000,
    idempotency: "supported",
    credentialRef: "cred_internal_rw",
    scope: "conversation",
    redactedFields: [],
    schema: { required: ["content"], properties: { content: { type: "string" }, title: { type: "string" } } },
  },
  // MUTATING + REQUIRED orthogonal example: mutating but still needs human sign-off
  create_support_ticket: {
    toolName: "create_support_ticket",
    toolVersion: "v1",
    effectClass: ToolEffectClass.MUTATING,
    approvalRequirement: ApprovalRequirement.REQUIRED,
    egress: "external_api",
    timeoutMs: 15_000,
    idempotency: "supported",
    credentialRef: "cred_support_api",
    scope: "org",
    redactedFields: ["requester_email"],
    schema: { required: ["subject", "body"], properties: { subject: { type: "string" }, body: { type: "string" }, requester_email: { type: "string" } } },
  },
  delete_conversation: {
    toolName: "delete_conversation",
    toolVersion: "v1",
    effectClass: ToolEffectClass.DESTRUCTIVE,
    approvalRequirement: ApprovalRequirement.REQUIRED,
    egress: "internal",
    timeoutMs: 10_000,
    idempotency: "supported",
    credentialRef: "cred_internal_destructive",
    scope: "conversation",
    redactedFields: [],
    schema: { required: ["conversationId"], properties: { conversationId: { type: "string" } } },
  },
  send_email: {
    toolName: "send_email",
    toolVersion: "v1",
    effectClass: ToolEffectClass.DESTRUCTIVE, // sends external irreversible
    approvalRequirement: ApprovalRequirement.REQUIRED,
    egress: "external_api",
    timeoutMs: 10_000,
    idempotency: "unsupported", // some providers lack idempotency → manual reconciliation required
    credentialRef: "cred_email_api",
    scope: "org",
    redactedFields: ["to", "body", "api_key"],
    schema: { required: ["to", "subject", "body"], properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } } },
  },
  // E2E compat: legacy search tool (READ_ONLY) used by phase2.e2e before registry — keep allowlisted for backward compat
  search: {
    toolName: "search",
    toolVersion: "v1",
    effectClass: ToolEffectClass.READ_ONLY,
    approvalRequirement: ApprovalRequirement.NONE,
    egress: "internal",
    timeoutMs: 5_000,
    idempotency: "supported",
    credentialRef: "cred_internal_ro",
    scope: "org",
    redactedFields: [],
    schema: { required: [], properties: { query: { type: "string" } } },
  },
};

export function getToolDescriptor(toolName: string): ToolDescriptor | undefined {
  return REGISTRY[toolName];
}

export function listTools(): ToolDescriptor[] {
  return Object.values(REGISTRY);
}

export function validateToolArgs(toolName: string, args: Record<string, unknown>): void {
  const desc = getToolDescriptor(toolName);
  if (!desc) throw validationError(`tool ${toolName} not registered (org allowlist deny)`);
  for (const req of desc.schema.required) {
    if (!(req in args) || args[req] === undefined || args[req] === "") {
      throw validationError(`tool ${toolName} missing required field ${req}`);
    }
  }
  for (const [k, v] of Object.entries(args)) {
    const prop = desc.schema.properties[k];
    if (!prop) throw validationError(`tool ${toolName} unknown field ${k}`);
    if (prop.type === "string" && typeof v !== "string") throw validationError(`tool ${toolName} field ${k} must be string`);
    if (prop.type === "number" && typeof v !== "number") throw validationError(`tool ${toolName} field ${k} must be number`);
  }
}

export function getEffectClass(toolName: string): ToolEffectClass {
  const d = getToolDescriptor(toolName);
  if (!d) throw validationError(`unknown tool ${toolName}`);
  return d.effectClass;
}

export function requiresApproval(toolName: string): boolean {
  const d = getToolDescriptor(toolName);
  if (!d) return false;
  return d.approvalRequirement === ApprovalRequirement.REQUIRED;
}
