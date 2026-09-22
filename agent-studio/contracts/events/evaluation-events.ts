/**
 * evaluation-events.ts — offline evaluation events (Phase 11, but contract reserved now)
 * Source: agent_studio_implementation_plan.md:1278-1291, 1538-1552 (offline evaluation, regression thresholds)
 * Evaluation never bypasses security tests (1291).
 */
export interface EvaluationEvent {
  evaluationId: string;
  agentVersionId: string;
  modelId: string;
  definitionHash: string;
  datasetVersion: string;
  evaluatorVersion: string;
  passed: boolean;
  score?: number | undefined;
  thresholds?: Record<string, number> | undefined;
}

export const EVALUATION_EVENT_VERSION = '1.0';
