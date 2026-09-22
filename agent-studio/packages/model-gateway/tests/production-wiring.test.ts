/**
 * production-wiring.test.ts — regression: ModelGateway in production wiring
 * (allowTestCredentials:false + secretProvider + credentialRefs, no pre-built
 * adapters) must route and resolve credentials per call.
 *
 * Bug: routeModel skips candidates with no pre-existing healthy adapter, but
 * adapters were only materialized in ensureAdapter AFTER routing succeeded —
 * so every production callModel threw NOT_FOUND before any credential was
 * resolved. Fixed by pre-warming candidate providers' adapters before routing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModelGateway } from '../src/model-gateway.js';
import { InMemorySecretProvider, type SecretProvider } from '@neryva/security';

const CANNED = {
  id: 'chatcmpl-regression',
  object: 'chat_completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'wave2 regression says hi' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
};

const POLICY = {
  organizationId: 'org1',
  allowedModels: ['openai/gpt-4o-mini'],
};

function stubOpenAiFetch(capture: { authorization: string | null; calls: number }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: { headers?: unknown }) => {
      capture.calls += 1;
      capture.authorization = new Headers(init?.headers as HeadersInit).get('authorization');
      return new Response(JSON.stringify(CANNED), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function productionGateway(secrets: SecretProvider) {
  return new ModelGateway({
    allowTestCredentials: false,
    secretProvider: secrets,
    credentialRefs: { openai: 'model:openai' },
  });
}

describe('production wiring (lazy adapters)', () => {
  it('routes and delivers the per-call resolved credential to the provider', async () => {
    const capture = { authorization: null as string | null, calls: 0 };
    stubOpenAiFetch(capture);
    const secrets = new InMemorySecretProvider();
    secrets.set('model:openai', 'sk-regression-key');
    const gw = productionGateway(secrets);

    const res = await gw.generate({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      organizationId: 'org1',
      policySnapshot: POLICY,
    });

    expect(res.text).toContain('wave2 regression says hi');
    expect(capture.calls).toBeGreaterThan(0);
    // the resolved credential — and only it — reaches the provider as the bearer
    expect(capture.authorization).toBe('Bearer sk-regression-key');
  });

  it('missing credential fails closed with the credential error, not NOT_FOUND', async () => {
    // mirrors EngineSecretProvider's fail-loud contract on an empty credential
    const secrets = {
      resolve: async () => {
        throw new Error('PROVIDER_CREDENTIAL_MISSING:openai');
      },
    };
    const gw = productionGateway(secrets);

    await expect(
      gw.generate({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
        organizationId: 'org1',
        policySnapshot: POLICY,
      }),
    ).rejects.toThrow(/PROVIDER_CREDENTIAL_MISSING:openai/);
  });

  it('unknown model still fails NOT_FOUND without consulting the secret provider', async () => {
    const secrets = new InMemorySecretProvider();
    secrets.set('model:openai', 'sk-regression-key');
    const resolveSpy = vi.spyOn(secrets, 'resolve');
    const gw = productionGateway(secrets);

    await expect(
      gw.generate({
        model: 'nope/nonexistent',
        messages: [{ role: 'user', content: 'hello' }],
        organizationId: 'org1',
        policySnapshot: POLICY,
      }),
    ).rejects.toThrow(/no route/);
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
