/**
 * approval-ids.ts — call-ID → Engine approval-ID bookkeeping.
 *
 * Regression for the Wave 4 smoke gap: the workflow waited for each approval
 * decision, but on APPROVED the call re-entered the runnable set WITHOUT its
 * approval ID — so executeTool hit the gateway with a MUTATING call and no
 * approvalId, and the gateway rejected it with APPROVAL_REQUIRED *after the
 * user had approved*. The map below is the single place that binds an
 * approved call to the ID that must ride into execution.
 *
 * Pure + deterministic: safe to import from workflow code and to unit test.
 */
export class ApprovalIdMap {
  private readonly byCallId = new Map<string, string>();

  /** Record the Engine approval ID for an APPROVED call. */
  recordApproved(callId: string, approvalId: string): void {
    this.byCallId.set(callId, approvalId);
  }

  /**
   * Resolve the approval ID to pass into tool execution for this call, or
   * undefined when the call was not approval-gated (READ_ONLY) or was denied.
   */
  forExecution(callId: string): string | undefined {
    return this.byCallId.get(callId);
  }

  /** Drop bookkeeping for a call that will never execute (denied/over-budget). */
  forget(callId: string): void {
    this.byCallId.delete(callId);
  }
}
