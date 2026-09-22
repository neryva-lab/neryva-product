/**
 * queries.ts — Temporal Queries for current execution state
 * Source: agent_studio_implementation_plan.md:289-305, agent_studio_architecture.md:145
 * Determinism: only @temporalio/workflow.
 */

import { defineQuery } from '@temporalio/workflow';
import type { WorkflowDiagnostics, WorkflowProgress } from './workflow-state.js';

export const getProgressQuery = defineQuery<WorkflowProgress | undefined>('getProgress');
export const getDiagnosticsQuery = defineQuery<WorkflowDiagnostics | undefined>('getDiagnostics');
export const getPendingSignalsQuery = defineQuery<unknown[]>('getPendingSignals');

export const QUERY_NAMES = {
  getProgress: 'getProgress',
  getDiagnostics: 'getDiagnostics',
  getPendingSignals: 'getPendingSignals',
} as const;
