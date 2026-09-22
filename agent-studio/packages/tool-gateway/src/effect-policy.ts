/**
 * effect-policy.ts — effect classification (READ_ONLY|MUTATING|DESTRUCTIVE) orthogonal to approval
 * Source: agent_studio_implementation_plan.md:969-987, 989
 * effect_class vs approval_requirement are orthogonal: read-only can require approval (confidential), mutating can be pre-approved only under explicit policy.
 */

import type {
  ToolDescriptor,
  EffectClass,
  ApprovalRequirement,
} from '@neryva/contracts/tool/descriptor';

export interface EffectPolicyDecision {
  effectClass: EffectClass;
  approvalRequirement: ApprovalRequirement;
  // Whether this call requires approval given current policy and tool's descriptor
  requiresApproval: boolean;
  reason: string;
}

// Pre-approved mutating tools — only under explicit policy (e.g., allowlist in agent definition + org policy)
const PRE_APPROVED_MUTATING = new Set<string>([
  // empty by default — must be explicitly configured per org/agent; example: search_tickets is READ_ONLY so not here
]);

export function decideEffectPolicy(
  descriptor: ToolDescriptor,
  explicitPreApproved: Set<string> = PRE_APPROVED_MUTATING,
): EffectPolicyDecision {
  const { effectClass, approvalRequirement } = descriptor;

  // Orthogonal: approvalRequirement is separate from effectClass
  // Even READ_ONLY can require approval (e.g., confidential data)
  // Even MUTATING can be pre-approved only if explicitly in allowlist
  let requiresApproval = approvalRequirement === 'REQUIRED';

  if (effectClass === 'MUTATING' && approvalRequirement === 'NONE') {
    // Mutating without approval must be explicitly pre-approved
    requiresApproval = !explicitPreApproved.has(descriptor.toolId);
    return {
      effectClass,
      approvalRequirement,
      requiresApproval,
      reason: requiresApproval
        ? 'MUTATING without explicit pre-approval requires approval'
        : 'MUTATING pre-approved via explicit policy',
    };
  }

  if (effectClass === 'DESTRUCTIVE') {
    // Destructive always requires approval, regardless of descriptor's approval field (unless explicitly overridden, which we don't allow in v1)
    return {
      effectClass,
      approvalRequirement,
      requiresApproval: true,
      reason: 'DESTRUCTIVE always requires approval',
    };
  }

  return {
    effectClass,
    approvalRequirement,
    requiresApproval,
    reason: requiresApproval
      ? `approvalRequirement=REQUIRED for ${descriptor.toolId}`
      : `approval not required for ${descriptor.toolId}`,
  };
}

// Policy matrix for tests — ensures orthogonality
export const EFFECT_POLICY_MATRIX: Array<{
  effectClass: EffectClass;
  approvalRequirement: ApprovalRequirement;
  requiresApproval: boolean;
}> = [
  { effectClass: 'READ_ONLY', approvalRequirement: 'NONE', requiresApproval: false },
  { effectClass: 'READ_ONLY', approvalRequirement: 'REQUIRED', requiresApproval: true },
  { effectClass: 'MUTATING', approvalRequirement: 'NONE', requiresApproval: true }, // without explicit pre-approval
  { effectClass: 'MUTATING', approvalRequirement: 'REQUIRED', requiresApproval: true },
  { effectClass: 'DESTRUCTIVE', approvalRequirement: 'NONE', requiresApproval: true },
  { effectClass: 'DESTRUCTIVE', approvalRequirement: 'REQUIRED', requiresApproval: true },
];
