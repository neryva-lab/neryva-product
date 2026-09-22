/**
 * guardrail-activities.ts — runtime moderation activity (FL-1.4).
 *
 * The Temporal workflow cannot call the moderation provider directly
 * (deterministic workflow, side effects via activities only), so the same
 * screening the inline executor performs in-process is exposed as an
 * activity here: user input at run start, assistant output pre-commit.
 * A blocked surface makes the workflow fail the run GUARDRAIL_BLOCKED —
 * content that lost the moderation race never reaches the Engine.
 */

import { moderateContent, resolveGuardrailPolicy, type ModerationHook } from '@neryva/security';

export interface GuardrailActivityOptions {
  moderation: ModerationHook;
}

export interface ModerateContentParams {
  runId: string;
  /** Content to screen (user message or assistant final text). */
  content: string;
  direction: 'input' | 'output';
  /** Pinned guardrail policy strings from the Engine manifest. */
  policy: { input_policy?: string | undefined; output_policy?: string | undefined };
}

export interface ModerateContentResult {
  blocked: boolean;
  verdict: 'blocked' | 'allowed';
  /** Provider categories when blocked; empty otherwise. No content. */
  categories: string[];
  provider: string;
}

export function createGuardrailActivities(opts: GuardrailActivityOptions) {
  return {
    async moderateContent(params: ModerateContentParams): Promise<ModerateContentResult> {
      const policy = resolveGuardrailPolicy(params.policy);
      const result = await moderateContent(
        opts.moderation,
        policy,
        params.content.slice(0, 32_768),
        params.direction,
      );
      if (result === null) {
        return { blocked: false, verdict: 'allowed', categories: [], provider: 'policy_disabled' };
      }
      return {
        blocked: true,
        verdict: 'blocked',
        categories: result.categories,
        provider: result.provider,
      };
    },
  };
}
