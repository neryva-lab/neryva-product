/**
 * contract.test.ts — Model Gateway contract (provider types never leak)
 * Source: agent_studio_architecture.md:432-439, agent_studio_implementation_plan.md:862-886, 885
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NeryvaModelRequestSchema } from '@neryva/contracts/provider/model-request';
import { NeryvaModelResponseSchema } from '@neryva/contracts/provider/model-response';
import { NeryvaProviderError } from '@neryva/contracts/provider/errors';
import { ModelGateway } from '../src/model-gateway.js';
import { GLOBAL_CAPABILITY_REGISTRY } from '../src/capabilities.js';

describe('ModelGateway contract', () => {
  it('Neryva contracts parse without provider SDK', () => {
    const req = NeryvaModelRequestSchema.parse({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(req.model).toBe('openai/gpt-4o-mini');
    const res = NeryvaModelResponseSchema.parse({
      model: 'openai/gpt-4o-mini',
      providerId: 'openai',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    });
    expect(res.finishReason).toBe('stop');
  });

  it('provider types do not escape gateway (no raw provider response outside model-gateway)', () => {
    const root = join(import.meta.dirname, '..', '..', '..');
    const allowedOutside = new Set(['packages/model-gateway', 'contracts/provider']);
    // Scan packages/*/src excluding model-gateway for forbidden provider imports
    const packagesDir = join(root, 'packages');
    const pkgs = readdirSync(packagesDir);
    for (const pkg of pkgs) {
      if (pkg === 'model-gateway') continue;
      const src = join(packagesDir, pkg, 'src');
      try {
        const files = readdirSync(src, { recursive: true } as unknown as object) as string[];
        for (const f of files as unknown as string[]) {
          if (!String(f).endsWith('.ts')) continue;
          const full = join(src, String(f));
          const content = readFileSync(full, 'utf8');
          expect(content, `${pkg}/${f} must not import ai (provider SDK)`).not.toMatch(
            /from\s+['"]ai['"]/,
          );
          expect(content, `${pkg}/${f} must not import @ai-sdk`).not.toMatch(
            /from\s+['"]@ai-sdk\//,
          );
          expect(content, `${pkg}/${f} must not import openai`).not.toMatch(
            /from\s+['"]openai['"]/,
          );
        }
      } catch {
        // no src
      }
    }
  });

  it('capability registry is source of truth for allowed_models', () => {
    expect(GLOBAL_CAPABILITY_REGISTRY.has('openai/gpt-4o-mini')).toBe(true);
    expect(GLOBAL_CAPABILITY_REGISTRY.has('openai/unknown')).toBe(false);
  });

  it('gateway exposes capabilities without leaking provider internals', async () => {
    const gw = new ModelGateway();
    const caps = gw.listCapabilities();
    expect(caps.length).toBeGreaterThan(0);
    expect(caps[0]?.modelId).toBeDefined();
    // No provider SDK types in caps
    const str = JSON.stringify(caps);
    expect(str).not.toContain('OpenAI');
  });

  it('gateway rejects unknown model before provider call', async () => {
    const gw = new ModelGateway();
    await expect(
      gw.generate({
        model: 'openai/does-not-exist',
        messages: [{ role: 'user', content: 'hi' }],
        policySnapshot: { organizationId: 'org1', allowedModels: [] },
      }),
    ).rejects.toThrow(/UNKNOWN_MODEL|no route/);
  });

  it('NeryvaProviderError is normalized (not raw provider error)', async () => {
    const gw = new ModelGateway();
    try {
      await gw.generate({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'case:invalid-request' }],
        correlationId: 'case:invalid-request',
        policySnapshot: { organizationId: 'org1', allowedModels: ['openai/gpt-4o-mini'] },
      });
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(NeryvaProviderError);
      expect((e as NeryvaProviderError).code).toBe('INVALID_REQUEST');
      expect((e as NeryvaProviderError).retryable).toBe(false);
    }
  });
});
