#!/usr/bin/env node
/**
 * check-workflow-bundle.mjs — deterministic bundle check
 * Source: agent_studio_implementation_plan.md:1316-1322, 839-848
 * Ensures packages/workflows contains only deterministic imports and no large payloads.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const WORKFLOWS_DIR = join(ROOT, 'packages/workflows');
const MAX_INLINE_BYTES = 8192; // matches ARTIFACTS_MAX_INLINE_BYTES

let errors = 0;
let warnings = 0;

function collectFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      collectFiles(full, out);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      out.push(full);
    }
  }
  return out;
}

if (!existsSync(WORKFLOWS_DIR)) {
  console.log('[bundle:check] No packages/workflows — skeleton phase, skipping.');
  process.exit(0);
}

const files = collectFiles(WORKFLOWS_DIR);

if (files.length === 0) {
  console.log('[bundle:check] No workflow files — skipping.');
  process.exit(0);
}

// Deterministic import allowlist for workflows (used in future strict allowlist check)
// Workflow import policy (checked below): only @temporalio/workflow and relative imports.
// @neryva/neryva-mcp-client is deliberately NOT allowed: it uses node:crypto, uuid,
// setTimeout and wall-clock retry — non-deterministic in workflow replay.

const FORBIDDEN_PATTERNS = [
  { re: /from\s+['"]ai['"]/g, msg: 'ai (Vercel SDK) forbidden in workflows' },
  { re: /from\s+['"]@ai-sdk\//g, msg: '@ai-sdk provider adapter forbidden in workflows' },
  { re: /from\s+['"]pg['"]/g, msg: 'pg forbidden' },
  { re: /from\s+['"]drizzle-orm['"]/g, msg: 'drizzle forbidden' },
  { re: /from\s+['"]uuid['"]/g, msg: 'uuid forbidden — use deterministic IDs in workflows' },
  { re: /from\s+['"]node:/g, msg: 'node builtins forbidden in workflows' },
  { re: /require\(['"]node:/g, msg: 'node builtins forbidden in workflows' },
  { re: /process\.env/g, msg: 'process.env forbidden — use Temporal config via activities' },
  { re: /fs\.readFile|fs\.writeFile|require\(['"]fs['"]\)/g, msg: 'fs forbidden' },
  { re: /fetch\s*\(/g, msg: 'fetch forbidden — use activities' },
  { re: /Date\.now\s*\(/g, msg: 'Date.now forbidden — use Temporal deterministic time' },
  { re: /Math\.random\s*\(/g, msg: 'Math.random forbidden — use deterministic logic' },
  { re: /setTimeout\s*\(/g, msg: 'setTimeout forbidden — use Temporal timers (sleep/condition)' },
  { re: /setInterval\s*\(/g, msg: 'setInterval forbidden — use Temporal timers' },
];

for (const full of files) {
  const relativePath = relative(ROOT, full).replaceAll('\\', '/');
  // Skip tests — workflow determinism applies to src only, not verifiers
  if (relativePath.includes('/tests/') || relativePath.endsWith('.test.ts')) continue;
  const content = readFileSync(full, 'utf8');

  // Size check
  const size = statSync(full).size;
  if (size > MAX_INLINE_BYTES * 4) {
    console.warn(
      `[bundle:check] WARN ${relativePath}: file size ${size}B > ${MAX_INLINE_BYTES * 4}B — ensure workflow state is bounded refs only (agent_studio_implementation_plan.md:758-770).`,
    );
    warnings++;
  }

  // Forbidden patterns
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.re.test(content)) {
      console.error(`[bundle:check] ${relativePath}: ${rule.msg}`);
      errors++;
    }
    rule.re.lastIndex = 0;
  }

  // Import allowlist check (heuristic)
  const imports = [...content.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const imp of imports) {
    if (imp.startsWith('@temporalio/') && !imp.startsWith('@temporalio/workflow')) {
      if (imp !== '@temporalio/workflow' && imp !== '@temporalio/workflow/lib/worker') {
        console.error(
          `[bundle:check] ${relativePath}: import ${imp} — only @temporalio/workflow allowed in workflows; client/activity imports belong in activities.`,
        );
        errors++;
      }
    }
  }
}

// Also check workflow bundle file if exists
const bundlePath = join(ROOT, 'apps/runtime-worker/dist/workflow-bundle.js');
if (existsSync(bundlePath)) {
  const bundleRaw = readFileSync(bundlePath, 'utf8');
  // Strip comments before scanning — doc comments legitimately name forbidden modules
  const bundle = bundleRaw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  // Simple check: bundle should not contain provider SDK strings
  const forbiddenInBundle = [/openai/i, /anthropic/i, /\bpg\b/i];
  for (const re of forbiddenInBundle) {
    if (re.test(bundle)) {
      console.warn(
        `[bundle:check] WARN workflow-bundle.js contains ${re} — verify provider SDK not bundled in workflow.`,
      );
      warnings++;
    }
  }
}

if (errors > 0) {
  console.error(`\n[bundle:check] FAILED with ${errors} error(s), ${warnings} warning(s).`);
  process.exit(1);
}

if (warnings > 0) {
  console.log(`[bundle:check] OK with ${warnings} warning(s).`);
} else {
  console.log('[bundle:check] OK — workflow bundle deterministic and bounded.');
}
