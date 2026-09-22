/**
 * main.ts — tool-worker entry, OTel first, fail-closed
 */

import { initTelemetry } from '@neryva/telemetry';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  initTelemetry({
    serviceName: config.serviceName,
    serviceVersion: config.buildVersion,
    environment: config.environment,
    exporterEndpoint: config.telemetry.exporterEndpoint,
    samplingPolicy: 'parentbased_always_on',
  });
  const { createWorker } = await import('./worker.js');
  const worker = await createWorker(config);
  const shutdown = async () => {
    await worker.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await worker.run();
}

main().catch((err) => {
  console.error('[tool-worker] fatal:', err);
  process.exit(1);
});
