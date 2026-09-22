/**
 * index.ts — tool-gateway barrel (policy enforcement boundary)
 * Source: agent_studio_architecture.md:483-511
 */

export * from './registry.js';
export * from './schema-validation.js';
export * from './effect-policy.js';
export * from './approval-policy.js';
export * from './approval-bridge.js';
export * from './idempotency.js';
export * from './credentials.js';
export * from './egress-policy.js';
export * from './result-redaction.js';
export * from './tool-context.js';
export * from './tool-gateway.js';
export * from './mcp-adapter.js';
export * from './executors/in-process.js';
export * from './executors/activity.js';
export * from './executors/sandbox.js';

export const PACKAGE_NAME = '@neryva/tool-gateway';
