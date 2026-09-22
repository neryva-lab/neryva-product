/*
 * eslint-disable @typescript-eslint/no-unnecessary-condition -- every call below
 * returns `Promise<unknown>` from the generic MCP client; the casts narrow the
 * unknown wire shape and the rule cannot see the `unknown` origin.
 */

/**
 * checkpoint-activities.ts — FL-2.16/2.17 lockstep activities for the
 * Temporal path: durable loop-state checkpoints (putRunArtifact +
 * SaveCheckpointRef through the Engine) and resume reads. The workflow stays
 * deterministic; all I/O happens here against the run-scoped client.
 */

import type { NeryvaMcpClient } from '@neryva/neryva-mcp-client';
import { create } from '@bufbuild/protobuf';
import {
  ArtifactRefSchema,
  type ArtifactRef,
} from '@neryva/mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js';

export interface ModelMessageContent {
  role: string;
  content:
    | string
    | Array<{ type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string }>;
}

export interface CheckpointState {
  messages: ModelMessageContent[];
  turn: number;
  totalPrompt: number;
  totalCompletion: number;
  toolCallsExecuted: number;
}

export interface CheckpointActivityOptions {
  client: NeryvaMcpClient;
}

export function createCheckpointActivities(opts: CheckpointActivityOptions) {
  return {
    /** Save one checkpoint version (best-effort — errors resolve to false). */
    async saveCheckpoint(params: {
      runId: string;
      organizationId: string;
      state: CheckpointState;
    }): Promise<boolean> {
      try {
        const state = JSON.stringify(params.state);
        const put = (await opts.client.putRunArtifact({
          purpose: 'CHECKPOINT',
          mediaType: 'application/json',
          data: Buffer.from(state, 'utf8'),
        })) as unknown as {
          artifact:
            | {
                artifactId: string;
                uri: string;
                mediaType?: string;
                byteLength?: bigint | number;
                sha256?: Uint8Array;
              }
            | undefined;
        } | null;
        const art = put === null ? undefined : put.artifact;
        if (!art || !art.artifactId || !art.uri) {
          return false;
        }
        const ref = create(ArtifactRefSchema, {
          artifactId: art.artifactId,
          uri: art.uri,
          mediaType: art.mediaType ?? 'application/json',
          byteLength: BigInt(Number(art.byteLength ?? 0)),
          sha256: art.sha256 ?? new Uint8Array(),
          encryptionKeyId: '',
        }) as ArtifactRef;
        await opts.client.saveCheckpointRef({
          checkpointId: params.runId,
          checkpointVersion: params.state.turn,
          artifactRef: ref,
        });
        return true;
      } catch {
        return false;
      }
    },

    /** Read the newest checkpoint; null when none exists or it is unreadable. */
    async loadCheckpoint(): Promise<CheckpointState | null> {
      try {
        const cpRaw: unknown = await opts.client.getLatestCheckpoint();
        const cp = cpRaw as {
          checkpointRef: string;
          artifact?: { artifactId: string };
        } | null;
        if (!cp || !cp.checkpointRef || !cp.artifact || !cp.artifact.artifactId) {
          return null;
        }
        const artifact = (await opts.client.getRunArtifact({
          artifactId: cp.artifact.artifactId,
        })) as {
          accessUrl: string;
        };
        if (!artifact.accessUrl) {
          return null;
        }
        const res = await fetch(artifact.accessUrl);
        if (!res.ok) {
          return null;
        }
        const parsedRaw: unknown = JSON.parse(await res.text());
        const parsed = parsedRaw as CheckpointState | undefined;
        if (
          parsed === undefined ||
          !Array.isArray(parsed.messages) ||
          parsed.messages.length === 0
        ) {
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    },
  };
}
