/**
 * fake-tools.ts — fake Tool Gateway executors for tests
 * Source: agent_studio_implementation_plan.md:231-254
 */

export interface FakeToolResult {
  success: boolean;
  output: unknown;
  artifactRef?: string;
}

export class FakeTools {
  private handlers = new Map<string, (args: Record<string, unknown>) => Promise<FakeToolResult>>();

  register(
    name: string,
    handler: (args: Record<string, unknown>) => Promise<FakeToolResult>,
  ): void {
    this.handlers.set(name, handler);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<FakeToolResult> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`tool not found: ${name}`);
    return handler(args);
  }

  clear(): void {
    this.handlers.clear();
  }
}

// Pre-registered read-only tool for Phase 0 spike
export function createDefaultFakeTools(): FakeTools {
  const tools = new FakeTools();
  tools.register('search_tickets', async () => ({ success: true, output: { tickets: [] } }));
  return tools;
}
