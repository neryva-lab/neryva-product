/**
 * mcp-activities.ts — all Neryva MCP calls live in Activities (never in workflows)
 * Source: agent_studio_implementation_plan.md:801-812, 1373-1379
 * Workflows call these Activities; Activities handle network, retries, and claim-check.
 */

import { NeryvaMcpClient, type NeryvaMcpClientOptions } from '@neryva/neryva-mcp-client';

export interface McpActivitiesOptions {
  client: NeryvaMcpClient;
}

/**
 * Coerce a workflow-side epoch/version into the uint64 bigint the protobuf
 * client requires. Temporal's default payload converter cannot serialize
 * bigint, so workflows must pass plain JSON numbers through activity args
 * (see agent-run-workflow.ts); bigint is still accepted so a direct caller
 * cannot silently lose the fence. Validates BEFORE converting: negatives,
 * fractional numbers, non-safe integers, and bigints outside the safe
 * integer range all throw — never silently truncate.
 */
export function toUint64(value: number | bigint | undefined, field: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `${field} must be a non-negative safe integer, got ${value.toString()}`,
      );
    }
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer, got ${String(value)}`);
  }
  return BigInt(value);
}

export function createMcpActivities(client: NeryvaMcpClient) {
  return {
    // Lease
    async acquireOrRenewRunLease(params: {
      expectedLeaseOwner?: string | undefined;
      /**
       * Workflow-side epoch: a plain JSON number. Temporal's payload
       * converter cannot serialize bigint, so workflows must never pass
       * bigint through activity args; bigint is still accepted for direct
       * (non-Temporal) callers. Coerced to uint64 at this boundary.
       */
      expectedLeaseEpoch?: number | bigint | undefined;
      renewUntil?: Date | undefined;
    }): Promise<unknown> {
      const { expectedLeaseEpoch, ...rest } = params;
      return client.claimRun({
        ...rest,
        expectedLeaseEpoch: toUint64(expectedLeaseEpoch, 'expectedLeaseEpoch'),
      });
    },

    async releaseRunLease(leaseEpoch: number | bigint): Promise<unknown> {
      const epoch = toUint64(leaseEpoch, 'leaseEpoch');
      if (epoch === undefined) throw new Error('leaseEpoch is required');
      return client.releaseRunLease(epoch);
    },

    // Context — sub-ops of GetAuthorizedRunContext (659)
    async getAuthorizedRunContext(requestedPurposes: string[] = []): Promise<unknown> {
      return client.getAuthorizedRunContext(requestedPurposes);
    },

    // Events
    async appendRunEvents(events: Parameters<typeof client.appendRunEvents>[0]): Promise<unknown> {
      return client.appendRunEvents(events);
    },

    // Approval
    async createApprovalRequest(params: {
      approvalId: string;
      toolCallId: string;
      summary?: string | undefined;
      actionType?: string | undefined;
      policyVersion?: string | undefined;
    }): Promise<unknown> {
      return client.createApprovalRequest(params);
    },

    // Memory
    async submitMemoryProposal(params: {
      proposalId: string;
      scope?: string | undefined;
      value: string;
      provenance?: string | undefined;
      confidence?: number | undefined;
      visibility?: string | undefined;
    }): Promise<unknown> {
      return client.submitMemoryProposal(params);
    },

    // Tools
    async authorizeToolCall(params: {
      toolCallId: string;
      stepId: string;
      toolName: string;
      toolVersion: string;
      argumentDigest?: Uint8Array | undefined;
    }): Promise<unknown> {
      return client.authorizeToolCall(params);
    },

    async recordToolOutcome(params: {
      toolCallId: string;
      stepId: string;
      status: string;
      resultDigest?: Uint8Array | undefined;
      resultRef?: Parameters<typeof client.recordToolOutcome>[0]['resultRef'];
    }): Promise<unknown> {
      return client.recordToolOutcome(params);
    },

    // Checkpoint
    async saveCheckpointRef(params: {
      checkpointId: string;
      checkpointVersion: number;
      artifactRef: Parameters<typeof client.saveCheckpointRef>[0]['artifactRef'];
      digest?: Uint8Array | undefined;
      createdAt?: Date | undefined;
    }): Promise<unknown> {
      return client.saveCheckpointRef(params);
    },

    // Terminal — idempotent, exactly once; usage rides the commit (v1.1)
    async commitRunResult(params: {
      resultText: string;
      /** Workflow-side version: a plain JSON number (see lease note above). */
      expectedVersion?: number | bigint | undefined;
      resultArtifact?: Parameters<typeof client.commitRunResult>[0]['resultArtifact'];
      usage?: {
        provider: string;
        model: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      };
      suggestedFollowups?: string[] | undefined;
    }): Promise<unknown> {
      const { expectedVersion, ...rest } = params;
      return client.commitRunResult({
        ...rest,
        expectedVersion: toUint64(expectedVersion, 'expectedVersion'),
      });
    },

    async failRun(params: {
      errorCode: string;
      errorMessage: string;
      /** Workflow-side version: a plain JSON number (see lease note above). */
      expectedVersion?: number | bigint | undefined;
    }): Promise<unknown> {
      const { expectedVersion, ...rest } = params;
      return client.failRun({
        ...rest,
        expectedVersion: toUint64(expectedVersion, 'expectedVersion'),
      });
    },
  };
}

export type McpActivities = ReturnType<typeof createMcpActivities>;

// Factory for tests — uses fake transport via testkit
export function createFakeMcpActivities(opts: NeryvaMcpClientOptions): McpActivities {
  const client = new NeryvaMcpClient(opts);
  return createMcpActivities(client);
}
