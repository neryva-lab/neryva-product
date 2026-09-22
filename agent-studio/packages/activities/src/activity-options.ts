/**
 * activity-options.ts — per-Activity class timeout/retry as Temporal ActivityOptions
 * Source: agent_studio_implementation_plan.md:813-825
 * No blanket retry. Distinct policies for provider/read-only/effectful/approval/artifact/MCP finalization.
 * Used in packages/workflows via proxyActivities({ retry, ...timeouts }).
 * Keep in @neryva/activities so worker can hydrate with same policies; workflows import only types.
 */

export interface RetryPolicy {
  maximumAttempts: number;
  initialInterval: string;
  backoffCoefficient: number;
  maximumInterval: string;
  nonRetryableErrorTypes: string[];
}

export interface ActivityTimeouts {
  scheduleToStartTimeout: string;
  startToCloseTimeout: string;
  heartbeatTimeout?: string | undefined;
}

export interface ActivityOptions extends ActivityTimeouts {
  retry: RetryPolicy;
}

export const ACTIVITY_OPTIONS = {
  mcp: {
    scheduleToStartTimeout: '10s',
    startToCloseTimeout: '15s',
    heartbeatTimeout: undefined,
    retry: {
      maximumAttempts: 3,
      initialInterval: '200ms',
      backoffCoefficient: 2,
      maximumInterval: '2s',
      nonRetryableErrorTypes: [
        'SCOPE_MISMATCH',
        'CAPABILITY_DENIED',
        'TERMINAL_RUN',
        'PROTOCOL_MISMATCH',
      ],
    },
  } satisfies ActivityOptions,
  context: {
    scheduleToStartTimeout: '10s',
    startToCloseTimeout: '20s',
    heartbeatTimeout: undefined,
    retry: {
      maximumAttempts: 2,
      initialInterval: '200ms',
      backoffCoefficient: 2,
      maximumInterval: '1s',
      nonRetryableErrorTypes: ['SCOPE_MISMATCH', 'CAPABILITY_EXPIRED', 'UNAUTHORIZED_CONTEXT'],
    },
  } satisfies ActivityOptions,
  model: {
    scheduleToStartTimeout: '10s',
    startToCloseTimeout: '60s',
    heartbeatTimeout: '20s',
    retry: {
      maximumAttempts: 2,
      initialInterval: '500ms',
      backoffCoefficient: 2,
      maximumInterval: '2s',
      nonRetryableErrorTypes: [
        'PROVIDER_AUTH_FAILED',
        'INVALID_REQUEST',
        'UNSUPPORTED_FEATURE',
        'BUDGET_EXHAUSTED',
      ],
    },
  } satisfies ActivityOptions,
  toolReadOnly: {
    scheduleToStartTimeout: '10s',
    startToCloseTimeout: '30s',
    heartbeatTimeout: '15s',
    retry: {
      maximumAttempts: 2,
      initialInterval: '200ms',
      backoffCoefficient: 2,
      maximumInterval: '1s',
      nonRetryableErrorTypes: ['TOOL_NOT_FOUND', 'SCHEMA_VALIDATION_FAILED', 'POLICY_DENIED'],
    },
  } satisfies ActivityOptions,
  toolEffectful: {
    scheduleToStartTimeout: '10s',
    startToCloseTimeout: '45s',
    heartbeatTimeout: '15s',
    retry: {
      maximumAttempts: 1,
      initialInterval: '200ms',
      backoffCoefficient: 2,
      maximumInterval: '1s',
      nonRetryableErrorTypes: [
        'TOOL_NOT_FOUND',
        'APPROVAL_DENIED',
        'POLICY_DENIED',
        'UNKNOWN_OUTCOME',
      ],
    },
  } satisfies ActivityOptions,
  approval: {
    scheduleToStartTimeout: '10s',
    startToCloseTimeout: '15s',
    heartbeatTimeout: undefined,
    retry: {
      maximumAttempts: 2,
      initialInterval: '200ms',
      backoffCoefficient: 2,
      maximumInterval: '1s',
      nonRetryableErrorTypes: ['APPROVAL_ALREADY_DECIDED', 'SCOPE_MISMATCH'],
    },
  } satisfies ActivityOptions,
  artifact: {
    scheduleToStartTimeout: '10s',
    startToCloseTimeout: '30s',
    heartbeatTimeout: '15s',
    retry: {
      maximumAttempts: 2,
      initialInterval: '200ms',
      backoffCoefficient: 2,
      maximumInterval: '1s',
      nonRetryableErrorTypes: ['ARTIFACT_NOT_FOUND', 'CHECKSUM_MISMATCH', 'ARTIFACT_EXPIRED'],
    },
  } satisfies ActivityOptions,
  memory: {
    scheduleToStartTimeout: '10s',
    startToCloseTimeout: '20s',
    heartbeatTimeout: undefined,
    retry: {
      maximumAttempts: 2,
      initialInterval: '200ms',
      backoffCoefficient: 2,
      maximumInterval: '1s',
      nonRetryableErrorTypes: ['SCOPE_MISMATCH', 'UNAUTHORIZED_RETRIEVAL'],
    },
  } satisfies ActivityOptions,
  finalization: {
    scheduleToStartTimeout: '10s',
    startToCloseTimeout: '15s',
    heartbeatTimeout: undefined,
    retry: {
      maximumAttempts: 5,
      initialInterval: '200ms',
      backoffCoefficient: 2,
      maximumInterval: '2s',
      nonRetryableErrorTypes: ['SCOPE_MISMATCH', 'TERMINAL_RUN', 'ALREADY_COMMITTED'],
    },
  } satisfies ActivityOptions,
} as const;

export type ActivityClass = keyof typeof ACTIVITY_OPTIONS;

/**
 * Temporal ActivityOptions shape compatible with @temporalio/workflow proxyActivities.
 * Workflows can spread this into proxyActivities({ startToCloseTimeout, retry, ... }).
 */
export function toTemporalActivityOptions(klass: ActivityClass) {
  const o = ACTIVITY_OPTIONS[klass];
  return {
    scheduleToStartTimeout: o.scheduleToStartTimeout,
    startToCloseTimeout: o.startToCloseTimeout,
    heartbeatTimeout: o.heartbeatTimeout,
    retry: {
      maximumAttempts: o.retry.maximumAttempts,
      initialInterval: o.retry.initialInterval,
      backoffCoefficient: o.retry.backoffCoefficient,
      maximumInterval: o.retry.maximumInterval,
      nonRetryableErrorTypes: [...o.retry.nonRetryableErrorTypes],
    },
  };
}
