/**
 * fake-model.ts — fake Model Gateway provider for deterministic unit tests
 * Source: agent_studio_implementation_plan.md:200-229, 1248-1251
 * Never use live provider in PR tests; live contract tests run in scheduled pipeline with spending limits.
 */

export interface FakeModelResponse {
  text: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: 'stop' | 'tool-call' | 'length' | 'content-filter';
}

export class FakeModel {
  private responses: FakeModelResponse[] = [];
  private callCount = 0;

  enqueue(response: FakeModelResponse): void {
    this.responses.push(response);
  }

  async generate(): Promise<FakeModelResponse> {
    const res = this.responses[this.callCount % this.responses.length] ?? { text: 'fake response' };
    this.callCount++;
    // Deterministic — no Date.now/Math.random
    return structuredClone(res);
  }

  getCallCount(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
    this.responses = [];
  }
}
