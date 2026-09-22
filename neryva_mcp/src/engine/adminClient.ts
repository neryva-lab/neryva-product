/**
 * Engine administrative client — calls Studio RuntimeControlService via outbox.
 * Reference: neryva_mcp_implementation_plan.md:168-171
 *
 * Engine is the administrative client for `RuntimeControlService` (Studio implements).
 * Calls are dispatched via outbox and retried with same idempotency key.
 */

import { createClient } from "@connectrpc/connect";
import { RuntimeControlService } from "../../neryva-mcp-contract/gen/ts/neryva/mcp/runtime/v1/runtime_pb.js";
import { createTestTransport } from "../shared/transport.js";
import { createRuntimeControlHandlers } from "../studio/runtime.js";

// For spike, we use in-memory transport. In production, this would be HTTP with mTLS + workload identity.
let transport: ReturnType<typeof createTestTransport> | null = null;
let client: ReturnType<typeof createClient<typeof RuntimeControlService>> | null = null;

function getTransport() {
  if (transport) return transport;
  const handlers = createRuntimeControlHandlers();
  transport = createTestTransport((r) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r as any).service(RuntimeControlService, handlers);
  });
  return transport;
}

export function getRuntimeControlClient(): ReturnType<typeof createClient<typeof RuntimeControlService>> {
  if (client) return client;
  client = createClient(RuntimeControlService, getTransport());
  return client;
}

export function clearAdminClient(): void {
  transport = null;
  client = null;
}
