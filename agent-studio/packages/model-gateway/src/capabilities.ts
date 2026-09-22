/**
 * capabilities.ts — Model capability registry (source of truth for allowed_models)
 * Source: agent_studio_architecture.md:405-414, agent_studio_implementation_plan.md:725-732
 * allowed_models must reference this registry; agent cannot select arbitrary provider string.
 */

export interface NeryvaModelCapabilities {
  modelId: string; // e.g., openai/gpt-4o-mini
  providerId: string; // e.g., openai
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsToolCalling: boolean;
  supportsStructuredOutput: boolean;
  supportsVision: boolean;
  supportsJsonMode: boolean;
  supportsReasoning: boolean;
  // Cost per 1k tokens in cents
  cost: { promptPer1kCents: number; completionPer1kCents: number };
  // Operational
  timeoutMs: number;
  /** Whether model is generally available */
  available: boolean;
  /** Deprecation */
  deprecated?: boolean | undefined;
}

export const DEFAULT_CAPABILITIES: NeryvaModelCapabilities[] = [
  {
    modelId: 'openai/gpt-4o-mini',
    providerId: 'openai',
    displayName: 'GPT-4o Mini',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsStructuredOutput: true,
    supportsVision: true,
    supportsJsonMode: true,
    supportsReasoning: false,
    cost: { promptPer1kCents: 1.5, completionPer1kCents: 6 },
    timeoutMs: 30_000,
    available: true,
  },
  {
    modelId: 'openai/gpt-4o',
    providerId: 'openai',
    displayName: 'GPT-4o',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsStructuredOutput: true,
    supportsVision: true,
    supportsJsonMode: true,
    supportsReasoning: false,
    cost: { promptPer1kCents: 25, completionPer1kCents: 100 },
    timeoutMs: 30_000,
    available: true,
  },
  {
    modelId: 'anthropic/claude-3-5-sonnet',
    providerId: 'anthropic',
    displayName: 'Claude 3.5 Sonnet',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsStructuredOutput: true,
    supportsVision: true,
    supportsJsonMode: false,
    supportsReasoning: false,
    cost: { promptPer1kCents: 30, completionPer1kCents: 150 },
    timeoutMs: 30_000,
    available: true,
  },
  {
    modelId: 'google/gemini-1.5-pro',
    providerId: 'google',
    displayName: 'Gemini 1.5 Pro',
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsStructuredOutput: true,
    supportsVision: true,
    supportsJsonMode: true,
    supportsReasoning: false,
    cost: { promptPer1kCents: 12.5, completionPer1kCents: 50 },
    timeoutMs: 30_000,
    available: true,
  },
  // LiteLLM unified gateway models — representative of 100+ providers https://docs.litellm.ai/docs/providers
  {
    modelId: 'litellm/openai/gpt-4o',
    providerId: 'litellm',
    displayName: 'LiteLLM GPT-4o',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsStructuredOutput: true,
    supportsVision: true,
    supportsJsonMode: true,
    supportsReasoning: false,
    cost: { promptPer1kCents: 25, completionPer1kCents: 100 },
    timeoutMs: 30_000,
    available: true,
  },
  {
    modelId: 'litellm/anthropic/claude-3-5-sonnet',
    providerId: 'litellm',
    displayName: 'LiteLLM Claude 3.5 Sonnet',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsStructuredOutput: true,
    supportsVision: true,
    supportsJsonMode: false,
    supportsReasoning: false,
    cost: { promptPer1kCents: 30, completionPer1kCents: 150 },
    timeoutMs: 30_000,
    available: true,
  },
  {
    modelId: 'litellm/google/gemini-1.5-flash',
    providerId: 'litellm',
    displayName: 'LiteLLM Gemini 1.5 Flash',
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsStructuredOutput: true,
    supportsVision: true,
    supportsJsonMode: true,
    supportsReasoning: false,
    cost: { promptPer1kCents: 7.5, completionPer1kCents: 30 },
    timeoutMs: 30_000,
    available: true,
  },
  {
    modelId: 'litellm/groq/llama-3.3-70b',
    providerId: 'litellm',
    displayName: 'LiteLLM Groq Llama 3.3 70B',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsStructuredOutput: false,
    supportsVision: false,
    supportsJsonMode: false,
    supportsReasoning: false,
    cost: { promptPer1kCents: 5.9, completionPer1kCents: 7.9 },
    timeoutMs: 30_000,
    available: true,
  },
  {
    modelId: 'litellm/bedrock/anthropic.claude-3-5-sonnet',
    providerId: 'litellm',
    displayName: 'LiteLLM Bedrock Claude',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsStructuredOutput: true,
    supportsVision: true,
    supportsJsonMode: false,
    supportsReasoning: false,
    cost: { promptPer1kCents: 30, completionPer1kCents: 150 },
    timeoutMs: 30_000,
    available: true,
  },
  {
    modelId: 'litellm/azure/gpt-4o',
    providerId: 'litellm',
    displayName: 'LiteLLM Azure GPT-4o',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsStructuredOutput: true,
    supportsVision: true,
    supportsJsonMode: true,
    supportsReasoning: false,
    cost: { promptPer1kCents: 25, completionPer1kCents: 100 },
    timeoutMs: 30_000,
    available: true,
  },
  {
    modelId: 'litellm/mistral/mistral-large',
    providerId: 'litellm',
    displayName: 'LiteLLM Mistral Large',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsStructuredOutput: true,
    supportsVision: false,
    supportsJsonMode: true,
    supportsReasoning: false,
    cost: { promptPer1kCents: 20, completionPer1kCents: 60 },
    timeoutMs: 30_000,
    available: true,
  },
  {
    modelId: 'litellm/together_ai/meta-llama/Llama-3.3-70B',
    providerId: 'litellm',
    displayName: 'LiteLLM Together AI Llama 3.3',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsStreaming: true,
    supportsToolCalling: false,
    supportsStructuredOutput: false,
    supportsVision: false,
    supportsJsonMode: false,
    supportsReasoning: false,
    cost: { promptPer1kCents: 8, completionPer1kCents: 8 },
    timeoutMs: 30_000,
    available: true,
  },
  {
    modelId: 'litellm/cohere/command-r-plus',
    providerId: 'litellm',
    displayName: 'LiteLLM Cohere Command R+',
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsStructuredOutput: false,
    supportsVision: false,
    supportsJsonMode: false,
    supportsReasoning: false,
    cost: { promptPer1kCents: 30, completionPer1kCents: 30 },
    timeoutMs: 30_000,
    available: true,
  },
  {
    modelId: 'litellm/deepseek/deepseek-chat',
    providerId: 'litellm',
    displayName: 'LiteLLM DeepSeek Chat',
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsStructuredOutput: true,
    supportsVision: false,
    supportsJsonMode: true,
    supportsReasoning: false,
    cost: { promptPer1kCents: 1.4, completionPer1kCents: 2.8 },
    timeoutMs: 30_000,
    available: true,
  },
];

export class CapabilityRegistry {
  private readonly map = new Map<string, NeryvaModelCapabilities>();

  constructor(caps: NeryvaModelCapabilities[] = DEFAULT_CAPABILITIES) {
    for (const c of caps) this.map.set(c.modelId, c);
  }

  get(modelId: string): NeryvaModelCapabilities | undefined {
    return this.map.get(modelId);
  }

  has(modelId: string): boolean {
    return this.map.has(modelId);
  }

  list(): NeryvaModelCapabilities[] {
    return [...this.map.values()];
  }

  listAvailable(): NeryvaModelCapabilities[] {
    return this.list().filter((c) => c.available && !c.deprecated);
  }

  require(modelId: string): NeryvaModelCapabilities {
    const c = this.get(modelId);
    if (!c) throw new Error(`UNKNOWN_MODEL: ${modelId} not in capability registry`);
    return c;
  }

  supports(
    modelId: string,
    feature: keyof Pick<
      NeryvaModelCapabilities,
      'supportsStreaming' | 'supportsToolCalling' | 'supportsStructuredOutput'
    >,
  ): boolean {
    const c = this.get(modelId);
    if (!c) return false;
    return Boolean(c[feature]);
  }
}

export const LITELLM_CAPABILITIES: NeryvaModelCapabilities[] = DEFAULT_CAPABILITIES.filter(
  (c) => c.providerId === 'litellm',
);

export const GLOBAL_CAPABILITY_REGISTRY = new CapabilityRegistry(DEFAULT_CAPABILITIES);
