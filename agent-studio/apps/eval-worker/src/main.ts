/**
 * main.ts — eval-worker bootstrap (offline evaluation, after runtime stable)
 * Source: 11.3, 11.5, 533 synthetic data only
 */
import { loadEvalConfig } from './config.js';
import { EvalWorker } from './worker.js';

async function main(): Promise<void> {
  const config = loadEvalConfig();
  const worker = new EvalWorker({ config });
  console.log(`[eval-worker] ${config.serviceName}@${config.buildVersion} started (datasets: ${worker.getStatus().datasets.join(',')}) — synthetic only, testData=true`);
  // In production, would poll evaluation queue; for now, just show status and exit
  const testConv = await worker.runTestConversation({ agentVersion: 'v17', prompt: 'hello' });
  console.log(`[eval-worker] test conversation ${testConv.conversationId} budget ${testConv.budget} testData=${testConv.testData}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[eval-worker] fatal', e);
    process.exit(1);
  });
}

export { main };
