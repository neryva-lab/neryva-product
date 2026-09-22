/**
 * index.ts — memory-retrieval barrel (Engine-mediated, no direct DB/vector creds)
 * Source: agent_studio_implementation_plan.md:1030-1055
 */
export * from './retrieval-policy.js';
export * from './query-planner.js';
export * from './citation-mapper.js';
export * from './result-limits.js';
export * from './memory-client.js';
export * from './knowledge-client.js';

export const PACKAGE_NAME = '@neryva/memory-retrieval';
