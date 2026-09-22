/**
 * egress.ts — network egress policy
 * Source: agent_studio_implementation_plan.md:231-254, 1018-1029
 */

export type EgressMode = 'deny-by-default' | 'allowlist';

export interface EgressPolicy {
  mode: EgressMode;
  allowlist: string[]; // host patterns, e.g., ["api.openai.com", "*.anthropic.com"]
}

export function isEgressAllowed(policy: EgressPolicy, host: string): boolean {
  if (policy.mode === 'allowlist') {
    return policy.allowlist.some((pattern) => {
      if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
      return host === pattern;
    });
  }
  // deny-by-default: only allow if explicitly in allowlist (empty => deny all)
  if (policy.allowlist.length === 0) return false;
  return policy.allowlist.includes(host);
}

export function assertEgressAllowed(policy: EgressPolicy, host: string): void {
  if (!isEgressAllowed(policy, host)) {
    throw new Error(`egress denied for host ${host} (mode ${policy.mode})`);
  }
}
