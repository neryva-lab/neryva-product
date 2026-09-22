/**
 * main.ts — runtime-control entry: Engine-facing RuntimeControlService over
 * ConnectRPC + health/readiness + audited operator controls. OTel first,
 * fail-closed config. The inline executor (EXECUTION_MODE=inline) executes
 * runs directly through the Model Gateway (LiteLLM by default) and the Neryva
 * MCP authority client; EXECUTION_MODE=temporal starts AgentRunWorkflows.
 */

import { initTelemetry } from '@neryva/telemetry';
import { createLiteLLMAdapter } from '@neryva/model-gateway';
import type { ModelGateway } from '@neryva/model-gateway';
import { resolveModerationHook, type ModerationHook } from '@neryva/security';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { createInlineExecutor } from './inline-executor.js';
import { RunCancellationRegistry } from './run-registry.js';
import type { RuntimeControlService } from './routes/internal-control.js';

async function main(): Promise<void> {
  const config = loadConfig();

  initTelemetry({
    serviceName: config.serviceName,
    serviceVersion: config.buildVersion,
    environment: config.environment,
    samplingPolicy: 'parentbased_always_on',
  });

  // Real Temporal client for operator admission (StartRun/CancelRun/query)
  // when EXECUTION_MODE=temporal.
  type TemporalLike = ConstructorParameters<typeof RuntimeControlService>[0];
  let temporal: TemporalLike | undefined;
  if (config.executionMode === 'temporal') {
    const clientMod = await import('@temporalio/client');
    const client = new clientMod.Client({
      connection: await clientMod.Connection.connect({ address: config.temporalAddress }),
      namespace: config.temporalNamespace,
    });
    temporal = {
      async startWorkflow(type, input, opts) {
        const handle = await client.workflow.start(type, {
          args: [input],
          workflowId: opts.workflowId,
          taskQueue: opts.taskQueue,
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
        });
        return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
      },
      async signalWorkflow(workflowId, signalName, payload) {
        const handle = client.workflow.getHandle(workflowId);
        await handle.signal(signalName, payload);
      },
      async updateWorkflow() {
        return { accepted: true, signalId: 'update' };
      },
      async queryWorkflow(workflowId, queryName) {
        const handle = client.workflow.getHandle(workflowId);
        return handle.query(queryName);
      },
      async cancelWorkflow(workflowId) {
        const handle = client.workflow.getHandle(workflowId);
        await handle.cancel();
      },
    };
  }

  // LiteLLM gateway (ADR-009): one OpenAI-compatible endpoint fronts 100+
  // providers, so EVERY provider prefix routes through the same adapter.
  // Without LITELLM_BASE_URL the ModelGateway falls back to its built-in
  // simulation adapters (dev/test only — production fails closed via keys).
  let gateway: ModelGateway | undefined;
  if (config.litellmBaseUrl) {
    const { ModelGateway: Gateway } = await import('@neryva/model-gateway');
    const litellm = createLiteLLMAdapter({
      apiKey: config.litellmApiKey ?? '',
      baseUrl: config.litellmBaseUrl,
    });
    const adapters = new Map(
      ['litellm', 'openai', 'anthropic', 'google'].map(
        (providerId) => [providerId, litellm] as const,
      ),
    );
    gateway = new Gateway({ adapters, allowTestCredentials: false });
  }

  // One cancellation registry shared by the executor and the control
  // service: Engine CancelRun aborts the in-flight provider call (FL-1.3).
  const cancellations = new RunCancellationRegistry();

  // FL-1.4 — runtime moderation hook (fail-closed resolution: a configured
  // provider without a base URL refuses to boot).
  const moderation: ModerationHook = resolveModerationHook({
    provider: config.guardrails.moderationProvider,
    baseUrl: config.guardrails.moderationBaseUrl ?? '',
    apiKey: config.guardrails.moderationApiKey ?? '',
    model: config.guardrails.moderationModel,
    timeoutMs: config.guardrails.moderationTimeoutMs,
    isProduction: config.environment === 'production',
  });

  const inlineExecutor =
    config.executionMode === 'inline'
      ? createInlineExecutor({ config, gateway, cancellations, moderation })
      : undefined;

  const server = await createServer({
    config,
    ...(temporal !== undefined ? { temporal } : {}),
    ...(inlineExecutor !== undefined ? { inlineExecutor } : {}),
    ...(config.executionMode === 'inline' ? { cancellations } : {}),
  });
  const port = await server.listen();
  console.log(`[runtime-control] ready on :${port} (Engine MCP: ${config.mcpEndpoint})`);
}

main().catch((err) => {
  console.error('[runtime-control] fatal:', err);
  process.exit(1);
});
