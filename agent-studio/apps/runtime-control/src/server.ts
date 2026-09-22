/**
 * server.ts — Engine-facing ConnectRPC host for RuntimeControlService plus
 * health/readiness. This is the leg the Engine's dispatch consumer calls; it
 * MUST actually listen (the earlier stub only logged, so StartRun had nowhere
 * to land).
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import type { Config } from './config.js';
import { getLiveness, getReadiness } from './routes/health.js';
import { RuntimeControlService } from './routes/internal-control.js';
import { registerRuntimeControlRpc, serviceAuthInterceptor, type RuntimeRpcDeps } from './routes/runtime-rpc.js';
import type { InlineRunExecutor, InlineRunCanceller } from './routes/internal-control.js';
import { RunCancellationRegistry } from './run-registry.js';

export interface ServerHandle {
  listen(): Promise<number>;
  close(): Promise<void>;
  getControlService(): RuntimeControlService;
  /** Run cancellation registry — wired to the inline executor by the host. */
  getCancellations(): RunCancellationRegistry;
}

export interface CreateServerOptions {
  config: Config;
  /** Inline executor (EXECUTION_MODE=inline). Mutually exclusive with temporal. */
  inlineExecutor?: InlineRunExecutor | undefined;
  /** Real Temporal client facade (EXECUTION_MODE=temporal). */
  temporal?: ConstructorParameters<typeof RuntimeControlService>[0];
  mcp?: ConstructorParameters<typeof RuntimeControlService>[1];
  /** Cancellation registry — created here when the inline executor is present. */
  cancellations?: RunCancellationRegistry | undefined;
}

export async function createServer(options: CreateServerOptions): Promise<ServerHandle> {
  const { config } = options;
  const taskQueue = config.temporalTaskQueue;

  const fakeTemporal: ConstructorParameters<typeof RuntimeControlService>[0] = options.temporal ?? {
    async startWorkflow(_type, _input, opts) {
      throw new Error(
        `temporal not configured; set EXECUTION_MODE=inline or provide a Temporal client (workflowId ${opts.workflowId})`,
      );
    },
    async signalWorkflow() {},
    async updateWorkflow() {
      return { accepted: true, signalId: 'fake' };
    },
    async queryWorkflow() {
      return undefined;
    },
    async cancelWorkflow() {},
  };

  const cancellations = options.cancellations ?? new RunCancellationRegistry();
  const inlineCancel: InlineRunCanceller | undefined = options.inlineExecutor
    ? (runId, reason) => cancellations.cancel(runId, reason)
    : undefined;

  const control = new RuntimeControlService(
    options.temporal ?? fakeTemporal,
    options.mcp ?? {},
    taskQueue,
    (event, detail) => console.log(`[audit] ${event}`, JSON.stringify(detail)),
    options.inlineExecutor,
    inlineCancel,
  );

  const rpcDeps: RuntimeRpcDeps = {
    control,
    executeInline: options.inlineExecutor ?? (async () => ({ resultText: '' })),
    serviceToken: config.serviceToken,
    requireCapabilityToken: true,
  };

  const connectHandler = connectNodeAdapter({
    routes: (router) => registerRuntimeControlRpc(router, rpcDeps),
    interceptors: [serviceAuthInterceptor(rpcDeps)],
  });

  const server: Server = createHttpServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/healthz' || url === '/readyz') {
      const body =
        url === '/healthz'
          ? getLiveness(config.buildVersion)
          : getReadiness(
              {
                temporalReachable: config.executionMode === 'inline' || options.temporal !== undefined,
                mcpReachable: true,
              },
              config.buildVersion,
            );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    connectHandler(req, res);
  });

  return {
    async listen(): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, '0.0.0.0', () => resolve());
      });
      console.log(
        `[runtime-control] ${config.serviceName}@${config.buildVersion} listening on :${config.port} (${config.environment}) mode=${config.executionMode}`,
      );
      return config.port;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      console.log('[runtime-control] closed');
    },
    getControlService() {
      return control;
    },
    getCancellations() {
      return cancellations;
    },
  };
}
