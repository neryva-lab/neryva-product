/**
 * health.ts — liveness/readiness probes
 * Source: agent_studio_implementation_plan.md:521-525, infra/observability
 * Stateless, no business logic, audited via OTel.
 */

export interface HealthStatus {
  status: 'ok' | 'degraded';
  version: string;
  uptimeMs: number;
  checks: Record<string, 'ok' | 'fail'>;
}

const startedAt = Date.now();

export function getLiveness(version: string): HealthStatus {
  return {
    status: 'ok',
    version,
    uptimeMs: Date.now() - startedAt,
    checks: { self: 'ok' },
  };
}

export function getReadiness(
  deps: { temporalReachable: boolean; mcpReachable: boolean },
  version: string,
): HealthStatus {
  const ok = deps.temporalReachable && deps.mcpReachable;
  return {
    status: ok ? 'ok' : 'degraded',
    version,
    uptimeMs: Date.now() - startedAt,
    checks: {
      temporal: deps.temporalReachable ? 'ok' : 'fail',
      mcp: deps.mcpReachable ? 'ok' : 'fail',
    },
  };
}
