/**
 * worker.ts — eval-worker (11.3 test conversations + 11.5 evaluation)
 * Source: 11.3 isolated budget, marked test data; 11.5 offline/controlled
 * Synthetic data only, never production content; isolated Temporal queue `evaluation`.
 */
import type { EvalConfig } from './config.js';
import { EvaluationRunner } from './runner.js';

export interface EvalWorkerOptions {
  config: EvalConfig;
}

export class EvalWorker {
  private readonly runner: EvaluationRunner;

  constructor(private readonly opts: EvalWorkerOptions) {
    this.runner = new EvaluationRunner(opts.config);
  }

  /** 11.3: Test conversation with isolated budget, marked test data */
  async runTestConversation(params: { agentVersion: string; prompt: string; budgetTokens?: number | undefined }): Promise<{ conversationId: string; testData: true; budget: number }> {
    const budget = params.budgetTokens ?? this.opts.config.budgetTokens;
    if (budget > this.opts.config.budgetTokens) throw new Error('test budget exceeds eval budget');
    // Mark as test data — never mixes canonical trail
    const conversationId = `test_conv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    return { conversationId, testData: true, budget };
  }

  async runEvaluation(params: { agentVersion: string; model: string; definitionHash: string }): Promise<ReturnType<EvaluationRunner['run']>> {
    return this.runner.run(params);
  }

  getStatus(): { service: string; version: string; datasets: string[] } {
    return { service: this.opts.config.serviceName, version: this.opts.config.buildVersion, datasets: this.runner.getDatasets() };
  }
}
