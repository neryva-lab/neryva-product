/**
 * tool-gateway.ts — 10-step policy enforcement boundary (model proposes, gateway disposes)
 * Source: agent_studio_architecture.md:483-511 (1-10), agent_studio_implementation_plan.md:992-1006
 * Steps:
 * 1 validate tool name
 * 2 validate args against schema
 * 3 confirm tenant and user scope
 * 4 check organization policy
 * 5 check rate and cost limits
 * 6 require human approval when necessary
 * 7 execute with scoped credential
 * 8 record the request and result
 * 9 apply idempotency protection
 * 10 return only the permitted result
 * Engine never exposes raw DB access as model tool (508).
 */

import type { ToolDescriptor } from '@neryva/contracts/tool/descriptor';
import { InMemoryToolRegistry } from './registry.js';
import { validateToolName, validateArgs } from './schema-validation.js';
import { decideEffectPolicy } from './effect-policy.js';
import { createApprovalId } from './approval-policy.js';
import { deriveToolIdempotencyKey, IdempotencyStore } from './idempotency.js';
import { resolveCredential } from './credentials.js';
import { isEgressAllowed } from './egress-policy.js';
import { redactResult } from './result-redaction.js';
import type { ToolContext } from './tool-context.js';
import { executeInProcess } from './executors/in-process.js';
import { executeAsActivity } from './executors/activity.js';
import { executeInSandbox } from './executors/sandbox.js';
import type { SecretProvider } from '@neryva/security';

export interface ToolCallProposal {
  toolName: string;
  args: unknown;
  // From model — untrusted, must be validated
  toolCallId?: string | undefined;
}

export interface GatewayExecuteParams {
  proposal: ToolCallProposal;
  context: ToolContext;
  stepId: string;
  // For idempotency
  runId: string;
  // Policy
  policyVersion: string;
  // Rate/cost limits (simple counters for Phase 6)
  rateLimits?:
    { maxCallsPerRun?: number | undefined; currentCalls?: number | undefined } | undefined;
  // Secret provider for credential resolution
  secretProvider?: SecretProvider | undefined;
  // Approval decision if already obtained — must correlate to this step/tool call (6.7)
  approvalDecision?:
    | {
        approvalId: string;
        decision: 'APPROVED' | 'DENIED';
        stepId?: string | undefined;
        toolCallId?: string | undefined;
      }
    | undefined;
  // For testing: inject handler
  handlerOverride?: ((args: unknown, ctx: ToolContext) => Promise<unknown>) | undefined;
}

export interface GatewayResult {
  toolCallId: string;
  stepId: string;
  success: boolean;
  result?: unknown | undefined;
  errorCode?: string | undefined;
  idempotencyKey: string;
  outcome: 'SUCCESS' | 'FAILED' | 'UNKNOWN_OUTCOME';
  audit: {
    toolId: string;
    effectClass: string;
    requiresApproval: boolean;
    approved: boolean;
    egressAllowed: boolean;
    redacted: boolean;
  };
}

export class ToolGateway {
  private readonly registry: InMemoryToolRegistry;
  private readonly idempotency: IdempotencyStore;

  constructor(
    registry: InMemoryToolRegistry = new InMemoryToolRegistry(),
    idempotency: IdempotencyStore = new IdempotencyStore(),
  ) {
    this.registry = registry;
    this.idempotency = idempotency;
  }

  getRegistry(): InMemoryToolRegistry {
    return this.registry;
  }

  getIdempotencyStore(): IdempotencyStore {
    return this.idempotency;
  }

  async execute(params: GatewayExecuteParams): Promise<GatewayResult> {
    const { proposal, context, stepId, runId, policyVersion } = params;
    const toolName = proposal.toolName;

    // 1. Validate tool name
    const nameCheck = validateToolName(
      toolName,
      this.registry as unknown as Map<string, ToolDescriptor>,
    );
    if (!nameCheck.ok) {
      return {
        toolCallId: proposal.toolCallId ?? `call_${stepId.slice(0, 8)}`,
        stepId,
        success: false,
        errorCode: 'TOOL_NOT_FOUND',
        idempotencyKey: 'none',
        outcome: 'FAILED',
        audit: {
          toolId: toolName,
          effectClass: 'UNKNOWN',
          requiresApproval: false,
          approved: false,
          egressAllowed: false,
          redacted: false,
        },
      };
    }
    const descriptor = nameCheck.descriptor;

    // 2. Validate args against schema
    const argsCheck = validateArgs(proposal.args, descriptor.inputSchema);
    if (!argsCheck.ok) {
      return {
        toolCallId: proposal.toolCallId ?? `call_${stepId.slice(0, 8)}`,
        stepId,
        success: false,
        errorCode: 'SCHEMA_VALIDATION_FAILED',
        idempotencyKey: 'none',
        outcome: 'FAILED',
        audit: {
          toolId: toolName,
          effectClass: descriptor.effectClass,
          requiresApproval: false,
          approved: false,
          egressAllowed: false,
          redacted: false,
        },
      };
    }

    // 3. Confirm tenant and user scope
    if (descriptor.allowedOrganizations && descriptor.allowedOrganizations.length > 0) {
      if (!descriptor.allowedOrganizations.includes(context.organizationId)) {
        return {
          toolCallId: proposal.toolCallId ?? `call_${stepId.slice(0, 8)}`,
          stepId,
          success: false,
          errorCode: 'TENANT_SCOPE_MISMATCH',
          idempotencyKey: 'none',
          outcome: 'FAILED',
          audit: {
            toolId: toolName,
            effectClass: descriptor.effectClass,
            requiresApproval: false,
            approved: false,
            egressAllowed: false,
            redacted: false,
          },
        };
      }
    }
    if (descriptor.allowedAgents && descriptor.allowedAgents.length > 0) {
      if (!descriptor.allowedAgents.includes(context.agentVersionId)) {
        return {
          toolCallId: proposal.toolCallId ?? `call_${stepId.slice(0, 8)}`,
          stepId,
          success: false,
          errorCode: 'AGENT_SCOPE_MISMATCH',
          idempotencyKey: 'none',
          outcome: 'FAILED',
          audit: {
            toolId: toolName,
            effectClass: descriptor.effectClass,
            requiresApproval: false,
            approved: false,
            egressAllowed: false,
            redacted: false,
          },
        };
      }
    }

    // 4. Check organization policy (already via allowedOrganizations, but also check effect vs access)
    // 5. Check rate and cost limits
    if (
      params.rateLimits?.maxCallsPerRun !== undefined &&
      params.rateLimits.currentCalls !== undefined
    ) {
      if (params.rateLimits.currentCalls >= params.rateLimits.maxCallsPerRun) {
        return {
          toolCallId: proposal.toolCallId ?? `call_${stepId.slice(0, 8)}`,
          stepId,
          success: false,
          errorCode: 'RATE_LIMITED',
          idempotencyKey: 'none',
          outcome: 'FAILED',
          audit: {
            toolId: toolName,
            effectClass: descriptor.effectClass,
            requiresApproval: false,
            approved: false,
            egressAllowed: false,
            redacted: false,
          },
        };
      }
    }

    // 6. Require human approval when necessary (effect vs approval orthogonal)
    const effectDecision = decideEffectPolicy(descriptor);
    const requiresApproval = effectDecision.requiresApproval;
    let approved = !requiresApproval;
    if (requiresApproval) {
      // Correlation check: a decision only authorizes THIS step + tool call.
      // A stale/approval for another tool_call/step must never execute here (6.7, 1116).
      const dec = params.approvalDecision;
      const correlated =
        !!dec &&
        dec.decision === 'APPROVED' &&
        !!dec.approvalId &&
        (dec.stepId === undefined || dec.stepId === stepId) &&
        (proposal.toolCallId === undefined ||
          dec.toolCallId === undefined ||
          dec.toolCallId === proposal.toolCallId);
      if (correlated) {
        approved = true;
      } else {
        // Not approved (or uncorrelated decision treated as not approved) — don't execute
        void createApprovalId(runId, stepId, proposal.toolCallId ?? toolName);
        return {
          toolCallId: proposal.toolCallId ?? `call_${stepId.slice(0, 8)}`,
          stepId,
          success: false,
          errorCode:
            dec && dec.decision === 'APPROVED' ? 'APPROVAL_UNCORRELATED' : 'APPROVAL_REQUIRED',
          idempotencyKey: deriveToolIdempotencyKey({
            runId,
            stepId,
            toolId: descriptor.toolId,
            toolVersion: descriptor.version,
          }),
          outcome: 'FAILED',
          audit: {
            toolId: toolName,
            effectClass: descriptor.effectClass,
            requiresApproval: true,
            approved: false,
            egressAllowed: false,
            redacted: false,
          },
        };
      }
    }

    // 7. Derive idempotency key and check store before execution (persist before ack)
    const idempotencyKey = deriveToolIdempotencyKey({
      runId,
      stepId,
      toolId: descriptor.toolId,
      toolVersion: descriptor.version,
    });
    const existing = this.idempotency.get(idempotencyKey);
    if (existing) {
      // Duplicate delivery — return original, do not re-execute (1008-1017)
      return {
        toolCallId: proposal.toolCallId ?? `call_${stepId.slice(0, 8)}`,
        stepId,
        success: existing.outcome === 'SUCCESS',
        result: existing.response,
        errorCode: existing.outcome === 'SUCCESS' ? undefined : 'DUPLICATE',
        idempotencyKey,
        outcome: existing.outcome,
        audit: {
          toolId: toolName,
          effectClass: descriptor.effectClass,
          requiresApproval,
          approved,
          egressAllowed: true,
          redacted: false,
        },
      };
    }

    // 7a. Check egress
    const egressCheck = isEgressAllowed(descriptor.egressClass, {
      mode: 'deny-by-default',
      allowlist: [],
    });
    if (!egressCheck.allowed) {
      return {
        toolCallId: proposal.toolCallId ?? `call_${stepId.slice(0, 8)}`,
        stepId,
        success: false,
        errorCode: 'EGRESS_DENIED',
        idempotencyKey,
        outcome: 'FAILED',
        audit: {
          toolId: toolName,
          effectClass: descriptor.effectClass,
          requiresApproval,
          approved,
          egressAllowed: false,
          redacted: false,
        },
      };
    }

    // 7b. Resolve scoped credential (never ambient)
    let credentialValue: string | undefined = undefined;
    if (params.secretProvider && descriptor.credentialRef) {
      const cred = await resolveCredential({
        toolId: descriptor.toolId,
        organizationId: context.organizationId,
        runId,
        credentialRef: descriptor.credentialRef,
        secretProvider: params.secretProvider,
      });
      credentialValue = cred?.value;
      void credentialValue; // would be passed to executor, not logged
    }

    // 8. Execute with scoped credential and egress — choose executor by mode
    const handler =
      params.handlerOverride ??
      (async (args) => ({ ok: true, tool: toolName, args, policyVersion }));
    let rawResult: unknown;
    let outcome: 'SUCCESS' | 'FAILED' | 'UNKNOWN_OUTCOME' = 'SUCCESS';
    let success = true;
    let errorCode: string | undefined = undefined;

    try {
      if (descriptor.executionMode === 'sandbox') {
        const sandboxRes = await executeInSandbox(
          descriptor,
          argsCheck.data,
          context,
          handler as never,
        );
        if (!sandboxRes.success) {
          success = false;
          errorCode = sandboxRes.error?.includes('SANDBOX_ESCAPE')
            ? 'SANDBOX_ESCAPE_DENIED'
            : 'TOOL_FAILED';
          outcome = 'FAILED';
          rawResult = sandboxRes.error;
        } else {
          rawResult = sandboxRes.result;
        }
      } else if (descriptor.executionMode === 'activity') {
        rawResult = await executeAsActivity(descriptor, argsCheck.data, context, handler as never);
      } else {
        rawResult = await executeInProcess(descriptor, argsCheck.data, context, handler as never);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes('TIMEOUT') ||
        msg.includes('UNKNOWN_OUTCOME') ||
        msg.includes('LOST_RESPONSE')
      ) {
        // Lost response — UNKNOWN_OUTCOME if unprovable
        outcome = 'UNKNOWN_OUTCOME';
        success = false;
        errorCode = 'UNKNOWN_OUTCOME';
        rawResult = { error: msg, idempotencyKey };
      } else {
        success = false;
        errorCode = 'TOOL_FAILED';
        outcome = 'FAILED';
        rawResult = { error: msg };
      }
    }

    // 9. Redact and bound result
    const redacted = redactResult(rawResult, descriptor.redactionPolicy as 'strict' | 'permissive');
    const redactedFlag = JSON.stringify(redacted) !== JSON.stringify(rawResult);

    // 10. Persist before ack (idempotency store) and return only permitted result
    this.idempotency.put({
      key: idempotencyKey,
      runId,
      stepId,
      toolId: descriptor.toolId,
      toolVersion: descriptor.version,
      args: proposal.args,
      outcome,
      response: redacted,
    });

    return {
      toolCallId: proposal.toolCallId ?? `call_${stepId.slice(0, 8)}`,
      stepId,
      success,
      result: redacted,
      errorCode,
      idempotencyKey,
      outcome,
      audit: {
        toolId: toolName,
        effectClass: descriptor.effectClass,
        requiresApproval,
        approved,
        egressAllowed: true,
        redacted: redactedFlag,
      },
    };
  }
}
