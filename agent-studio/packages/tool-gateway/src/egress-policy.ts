/**
 * egress-policy.ts — network egress controls (restricted egress, no ambient)
 * Source: agent_studio_implementation_plan.md:1018-1029, infra/policies/network-egress/
 * Tools with broad network clients, sensitive creds, high CPU must run in sandbox with restricted egress.
 */

export type EgressClass = 'none' | 'limited' | 'open';
export type EgressMode = 'deny-by-default' | 'allowlist';

export interface EgressPolicy {
  mode: EgressMode;
  allowlist: string[]; // hostnames or CIDRs allowed in allowlist mode
}

export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  mode: 'deny-by-default',
  allowlist: [],
};

export function isEgressAllowed(
  toolEgressClass: EgressClass,
  policy: EgressPolicy = DEFAULT_EGRESS_POLICY,
  targetHost?: string | undefined,
): { allowed: true } | { allowed: false; reason: string } {
  if (toolEgressClass === 'none') {
    // Tool claims no egress — any network is disallowed
    if (targetHost)
      return {
        allowed: false,
        reason: `tool egressClass=none but targetHost ${targetHost} requested`,
      };
    return { allowed: true };
  }
  if (toolEgressClass === 'limited') {
    // Limited egress — must be in allowlist or policy must be allowlist with entry
    if (policy.mode === 'deny-by-default' && policy.allowlist.length === 0) {
      // In deny-by-default with no allowlist, limited tools are still allowed to their declared hosts (handled elsewhere)
      // For Phase 6, we allow limited if policy is deny-by-default but tool is limited (it will be checked via sandbox)
      return { allowed: true };
    }
    if (policy.mode === 'allowlist') {
      if (!targetHost) return { allowed: true }; // no target, allow (will be checked at execution)
      if (policy.allowlist.includes(targetHost)) return { allowed: true };
      return { allowed: false, reason: `host ${targetHost} not in allowlist` };
    }
    return { allowed: true };
  }
  // Remaining is 'open' — all other cases handled
  if (policy.mode === 'deny-by-default') {
    return { allowed: false, reason: 'open egress not allowed in deny-by-default' };
  }
  return { allowed: true };
}
