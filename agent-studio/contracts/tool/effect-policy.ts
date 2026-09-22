/**
 * effect-policy.ts — effect and approval policy evaluation
 * Source: agent_studio_implementation_plan.md:968-990
 */

import type { EffectClass, ToolDescriptor } from './descriptor.js';

export interface PolicyEvaluationInput {
  descriptor: ToolDescriptor;
  organizationId: string;
  agentId: string;
  modelPolicyAllowed: boolean;
}

export type PolicyDecision =
  { allowed: true; approvalRequired: boolean } | { allowed: false; reason: string };

/**
 * Pure policy check — no network, no DB.
 * effectClass and approvalRequirement are orthogonal (989).
 */
export function evaluateToolPolicy(input: PolicyEvaluationInput): PolicyDecision {
  const { descriptor, organizationId, agentId } = input;

  // Scope checks
  if (descriptor.allowedOrganizations && descriptor.allowedOrganizations.length > 0) {
    if (!descriptor.allowedOrganizations.includes(organizationId)) {
      return {
        allowed: false,
        reason: `tool ${descriptor.toolId} not allowed for org ${organizationId}`,
      };
    }
  }
  if (descriptor.allowedAgents && descriptor.allowedAgents.length > 0) {
    if (!descriptor.allowedAgents.includes(agentId)) {
      return {
        allowed: false,
        reason: `tool ${descriptor.toolId} not allowed for agent ${agentId}`,
      };
    }
  }

  // Mutating without idempotency is still allowed but must be audited — caller must handle UNKNOWN_OUTCOME
  // Destructive always requires explicit policy; this function does not auto-approve.
  const approvalRequired = descriptor.approvalRequirement === 'REQUIRED';
  return { allowed: true, approvalRequired };
}

export function isEffectful(effect: EffectClass): boolean {
  return effect === 'MUTATING' || effect === 'DESTRUCTIVE';
}
