/**
 * provider.ts — Provider adapter contract (provider types never leak outside model-gateway)
 * Source: agent_studio_implementation_plan.md:890-905, agent_studio_architecture.md:428,432
 * Vercel AI SDK Core or official SDK behind this interface; upgrades via conformance.
 */

import type { NeryvaModelRequest } from '@neryva/contracts/provider/model-request';
import type {
  NeryvaModelResponse,
  NeryvaStreamResult,
} from '@neryva/contracts/provider/model-response';
import type { NeryvaModelCapabilities } from '../capabilities.js';

export interface ProviderAdapter {
  /** Provider identifier, e.g., openai */
  readonly providerId: string;
  /** Capabilities for each model this provider serves */
  readonly models: NeryvaModelCapabilities[];
  /** Whether this adapter is healthy (for routing) */
  isHealthy(): boolean;

  /** Non-streaming generate — full response */
  generate(
    request: NeryvaModelRequest,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<NeryvaModelResponse>;

  /** Streaming — returns async iterable of events */
  stream(
    request: NeryvaModelRequest,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<NeryvaStreamResult>;

  /** Validate request against provider constraints before network */
  validate?(request: NeryvaModelRequest): void;
}

export interface ProviderFactoryOptions {
  /** Static API key — resolved via secret-provider, never logged. Optional when getApiKey is supplied. */
  apiKey?: string;
  /**
   * Per-call credential resolver — preferred over static apiKey so key rotation takes
   * effect without adapter reconstruction. Never logged.
   */
  getApiKey?: () => Promise<string>;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  /**
   * Simulation mode: deterministic test double for the 11-case conformance matrix.
   * Defaults to true when neither apiKey nor getApiKey is provided; MUST be explicitly
   * false (or credentials supplied) for real provider calls.
   */
  simulate?: boolean;
  // For tests: inject fake transport
  transport?: unknown | undefined;
}

export function isSimulationMode(opts: ProviderFactoryOptions): boolean {
  if (opts.simulate !== undefined) return opts.simulate;
  // Real mode requires an explicit per-call credential resolver (getApiKey).
  // A static apiKey alone does NOT flip to real mode — tests use placeholder keys.
  return !opts.getApiKey;
}
