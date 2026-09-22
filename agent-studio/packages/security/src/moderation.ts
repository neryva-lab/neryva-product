/**
 * moderation.ts — runtime moderation + output guardrails port (FL-1.4).
 *
 * Mirror of the Engine's canonical port (engine/src/common/guardrails/moderation.ts)
 * — same provider contract (OpenAI-compatible /v1/moderations), same verdict
 * shape, same fail-closed discipline. Studio consumes it inside the run loop:
 *
 *   (a) user input at run start,
 *   (b) assistant output before CommitRunResult.
 *
 * A block writes a `GUARDRAIL_BLOCKED` RunWarning and fails the run — content
 * that lost the moderation race never reaches the conversation record.
 */

export type ModerationVerdict = 'allow' | 'flag' | 'block';

export interface ModerationResult {
  verdict: ModerationVerdict;
  categories: string[];
  provider: string;
}

export type ModerationDirection = 'input' | 'output';

export interface ModerationHook {
  classify(content: string, direction: ModerationDirection): Promise<ModerationResult>;
}

/** Dev/test default — classifies nothing, allows everything. */
export const noopModerationHook: ModerationHook = {
  async classify(): Promise<ModerationResult> {
    return { verdict: 'allow', categories: [], provider: 'noop' };
  },
};

/**
 * OpenAI-compatible /v1/moderations classifier — the de-facto standard shape
 * exposed by OpenAI, LiteLLM (guardrails proxy), and self-hosted PromptGuard
 * style gateways. All flagged categories block.
 */
export class OpenAiCompatibleModerationHook implements ModerationHook {
  constructor(
    private readonly opts: {
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
      /** Availability failures block instead of allow. */
      failClosed: boolean;
    },
  ) {}

  async classify(content: string, direction: ModerationDirection): Promise<ModerationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    timer.unref();
    try {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/v1/moderations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.opts.model, input: content }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`moderation provider HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        results?: Array<{ flagged?: boolean; categories?: Record<string, boolean> }>;
      };
      const first = body.results?.[0];
      const categories = Object.entries(first?.categories ?? {})
        .filter(([, flagged]) => flagged)
        .map(([name]) => name);
      const flagged = first?.flagged === true || categories.length > 0;
      return {
        verdict: flagged ? 'block' : 'allow',
        categories,
        provider: 'openai_compatible',
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (this.opts.failClosed) {
        // Production: availability failure must not pass content.
        return {
          verdict: 'block',
          categories: [`moderation_unavailable:${direction}:${reason}`.slice(0, 128)],
          provider: 'openai_compatible',
        };
      }
      // Development: a dead local classifier must not wedge every run.
      return { verdict: 'allow', categories: [], provider: 'openai_compatible:degraded' };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface ModerationConfig {
  provider: 'noop' | 'openai_compatible';
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  isProduction: boolean;
}

/** Resolve the hook from config. Misconfiguration fails closed at boot. */
export function resolveModerationHook(cfg: ModerationConfig): ModerationHook {
  if (cfg.provider === 'noop') {
    return noopModerationHook;
  }
  if (!cfg.baseUrl) {
    throw new Error('HARNESS__MODERATION_BASE_URL is required when HARNESS__MODERATION_PROVIDER=openai_compatible');
  }
  return new OpenAiCompatibleModerationHook({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    failClosed: cfg.isProduction,
  });
}

/**
 * Guardrail policy resolution — maps the pinned `guardrail_policy` strings
 * ({input_policy, output_policy}) to behavior. 'off' disables screening for
 * that direction; 'strict' blocks on 'flag' verdicts in addition to 'block'.
 * Unknown strings resolve to the default policy (screen, block on block).
 */
export interface ResolvedGuardrailPolicy {
  input: { enabled: boolean; blockOnFlag: boolean };
  output: { enabled: boolean; blockOnFlag: boolean };
}

export function resolveGuardrailPolicy(
  policy: { input_policy?: string | undefined; output_policy?: string | undefined } | null | undefined,
): ResolvedGuardrailPolicy {
  const resolve = (value: string | undefined): { enabled: boolean; blockOnFlag: boolean } => {
    if (value === 'off' || value === 'disabled') return { enabled: false, blockOnFlag: false };
    if (value === 'strict') return { enabled: true, blockOnFlag: true };
    // 'default', 'brand-safe', and any unknown string screen by default —
    // org-authored names may expand, but they never silently disable safety.
    return { enabled: true, blockOnFlag: false };
  };
  return {
    input: resolve(policy?.input_policy),
    output: resolve(policy?.output_policy),
  };
}

/**
 * Screen one content surface. Returns null when the direction is disabled by
 * policy or the verdict passes; returns the blocking result otherwise.
 */
export async function moderateContent(
  hook: ModerationHook,
  policy: ResolvedGuardrailPolicy,
  content: string,
  direction: ModerationDirection,
): Promise<ModerationResult | null> {
  if (!policy[direction].enabled) {
    return null;
  }
  const result = await hook.classify(content, direction);
  if (result.verdict === 'block') return result;
  if (result.verdict === 'flag' && policy[direction].blockOnFlag) return result;
  return null;
}
