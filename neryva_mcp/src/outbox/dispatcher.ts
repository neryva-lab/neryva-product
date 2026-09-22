/**
 * Outbox dispatcher — insert after commit, dispatch, retry same idempotency key.
 * Reference: neryva_mcp_implementation_plan.md:469, ledger 0.9
 *
 * Spike: in-memory store + fake RuntimeControl dispatcher that calls Studio fake directly.
 * Idempotent StartRun ensures retry does not create second workflow.
 */

import { globalStore } from "../engine/store.js";
import { getRuntimeControlClient } from "../engine/adminClient.js";

export async function dispatchOutboxOnce(): Promise<number> {
  const pending = globalStore.getPendingOutbox();
  let dispatched = 0;
  const client = getRuntimeControlClient();
  for (const rec of pending) {
    try {
      // Dispatch via Engine administrative client (Connect transport) to Studio RuntimeControlService `168-171`
      if (rec.destination === "RuntimeControlService/StartRun") {
        const body = rec.body as { ctx: Record<string, unknown>; assistantVersionId: string; inputMessageId: string; expectedConversationVersion: bigint; capabilityToken: string };
        await client.startRun(body as never);
      } else if (rec.destination === "RuntimeControlService/DeliverRunInput") {
        const body = rec.body as { ctx: Record<string, unknown>; inputId: string; kind?: number; payload?: Uint8Array };
        await client.deliverRunInput(body as never);
      } else if (rec.destination === "RuntimeControlService/CancelRun") {
        const body = rec.body as { ctx: Record<string, unknown>; reason?: string };
        await client.cancelRun(body as never);
      }
      globalStore.markDispatched(rec.id);
      dispatched++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      globalStore.markFailed(rec.id, msg, 5);
    }
  }
  return dispatched;
}

/**
 * Reconciliation: after Engine restart, scan pending outbox and retry.
 * Returns number of recovered dispatches.
 * Reference: neryva_mcp_implementation_plan.md:469,1070
 */
export async function reconcileOutbox(): Promise<{ recovered: number; deadLetters: number }> {
  const pending = globalStore.getPendingOutbox();
  if (pending.length === 0) return { recovered: 0, deadLetters: globalStore.getDeadLetters().length };
  const recovered = await dispatchOutboxOnce();
  return { recovered, deadLetters: globalStore.getDeadLetters().length };
}

export function getDeadLetters() {
  return globalStore.getDeadLetters();
}

/**
 * Demonstrates retry same idempotency key does not duplicate workflow.
 * Call outbox insert twice with same dispatchKey -> dispatcher deduplicates via Runtime's idempotency.
 */
function uuidv7(): string {
  const t = Date.now();
  const timeHex = t.toString(16).padStart(12, "0");
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  const randHex = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  return (
    timeHex.slice(0, 8) +
    "-" +
    timeHex.slice(8, 12) +
    "-7" +
    randHex.slice(1, 4) +
    "-" +
    ((parseInt(randHex.slice(4, 6), 16) & 0x3f | 0x80).toString(16).padStart(2, "0")) +
    randHex.slice(6, 8) +
    "-" +
    randHex.slice(8, 20)
  );
}

export function insertStartRunOutbox(opts: {
  runId: string;
  organizationId: string;
  conversationId: string;
  assistantVersionId: string;
  inputMessageId: string;
  idempotencyKey: string;
}): void {
  const id = `outbox_${opts.runId}_${opts.idempotencyKey}`;
  if (globalStore.outbox.has(id)) return; // already inserted
  globalStore.insertOutbox({
    id,
    destination: "RuntimeControlService/StartRun",
    dispatchKey: opts.idempotencyKey,
    body: {
      ctx: {
        requestId: uuidv7(),
        organizationId: opts.organizationId,
        conversationId: opts.conversationId,
        runId: opts.runId,
        actorId: "engine",
        idempotencyKey: opts.idempotencyKey,
        protocolVersion: "1.0",
        capabilityId: "cap_engine",
      },
      assistantVersionId: opts.assistantVersionId,
      inputMessageId: opts.inputMessageId,
      expectedConversationVersion: 1n,
      capabilityToken: "cap_token_spike",
    },
    runId: opts.runId,
  });
}
