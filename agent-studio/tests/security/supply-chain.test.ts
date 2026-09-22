/**
 * supply-chain.test.ts — 10.8 lockfiles pinned, SBOM, signed artifacts, DAG, container, SAST
 * Source: 1526, 1322, 491-503
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';

describe('10.8 Supply chain', () => {
  it('lockfiles pinned — pnpm-lock.yaml exists and packageManager pinned', () => {
    expect(fs.existsSync('pnpm-lock.yaml')).toBe(true);
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    expect(pkg.packageManager).toMatch(/pnpm@/);
  });

  it('DAG clean — workflow bundle keeps deterministic imports (no pg/drizzle/provider SDK/fetch/env)', () => {
    // The real invariant: packages/workflows/src must stay deterministic —
    // no Engine DB, no provider SDK, no ambient nondeterminism. Scans every
    // source file, not a sample: a violation here fails loudly.
    const src = join('packages', 'workflows', 'src');
    const files = fs.readdirSync(src, { recursive: true } as unknown as object) as string[];
    const forbidden: Array<[RegExp, string]> = [
      [/from\s+['"]pg['"]/, 'pg (Engine DB)'],
      [/from\s+['"]drizzle-orm['"]/, 'drizzle-orm (Engine DB)'],
      [/from\s+['"]ai['"]/, 'provider SDK "ai"'],
      [/from\s+['"]@ai-sdk\//, 'provider SDK @ai-sdk'],
      [/from\s+['"]openai['"]/, 'provider SDK openai'],
      [/from\s+['"]@anthropic-ai\//, 'provider SDK @anthropic-ai'],
      [/\bDate\.now\(/, 'Date.now() (nondeterministic)'],
      [/\bMath\.random\(/, 'Math.random() (nondeterministic)'],
      [/process\.env/, 'process.env (nondeterministic)'],
      [/\bsetTimeout\(/, 'setTimeout (nondeterministic)'],
      [/\bfetch\s*\(/, 'fetch (network)'],
    ];
    let scanned = 0;
    for (const f of files as unknown as string[]) {
      if (!String(f).endsWith('.ts')) continue;
      const full = join(src, String(f));
      const content = fs.readFileSync(full, 'utf8');
      scanned += 1;
      for (const [re, label] of forbidden) {
        expect(content, `${f} must not contain ${label}`).not.toMatch(re);
      }
    }
    expect(scanned).toBeGreaterThan(0);
  });

  it('container — Dockerfiles present', () => {
    expect(fs.existsSync('infra/docker/runtime-worker.Dockerfile')).toBe(true);
    expect(fs.existsSync('infra/docker/tool-worker.Dockerfile')).toBe(true);
  });
});
