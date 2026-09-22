/**
 * main.ts — runtime-worker entry, OTel first, fail-closed config
 * Source: agent_studio_implementation_plan.md:98-127, 1344
 */

import { initTelemetry } from '@neryva/telemetry';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // OTel must be initialized before any other imports that create spans
  initTelemetry({
    serviceName: config.runtime.serviceName,
    serviceVersion: config.runtime.buildVersion,
    environment: config.runtime.environment,
    exporterEndpoint: config.telemetry.exporterEndpoint,
    samplingPolicy: config.telemetry.samplingPolicy,
  });

  // Dynamic imports after telemetry to ensure instrumentation
  const { createWorker } = await import('./worker.js');
  const { createShutdownHandler } = await import('./shutdown.js');

  const worker = await createWorker(config);
  const shutdown = createShutdownHandler(worker, config.runtime.shutdownDeadlineMs);

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await worker.run();
}

main().catch((err) => {
  console.error('[runtime-worker] fatal:', err);
  process.exit(1);
});
