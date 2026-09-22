/**
 * sampling.ts — sampling policy (parentbased, per-tenant fairness)
 * Source: agent_studio_implementation_plan.md:1135-1162 (sampling policy), 1160 (metrics)
 */

export type SamplingPolicy =
  'parentbased_always_on' | 'parentbased_always_off' | 'traceidratio' | 'parentbased_traceidratio';

export interface SamplingConfig {
  policy: SamplingPolicy;
  ratio?: number | undefined; // for traceidratio
  perTenant?: boolean | undefined;
}

export function createSamplingConfig(raw: string): SamplingConfig {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'parentbased_always_on') return { policy: 'parentbased_always_on' };
  if (normalized === 'parentbased_always_off') return { policy: 'parentbased_always_off' };
  if (normalized.startsWith('traceidratio')) {
    const ratio = Number.parseFloat(normalized.split(':')[1] ?? '0.1');
    return { policy: 'traceidratio', ratio };
  }
  if (normalized.startsWith('parentbased_traceidratio')) {
    const ratio = Number.parseFloat(normalized.split(':')[1] ?? '0.1');
    return { policy: 'parentbased_traceidratio', ratio };
  }
  return { policy: 'parentbased_always_on' };
}

export function shouldSample(traceId: string, config: SamplingConfig): boolean {
  if (config.policy === 'parentbased_always_on') return true;
  if (config.policy === 'parentbased_always_off') return false;
  const ratio = config.ratio ?? 0.1;
  // deterministic from traceId
  let hash = 0;
  for (let i = 0; i < traceId.length; i++) hash = (hash * 31 + traceId.charCodeAt(i)) >>> 0;
  return (hash % 1000) / 1000 < ratio;
}
