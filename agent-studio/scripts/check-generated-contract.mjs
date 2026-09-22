/**
 * check-generated-contract.mjs — honest reproducibility gate for the Neryva MCP
 * generated TypeScript.
 *
 * Background: agent-studio consumes `@neryva/mcp-contract` through a pnpm
 * `file:` dependency, which snapshots the package directory at install time.
 * The generated `gen/ts` output must therefore exist in the source package
 * BEFORE `pnpm install` runs in agent-studio, or the installed copy silently
 * lacks the generated modules and every fresh-clone build fails with TS2307.
 * The previous `generate:check` swallowed all failures (`2>/dev/null ||
 * echo ...skipped`), so this rotted unnoticed.
 *
 * What this script verifies, loudly:
 *   1. `buf generate` runs successfully in the contract package (no swallowing).
 *   2. `gen/ts` exists and contains generated modules after generation.
 *   3. If `gen/ts` is git-tracked: `git diff --exit-code` must be clean, i.e.
 *      the committed generated code is byte-reproducible from `proto/`.
 *      If it is NOT yet tracked, a prominent warning is printed: the diff
 *      gate is advisory until `gen/ts` is committed.
 *
 * Fresh-machine recipe (order matters):
 *   1. `pnpm install` inside `neryva_mcp/neryva-mcp-contract` (provides `buf`)
 *      — or install the workspace and rely on the committed `gen/ts`.
 *   2. `pnpm --dir neryva_mcp/neryva-mcp-contract generate` (regenerate).
 *   3. `pnpm install` inside `agent-studio` (snapshots the contract WITH gen/ts).
 *   4. `pnpm build` / `typecheck` / `test` in `agent-studio`.
 * If `gen/ts` is committed (recommended), steps 1–2 are only needed when
 * `proto/` changes; step 3 alone suffices otherwise.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const agentStudioDir = resolve(here, '..');
const repoRoot = resolve(agentStudioDir, '..');
const contractDir = join(repoRoot, 'neryva_mcp', 'neryva-mcp-contract');
const genTsDir = join(contractDir, 'gen', 'ts');

function fail(message) {
  console.error(`[check:generated] FAIL: ${message}`);
  process.exit(1);
}

function run(cmd, args, cwd) {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'inherit' });
  } catch {
    fail(`'${cmd} ${args.join(' ')}' failed in ${cwd}`);
  }
}

if (!existsSync(join(contractDir, 'package.json'))) {
  fail(`contract package not found at ${contractDir}`);
}

// 1. Regenerate — any buf/proto failure is fatal and loud.
console.log('[check:generated] running buf generate in neryva-mcp-contract…');
run('pnpm', ['--dir', contractDir, 'generate'], agentStudioDir);

// 2. The generated output must actually exist.
const generatedFiles = existsSync(genTsDir)
  ? readdirSync(genTsDir, { recursive: true }).filter((f) => String(f).endsWith('.ts'))
  : [];
if (generatedFiles.length === 0) {
  fail(`no generated modules found under ${genTsDir} after buf generate`);
}
console.log(`[check:generated] ${generatedFiles.length} generated modules present.`);

// 3. Reproducibility gate on tracked files; loud warning while untracked.
const relGenTs = 'neryva_mcp/neryva-mcp-contract/gen/ts';
let tracked = '';
try {
  tracked = execFileSync('git', ['ls-files', '--', relGenTs], { cwd: repoRoot, encoding: 'utf8' }).trim();
} catch {
  fail('git ls-files failed — is this a git checkout?');
}

if (!tracked) {
  console.error(
    `[check:generated] WARNING: ${relGenTs} is not committed. ` +
      `The byte-reproducibility gate (git diff --exit-code) cannot be enforced until it is. ` +
      `Run: git add ${relGenTs} && git commit. ` +
      `Until then, fresh clones depend on generation happening before 'pnpm install' (see header).`,
  );
} else {
  run('git', ['diff', '--exit-code', '--', relGenTs], repoRoot);
  console.log('[check:generated] committed gen/ts is byte-reproducible from proto/.');
}

console.log('[check:generated] OK');
