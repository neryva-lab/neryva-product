/**
 * fault-injection.ts — fault injection for chaos and failure-matrix tests
 * Source: agent_studio_implementation_plan.md:371-381, 1553-1573
 */

export type Fault =
  | { type: 'crash'; after: 'claim' | 'model' | 'tool' | 'append' | 'commit' }
  | { type: 'timeout'; target: 'model' | 'tool' | 'mcp' }
  | { type: 'duplicate'; count: number }
  | { type: 'lease-expired' }
  | { type: 'capability-expired' };

export class FaultInjector {
  private faults: Fault[] = [];
  private index = 0;

  inject(fault: Fault): void {
    this.faults.push(fault);
  }

  next(): Fault | undefined {
    return this.faults[this.index++];
  }

  shouldCrash(phase: string): boolean {
    return this.faults.some((f) => f.type === 'crash' && (f as { after: string }).after === phase);
  }

  reset(): void {
    this.faults = [];
    this.index = 0;
  }
}
