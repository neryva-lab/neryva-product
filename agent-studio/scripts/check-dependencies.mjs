#!/usr/bin/env node
/**
 * check-dependencies.mjs — package DAG + forbidden-import scan
 * Source: agent_studio_implementation_plan.md:447-503, 1316-1322
 * Enforces: contracts → kernel/definition → gateways/context → activities → workflows → apps
 * Forbidden: pg/drizzle in Studio, provider SDK in workflows, any at auth boundaries, second DB
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

// DAG layers — lower index = lower layer (may not depend on higher)
const LAYERS = [
  { name: 'contracts', pattern: /^contracts\// },
  { name: 'mcp-contract', pattern: /neryva-mcp-contract/ },
  { name: 'kernel/definition', pattern: /^packages\/(agent-kernel|agent-definition)(\/|$)/ },
  {
    name: 'gateways/context',
    pattern:
      /^packages\/(context-compiler|model-gateway|tool-gateway|memory-retrieval|artifacts|telemetry|security)(\/|$)/,
  },
  { name: 'activities', pattern: /^packages\/activities(\/|$)/ },
  { name: 'workflows', pattern: /^packages\/workflows(\/|$)/ },
  { name: 'apps', pattern: /^apps\// },
  { name: 'testkit', pattern: /^packages\/testkit(\/|$)/ }, // testkit is leaf, may depend on anything but prod must not depend on it
];

function layerOf(file) {
  for (let i = 0; i < LAYERS.length; i++) {
    if (LAYERS[i].pattern.test(file)) return i;
  }
  return -1;
}

// Forbidden import patterns — scanned via regex over source files
const FORBIDDEN = [
  {
    pattern: /from\s+['"]pg['"]/g,
    message:
      'Forbidden: pg import in Studio — Engine owns DB (agent_studio_implementation_plan.md:493). Use neryva-mcp-client.',
    allowed: /engine\//,
  },
  {
    pattern: /from\s+['"]drizzle-orm['"]/g,
    message: 'Forbidden: drizzle-orm in Studio — Engine owns SQL. Use MCP.',
  },
  {
    pattern: /from\s+['"]@bufbuild\/protobuf['"].*gen\/ts/g,
    // This is actually allowed via @neryva/mcp-contract, but direct relative gen import is forbidden
    message: 'Forbidden: direct gen/ts relative import — use @neryva/mcp-contract.',
  },
];

// Workflow determinism — forbidden inside packages/workflows
const WORKFLOW_FORBIDDEN = [
  {
    pattern: /from\s+['"]ai['"]/g,
    message: 'Provider SDK ai forbidden in workflows — use activities.',
  },
  { pattern: /from\s+['"]@ai-sdk\//g, message: 'Provider SDK @ai-sdk forbidden in workflows.' },
  { pattern: /from\s+['"]pg['"]/g, message: 'pg forbidden in workflows.' },
  { pattern: /process\.env/g, message: 'process.env forbidden in workflows — use Temporal APIs.' },
  { pattern: /setTimeout\s*\(/g, message: 'setTimeout forbidden in workflows.' },
  { pattern: /setInterval\s*\(/g, message: 'setInterval forbidden in workflows.' },
  {
    pattern: /Date\.now\s*\(/g,
    message: 'Date.now forbidden in workflows — use Temporal deterministic time.',
  },
  {
    pattern: /Math\.random\s*\(/g,
    message: 'Math.random forbidden in workflows — use Temporal deterministic random.',
  },
  { pattern: /fetch\s*\(/g, message: 'fetch forbidden in workflows — use activities.' },
  { pattern: /require\(['"]fs['"]\)/g, message: 'fs forbidden in workflows.' },
];

function collectTsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (
      entry.isDirectory() &&
      !entry.name.startsWith('.') &&
      entry.name !== 'node_modules' &&
      entry.name !== 'dist'
    ) {
      collectTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(relative(ROOT, full).replaceAll('\\', '/'));
    }
  }
  return out;
}

let errors = 0;

function checkFile(relative) {
  const content = readFileSync(join(ROOT, relative), 'utf8');
  const isWorkflowSrc = relative.startsWith('packages/workflows/src/');
  const isWorkflow =
    isWorkflowSrc && !relative.includes('/tests/') && !relative.endsWith('.test.ts');

  // General forbidden
  for (const rule of FORBIDDEN) {
    if (rule.allowed && rule.allowed.test(relative)) continue;
    if (rule.pattern.test(content)) {
      console.error(`[forbidden] ${relative}: ${rule.message}`);
      errors++;
    }
    rule.pattern.lastIndex = 0;
  }

  // Workflow-specific
  if (isWorkflow) {
    for (const rule of WORKFLOW_FORBIDDEN) {
      if (rule.pattern.test(content)) {
        console.error(`[workflow-determinism] ${relative}: ${rule.message}`);
        errors++;
      }
      rule.pattern.lastIndex = 0;
    }
  }

  // Any at auth boundaries — heuristic: files containing organization_id + any
  if (/organization_id/.test(content) && /:\s*any\b/.test(content)) {
    console.error(
      `[any-at-boundary] ${relative}: 'any' at authorization boundary (use zod/JSON Schema validation).`,
    );
    errors++;
  }
}

// Collect and check
const files = [
  ...collectTsFiles(join(ROOT, 'packages')),
  ...collectTsFiles(join(ROOT, 'apps')),
  ...collectTsFiles(join(ROOT, 'contracts')),
];

if (files.length === 0) {
  console.log('[check:dependencies] No TS files found — skeleton phase, skipping content checks.');
} else {
  for (const f of files) checkFile(f);
}

// DAG check — ensure no upward dependency via import statements (heuristic)
for (const file of files) {
  const content = readFileSync(join(ROOT, file), 'utf8');
  const imports = [...content.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const fileLayer = layerOf(file);
  for (const imp of imports) {
    // Resolve alias like @neryva/* -> packages/*
    let targetLayer = -1;
    if (imp.startsWith('@neryva/')) {
      // e.g., @neryva/agent-kernel -> packages/agent-kernel
      const pkg = imp.replace('@neryva/', 'packages/');
      targetLayer = layerOf(pkg + '/');
    } else if (imp.startsWith('.') || imp.startsWith('/')) {
      // relative — assume same package, skip
      continue;
    } else {
      continue; // external dep, skip DAG check
    }
    if (fileLayer !== -1 && targetLayer !== -1 && targetLayer > fileLayer) {
      // file depends on higher layer (upward) → violation unless testkit
      if (LAYERS[fileLayer].name === 'testkit') continue; // testkit may depend on anything
      if (LAYERS[targetLayer].name === 'testkit') continue; // prod must not depend on testkit? Actually testkit is low, but apps may not depend on testkit
      console.error(
        `[dag-violation] ${file} (layer ${LAYERS[fileLayer].name}) imports ${imp} (layer ${LAYERS[targetLayer].name}) — upward dependency forbidden (agent_studio_implementation_plan.md:451).`,
      );
      errors++;
    }
  }
}

// Prod must not depend on testkit — test files may
for (const file of files) {
  if (file.includes('testkit')) continue;
  if (file.includes('/tests/') || file.endsWith('.test.ts') || file.startsWith('tests/')) continue;
  const content = readFileSync(join(ROOT, file), 'utf8');
  if (/@neryva\/testkit/.test(content) || /from\s+['"]\.\.\/testkit/.test(content)) {
    console.error(
      `[dag-violation] ${file}: prod code depends on @neryva/testkit — testkit is test-only (agent_studio_implementation_plan.md:488).`,
    );
    errors++;
  }
}

if (errors > 0) {
  console.error(
    `\n[check:dependencies] FAILED with ${errors} violation(s). See agent_studio_implementation_plan.md:447-503.`,
  );
  process.exit(1);
}

console.log('[check:dependencies] OK — DAG and forbidden imports clean.');
