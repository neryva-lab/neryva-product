/**
 * index.ts — context-compiler barrel (pure, deterministic, no network)
 * Responsibilities: token budgeting (466), message ordering (467), summary insertion (468),
 * memory selection (469), retrieval filtering (470), hybrid retrieval note (471),
 * tool schema selection (472), provider format conversion (473), truncation (474),
 * prompt-cache prep (476), citation tracking (477).
 */

export * from './context-inputs.js';
export * from './citations.js';
export * from './history-selector.js';
export * from './summary-selector.js';
export * from './memory-selector.js';
export * from './knowledge-selector.js';
export * from './tool-selector.js';
export * from './truncation.js';
export * from './provider-format.js';
export * from './compiler.js';
export {
  createBudget,
  reserve,
  canFit,
  mustTruncate,
  countTokensHeuristic,
} from './token-budget.js';
export { toDiagnostics as citationDiagnostics } from './citations.js';
export { toDiagnostics as budgetDiagnostics } from './token-budget.js';

export const PACKAGE_NAME = '@neryva/context-compiler';
