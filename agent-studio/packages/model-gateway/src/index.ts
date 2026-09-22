/**
 * index.ts — model-gateway barrel (provider types never leak outside this package)
 * Contracts remain in ../../../contracts/provider — gateway re-exports only normalized types.
 */

export * from './capabilities.js';
export * from './model-catalog.js';
export * from './routing.js';
export * from './retry-policy.js';
export * from './usage.js';
export * from './errors.js';
export * from './redaction.js';
export * from './model-gateway.js';
export * from './providers/provider.js';
export * from './providers/openai.js';
export * from './providers/litellm.js';
export * from './adapters/ai-sdk-adapter.js';
export const PACKAGE_NAME = '@neryva/model-gateway';
