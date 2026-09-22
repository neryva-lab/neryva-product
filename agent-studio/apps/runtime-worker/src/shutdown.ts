/**
 * shutdown.ts — graceful shutdown with deadline
 * Source: agent_studio_implementation_plan.md:98-127
 */

import type { Worker } from './worker.js';

export function createShutdownHandler(worker: Worker, deadlineMs: number) {
  let shuttingDown = false;
  return async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, deadline ${deadlineMs}ms`);
    const timeout = setTimeout(() => {
      console.error('[shutdown] deadline exceeded, forcing exit');
      process.exit(1);
    }, deadlineMs);
    try {
      await worker.shutdown();
      clearTimeout(timeout);
      process.exit(0);
    } catch (err) {
      console.error('[shutdown] error', err);
      process.exit(1);
    }
  };
}
