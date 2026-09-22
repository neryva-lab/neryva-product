/**
 * outcomes.ts — typed terminal outcomes
 * Source: agent_studio_implementation_plan.md:703-720, 756-770
 */

export type FinalAnswerOutcome = {
  kind: 'FINAL_ANSWER';
  text: string;
  citations?: string[];
};

export type ToolCallOutcome =
  | { kind: 'READ_ONLY_TOOL'; toolId: string; args: Record<string, unknown> }
  | {
      kind: 'EFFECTFUL_TOOL';
      toolId: string;
      args: Record<string, unknown>;
      requiresApproval: boolean;
    };

export type InterpretModelResult =
  | { kind: 'FINAL_ANSWER'; outcome: FinalAnswerOutcome }
  | { kind: 'READ_ONLY_TOOL'; outcome: ToolCallOutcome & { kind: 'READ_ONLY_TOOL' } }
  | { kind: 'EFFECTFUL_TOOL'; outcome: ToolCallOutcome & { kind: 'EFFECTFUL_TOOL' } }
  | { kind: 'USER_INPUT'; signalId: string }
  | { kind: 'HANDOFF'; reason: string };

export type TerminalOutcome =
  | { status: 'COMMIT_RESULT'; answer: FinalAnswerOutcome }
  | { status: 'FAILED'; reason: string; code: string }
  | { status: 'CANCELLED'; reason: string };
