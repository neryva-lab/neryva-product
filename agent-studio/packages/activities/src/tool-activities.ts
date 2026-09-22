/**
 * tool-activities.ts — Tool Gateway execution as Activities (real gateway, idempotent, auditable)
 * Source: agent_studio_implementation_plan.md:992-1006, 507-510, 1008-1017
 * Idempotency: stable run_id+stepId+toolVersion key, persist before ack, query/reconcile, UNKNOWN_OUTCOME if unprovable, never blindly retry.
 * 6.8: create_ticket mutating tool with approval: required, fake external system supports idempotency lookup.
 */

import { heartbeat, isActivityCancelled } from './heartbeat.js';
import { ToolGateway, InMemoryToolRegistry } from '@neryva/tool-gateway';
import { DEFAULT_TOOL_DESCRIPTORS } from '@neryva/contracts/tool/descriptor';
import { InMemorySecretProvider } from '@neryva/security';
import { writeArtifact, shouldClaimCheck, createSizePolicy } from '@neryva/artifacts';

// Fake external system for create_ticket — supports idempotency lookup
const fakeTicketStore = new Map<string, { ticketId: string; title: string; description: string }>();
const fakeTicketByKey = new Map<string, string>(); // idempotencyKey -> ticketId

async function fakeCreateTicket(
  args: unknown,
  _ctx: unknown,
  idempotencyKey: string,
): Promise<{ ticketId: string; title: string }> {
  // Simulate idempotency: if key already seen, return same ticket (dedup before ack)
  const existingKey = fakeTicketByKey.get(idempotencyKey);
  if (existingKey) {
    const existing = fakeTicketStore.get(existingKey);
    if (existing) return existing;
  }

  // Simulate lost response: if args has _simulateLostResponse, don't persist yet, will be reconciled
  const a = args as Record<string, unknown>;
  if (a['_simulateLostResponse'] === true) {
    // Simulate that external system did create but response was lost — store but caller will get UNKNOWN_OUTCOME
    const ticketId = `tk_${Math.random().toString(36).slice(2, 8)}`;
    const ticket = {
      ticketId,
      title: String(a['title'] ?? 'untitled'),
      description: String(a['description'] ?? ''),
    };
    fakeTicketStore.set(ticketId, ticket);
    fakeTicketByKey.set(idempotencyKey, ticketId);
    throw new Error('LOST_RESPONSE');
  }

  // Simulate unknown outcome if explicitly requested
  if (a['_simulateUnknown'] === true) {
    throw new Error('UNKNOWN_OUTCOME');
  }

  const ticketId = `tk_${Math.random().toString(36).slice(2, 8)}`;
  const ticket = {
    ticketId,
    title: String(a['title'] ?? 'untitled'),
    description: String(a['description'] ?? ''),
  };
  fakeTicketStore.set(ticketId, ticket);
  fakeTicketByKey.set(idempotencyKey, ticketId);
  return ticket;
}

async function fakeSearchTickets(args: unknown): Promise<{ tickets: unknown[] }> {
  void args;
  return { tickets: [] };
}

// For tests: clear
export function __clearFakeTicketStore(): void {
  fakeTicketStore.clear();
  fakeTicketByKey.clear();
}
export function __getFakeTicketStore(): Map<
  string,
  { ticketId: string; title: string; description: string }
> {
  return fakeTicketStore;
}

export interface ExecuteToolParams {
  runId: string;
  organizationId: string;
  stepId: string;
  toolName: string;
  toolVersion: string;
  args: unknown;
  idempotencyKey: string;
  effectClass: 'READ_ONLY' | 'MUTATING' | 'DESTRUCTIVE';
  approvalId?: string | undefined;
  agentVersionId?: string | undefined;
  conversationId?: string | undefined;
  policyVersion?: string | undefined;
  correlationId?: string | undefined;
}

export interface ToolExecutionResult {
  toolCallId: string;
  stepId: string;
  success: boolean;
  result?: unknown | undefined;
  errorCode?: string | undefined;
  artifactRef?: string | undefined;
  outcome?: 'SUCCESS' | 'FAILED' | 'UNKNOWN_OUTCOME' | undefined;
  idempotencyKey?: string | undefined;
}

// Shared gateway singleton for Activities (stateless, but idempotency store is per-worker, need to persist via Engine/MCP in prod)
let gateway: ToolGateway | undefined;
function getGateway(): ToolGateway {
  if (!gateway) {
    // SMOKE-ONLY substitution (Wave 4 happy-path smoke): force named tools
    // through the SIMULATED sandbox executor instead of their default
    // executionMode. The real sandbox backend does not exist (Wave 3 proved
    // the sandbox simulated-only); without this override the temporal path
    // runs every tool as a plain activity. Named in smoke evidence as a
    // substitution — never a production default. Unset (or empty)
    // NERYVA_SMOKE_SANDBOX_TOOLS disables it entirely.
    const sandboxTools = (process.env.NERYVA_SMOKE_SANDBOX_TOOLS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const descriptors =
      sandboxTools.length > 0
        ? DEFAULT_TOOL_DESCRIPTORS.map((d) =>
            sandboxTools.includes(d.toolId) ? { ...d, executionMode: 'sandbox' as const } : d,
          )
        : [...DEFAULT_TOOL_DESCRIPTORS];
    const registry = new InMemoryToolRegistry(descriptors);
    gateway = new ToolGateway(registry);
  }
  return gateway;
}

export async function executeTool(
  params: ExecuteToolParams,
  deps?: ToolActivityOptions,
): Promise<ToolExecutionResult> {
  heartbeat({ step: 'executeTool:start', toolName: params.toolName, stepId: params.stepId });
  if (isActivityCancelled()) throw new Error('CANCELLED');

  const gw = getGateway();

  // Map effectClass to descriptor's expected — gateway will validate
  // For Phase 6, we provide handler that simulates external system
  const handler = async (args: unknown, _ctx: unknown): Promise<unknown> => {
    if (params.toolName === 'request_human_handoff') {
      // FL-1.7c — the escalation is the Engine RPC, not a simulation.
      if (!deps?.requestHandoff) {
        throw new Error('TOOL_EXECUTOR_UNBOUND: no executor bound for request_human_handoff');
      }
      return deps.requestHandoff(params.runId, args);
    }
    if (params.toolName === 'create_ticket') {
      return fakeCreateTicket(args, _ctx, params.idempotencyKey);
    }
    if (params.toolName === 'search_tickets') {
      return fakeSearchTickets(args);
    }
    // Default: echo
    return { ok: true, tool: params.toolName, args };
  };

  // Use gateway's 10-step flow — it will handle idempotency, approval, egress, redaction, etc.
  // For mutating, gateway expects approvalDecision if requiresApproval
  const secretProvider = new InMemorySecretProvider();
  // In real, credentialRef would be resolved via secretProvider; for tests, no cred needed for search_tickets

  const toolCallId = `call_${params.stepId.slice(0, 8)}`;
  const result = await gw.execute({
    proposal: {
      toolName: params.toolName,
      args: params.args,
      toolCallId,
    },
    context: {
      organizationId: params.organizationId,
      conversationId: params.conversationId ?? 'conv_fake',
      runId: params.runId,
      agentVersionId: params.agentVersionId ?? 'agent_v1',
      policyVersion: params.policyVersion ?? 'v1',
      correlationId: params.correlationId ?? params.runId,
    },
    stepId: params.stepId,
    runId: params.runId,
    policyVersion: params.policyVersion ?? 'v1',
    secretProvider,
    approvalDecision: params.approvalId
      ? { approvalId: params.approvalId, decision: 'APPROVED', stepId: params.stepId, toolCallId }
      : undefined,
    handlerOverride: handler as unknown as (args: unknown, ctx: unknown) => Promise<unknown>,
  });

  // Map gateway result to ToolExecutionResult
  heartbeat({ step: 'executeTool:done', toolName: params.toolName, outcome: result.outcome });

  // Handle UNKNOWN_OUTCOME reconciliation: if gateway says UNKNOWN_OUTCOME, we try to reconcile via idempotency store
  if (result.outcome === 'UNKNOWN_OUTCOME') {
    // In real, we would query downstream by idempotencyKey; here, check fake store
    const ticketId = fakeTicketByKey.get(params.idempotencyKey);
    if (ticketId) {
      const ticket = fakeTicketStore.get(ticketId);
      if (ticket) {
        // Reconciled — treat as success (idempotent)
        return {
          toolCallId: result.toolCallId,
          stepId: params.stepId,
          success: true,
          result: ticket,
          outcome: 'SUCCESS',
          idempotencyKey: params.idempotencyKey,
        };
      }
    }
    return {
      toolCallId: result.toolCallId,
      stepId: params.stepId,
      success: false,
      errorCode: 'UNKNOWN_OUTCOME',
      outcome: 'UNKNOWN_OUTCOME',
      idempotencyKey: params.idempotencyKey,
    };
  }

  // 7.7 Long-result handling: large tool results/transcripts via ArtifactRef (claim-check) instead of inline
  // Ensures workflow args remain bounded (1484) and large data never enters Temporal history
  if (result.success && result.result !== undefined) {
    const payload = JSON.stringify(result.result);
    const byteLength = new TextEncoder().encode(payload).byteLength;
    const policy = createSizePolicy();
    if (shouldClaimCheck(byteLength, 'standard', policy)) {
      const content = new TextEncoder().encode(payload);
      const ref = await writeArtifact(content, {
        organizationId: params.organizationId,
        runId: params.runId,
        purpose: 'TOOL_RESULT',
        mediaType: 'application/json',
      });
      return {
        toolCallId: result.toolCallId,
        stepId: params.stepId,
        success: true,
        result: undefined,
        artifactRef: ref.artifactId,
        outcome: 'SUCCESS',
        idempotencyKey: params.idempotencyKey,
      };
    }
  }

  return {
    toolCallId: result.toolCallId,
    stepId: params.stepId,
    success: result.success,
    result: result.result,
    errorCode: result.errorCode,
    outcome: result.outcome as 'SUCCESS' | 'FAILED' | 'UNKNOWN_OUTCOME' | undefined,
    idempotencyKey: params.idempotencyKey,
  };
}

export async function authorizeToolCall(params: {
  toolName: string;
  stepId: string;
}): Promise<{ authorized: boolean; effectClass: string }> {
  heartbeat({ step: 'authorizeToolCall', toolName: params.toolName });
  const gw = getGateway();
  const desc = gw.getRegistry().get(params.toolName);
  if (!desc) return { authorized: false, effectClass: 'UNKNOWN' };
  return { authorized: true, effectClass: desc.effectClass };
}

export interface ToolActivityOptions {
  /**
   * FL-1.7c — Engine binding for the built-in `request_human_handoff` tool:
   * the call IS a RequestHumanHandoff MCP RPC (escalation row + paused
   * auto-responder). Unbound, the tool fails closed like any other unbound
   * executor.
   */
  requestHandoff?: ((runId: string, args: unknown) => Promise<unknown>) | undefined;
}

export function createToolActivities(deps?: ToolActivityOptions) {
  return {
    executeTool: (params: ExecuteToolParams) => executeTool(params, deps),
    authorizeToolCall,
    __clearFakeTicketStore,
    __getFakeTicketStore,
  };
}

export type ToolActivities = ReturnType<typeof createToolActivities>;
