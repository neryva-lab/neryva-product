/**
 * workflow-bundle.ts — deterministic bundle entry for Temporal Worker
 * Source: agent_studio_implementation_plan.md:105-106, 839-848
 * Bundle contains only @temporalio/workflow + @neryva/workflows (deterministic).
 * Never includes provider SDK, pg, fetch, fs, secrets. Verified by pnpm check:generated.
 */

export * from '@neryva/workflows';
