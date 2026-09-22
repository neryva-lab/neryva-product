/**
 * routing.test.ts — Engine snapshot → org allowlist → assistant policy → capability → health → adapter; fallback explicit, auditable
 * Source: agent_studio_architecture.md:909-918, 413
 */

import { describe, it, expect } from 'vitest';
import { createCatalog } from '../src/model-catalog.js';
import { CapabilityRegistry, DEFAULT_CAPABILITIES } from '../src/capabilities.js';
import { routeModel } from '../src/routing.js';
import { createOpenAIAdapter } from '../src/providers/openai.js';

function makeAdapters() {
  const m = new Map();
  const openai = createOpenAIAdapter({ apiKey: 'test-key' });
  m.set('openai', openai);
  return m;
}

describe('routing', () => {
  it('routes to requested model when allowed and healthy', () => {
    const registry = new CapabilityRegistry(DEFAULT_CAPABILITIES);
    const catalog = createCatalog(DEFAULT_CAPABILITIES);
    const adapters = makeAdapters();
    const res = routeModel({
      request: {
        requestedModel: 'openai/gpt-4o-mini',
        policySnapshot: {
          organizationId: 'org1',
          allowedModels: ['openai/gpt-4o-mini', 'openai/gpt-4o'],
        },
      },
      catalog,
      adapters,
      registry,
    });
    expect(res.modelId).toBe('openai/gpt-4o-mini');
    expect(res.fallbackUsed).toBe(false);
    expect(res.audit.requested).toBe('openai/gpt-4o-mini');
  });

  it('respects org allowlist — not allowed model is skipped', () => {
    const registry = new CapabilityRegistry(DEFAULT_CAPABILITIES);
    const catalog = createCatalog(DEFAULT_CAPABILITIES);
    const adapters = makeAdapters();
    expect(() =>
      routeModel({
        request: {
          requestedModel: 'openai/gpt-4o',
          policySnapshot: { organizationId: 'org1', allowedModels: ['openai/gpt-4o-mini'] },
        },
        catalog,
        adapters,
        registry,
      }),
    ).toThrow(/no route/);
  });

  it('fallback explicit and auditable when primary not allowed', () => {
    const registry = new CapabilityRegistry(DEFAULT_CAPABILITIES);
    const catalog = createCatalog(DEFAULT_CAPABILITIES);
    const adapters = makeAdapters();
    const res = routeModel({
      request: {
        requestedModel: 'openai/gpt-4o',
        fallbackModels: ['openai/gpt-4o-mini'],
        fallbackEnabled: true,
        policySnapshot: { organizationId: 'org1', allowedModels: ['openai/gpt-4o-mini'] },
      },
      catalog,
      adapters,
      registry,
    });
    expect(res.modelId).toBe('openai/gpt-4o-mini');
    expect(res.fallbackUsed).toBe(true);
    expect(res.audit.reason).toContain('fallback');
  });

  it('fallback disabled — no fallback even if fallbackModels provided', () => {
    const registry = new CapabilityRegistry(DEFAULT_CAPABILITIES);
    const catalog = createCatalog(DEFAULT_CAPABILITIES);
    const adapters = makeAdapters();
    expect(() =>
      routeModel({
        request: {
          requestedModel: 'openai/gpt-4o',
          fallbackModels: ['openai/gpt-4o-mini'],
          fallbackEnabled: false,
          policySnapshot: { organizationId: 'org1', allowedModels: ['openai/gpt-4o-mini'] },
        },
        catalog,
        adapters,
        registry,
      }),
    ).toThrow(/no route/);
  });

  it('never bypasses retention/residency — routing does not consider those for bypass', () => {
    // Policy snapshot may contain retention/residency, but routing still requires allowlist + capability
    const registry = new CapabilityRegistry(DEFAULT_CAPABILITIES);
    const catalog = createCatalog(DEFAULT_CAPABILITIES);
    const adapters = makeAdapters();
    // Allowed list empty means all available models allowed (for test), but we still check capability
    const res = routeModel({
      request: {
        requestedModel: 'openai/gpt-4o-mini',
        policySnapshot: {
          organizationId: 'org1',
          allowedModels: [],
          retention: 'eu',
          residency: 'eu',
        },
      },
      catalog,
      adapters,
      registry,
    });
    expect(res.modelId).toBe('openai/gpt-4o-mini');
  });

  it('skips unhealthy adapter', () => {
    const registry = new CapabilityRegistry(DEFAULT_CAPABILITIES);
    const catalog = createCatalog(DEFAULT_CAPABILITIES);
    const unhealthy = createOpenAIAdapter({ apiKey: 'test-key' });
    // Simulate unhealthy
    (unhealthy as unknown as { isHealthy: () => boolean }).isHealthy = () => false;
    const adapters = new Map([['openai', unhealthy]]);
    expect(() =>
      routeModel({
        request: {
          requestedModel: 'openai/gpt-4o-mini',
          policySnapshot: { organizationId: 'org1', allowedModels: ['openai/gpt-4o-mini'] },
        },
        catalog,
        adapters,
        registry,
      }),
    ).toThrow(/no route/);
  });

  it('fails clearly when no route (unsupported → typed error, not silent degrade)', () => {
    const registry = new CapabilityRegistry(DEFAULT_CAPABILITIES);
    const catalog = createCatalog(DEFAULT_CAPABILITIES);
    const adapters = makeAdapters();
    try {
      routeModel({
        request: {
          requestedModel: 'unknown/model',
          policySnapshot: { organizationId: 'org1', allowedModels: [] },
        },
        catalog,
        adapters,
        registry,
      });
      expect.fail('should throw');
    } catch (e) {
      const err = e as Error;
      expect(err.message).toContain('no route');
    }
  });
});
