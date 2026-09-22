#!/usr/bin/env tsx
/**
 * neryva-template-lint.ts — template quality gate (TPL-3.2).
 *
 * Lints ONE template: --dump <generator --dump JSON> --dir <template source dir>.
 * With --all, discovers every template under <root>/templates and lints each.
 *
 * Order (ledger TPL-3.2 — first failure class reported wins, all classes run):
 *  1. Studio validateAgentDefinition (7 rejection classes) over the CONTRACT
 *     shape mapped from the Engine payload (mapping documented below).
 *  2. Engine bounds tightened to the contract: instructions ≤20,000,
 *     allowed_models ≤16, tools ≤32, knowledge_sources ≤16.
 *  3. Secret-pattern scan (assignment-shape port of
 *     engine/src/modules/assistants/validation.ts — keys never scanned).
 *  4. compileDefinition: must succeed (fail-closed on unknown tools);
 *     instructionsHash must equal sha256(instructions) and the definition
 *     hash must be stable across runs. NOTE on "manifest parity": the
 *     compiler hash covers the contract-shaped COMPILED output with a
 *     different canonicalization than the Engine manifest hash — literal
 *     equality is incoherent. Parity here means the compile pipeline is
 *     internally consistent and deterministic.
 *  5. §5 instruction standard on instructions.md source.
 *  6. Eval + release presence: ≥10 cases, evaluators, release_policy.yaml.
 *
 * Usage:
 *   tsx scripts/neryva-template-lint.ts --dump <dump.json> --dir templates/<family>/<slug>
 *   tsx scripts/neryva-template-lint.ts --all [--root <repo>]
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentDefinitionV1Schema } from '../packages/agent-definition/src/schema.js';
import { validateAgentDefinition } from '../packages/agent-definition/src/validator.js';
import {
  compileDefinition,
  hashDefinition,
  COMPILER_VERSION,
} from '../packages/agent-definition/src/compiler.js';
import { DEFAULT_TOOL_DESCRIPTORS, PLATFORM_BUILT_IN_TOOLS } from '../contracts/tool/descriptor.js';
import type { ToolDescriptor } from '../contracts/tool/descriptor.js';

interface LintDump {
  slug: string;
  version: string;
  hash: string;
  definition: Record<string, unknown>;
  // Optional: dumps are JSON.parse output — never fully trusted. The guard
  // below fails fast when a foreign/stale generator omitted them.
  bindings?: Record<string, unknown>;
  eval_ref?: {
    evaluators?: unknown;
    rubric_markdown?: string;
    cases?: Array<Record<string, unknown>>;
  };
  release_policy?: Record<string, unknown>;
}

const MAJOR = /^(\d+)\./;

function fail(bucket: string[], step: string, message: string): void {
  bucket.push(`[${step}] ${message}`);
}

/** Engine payload → contract AgentDefinitionV1 (lossless for in-bounds templates). */
function toContractShape(
  slug: string,
  version: string,
  definition: Record<string, unknown>,
  consoleJson: Record<string, unknown>,
): Record<string, unknown> {
  const major = MAJOR.exec(version)?.[1] ?? '1';
  const model = definition.model_policy as { allowed_models: string[]; fallback_enabled?: boolean };
  const modelParams = (definition.model_params ?? {}) as {
    temperature?: number;
    max_output_tokens?: number;
  };
  const budget = (definition.budget_policy ?? {}) as {
    max_total_tokens?: number;
    max_cost_micros?: number;
    wall_clock_seconds?: number;
    max_tool_calls?: number;
    max_model_calls?: number;
  };
  const retrieval = (consoleJson.retrieval_policy ?? {}) as {
    knowledge_max_results?: number;
    memory_max_results?: number;
    hybrid_retrieval?: boolean;
  };
  const tools = (
    (
      definition.tool_policy as {
        tools?: Array<{ name: string; access: string; approval?: string }>;
      }
    ).tools ?? []
  ).map((t) => ({
    name: t.name,
    access: t.access,
    approval: t.approval === 'required' ? 'required' : 'none',
  }));
  return {
    agent_id: slug,
    version: Number(major),
    schema_version: 'v1',
    instructions: definition.instructions,
    model_policy: {
      allowed_models: model.allowed_models,
      fallback_enabled: model.fallback_enabled ?? false,
      max_output_tokens: modelParams.max_output_tokens,
    },
    context_policy: definition.context_policy,
    tools,
    guardrails: definition.guardrail_policy,
    budget_policy: {
      max_model_calls: Math.min(budget.max_model_calls ?? 8, 32),
      max_tool_calls: Math.min(budget.max_tool_calls ?? 8, 32),
      max_wall_clock_ms: (budget.wall_clock_seconds ?? 120) * 1000,
      max_token_budget: Math.min(budget.max_total_tokens ?? 50000, 1000000),
      max_cost_cents: Math.floor((budget.max_cost_micros ?? 0) / 10000),
      max_recursion_depth: 5,
    },
    retrieval_policy: {
      knowledge_max_results: retrieval.knowledge_max_results ?? 5,
      memory_max_results: retrieval.memory_max_results ?? 5,
      hybrid_retrieval: retrieval.hybrid_retrieval ?? false,
    },
  };
}

/** Synthesize registry descriptors for org-pinned tools so the Studio
 *  validator checks template SELF-consistency (approvals cover effectful
 *  tools). Org-existence stays an install-time concern (422 in install,
 *  durable check in provisioning). */
function extendedToolRegistry(
  bindings: Record<string, unknown>,
  failures: string[],
): ToolDescriptor[] {
  const required = ((bindings.tools as { required?: Array<Record<string, unknown>> } | undefined)
    ?.required ?? []) as Array<{
    name?: unknown;
    built_in?: unknown;
    effect_class?: unknown;
    approval_requirement?: unknown;
    timeout_ms?: unknown;
  }>;
  const synthesized: ToolDescriptor[] = [];
  for (const pin of required) {
    if (typeof pin.name !== 'string' || pin.name.length === 0) {
      fail(failures, 'studio-validate', 'bindings.tools.required entry without a name');
      continue;
    }
    if (pin.built_in === true || PLATFORM_BUILT_IN_TOOLS.has(pin.name)) {
      continue;
    }
    const effectClass = pin.effect_class ?? 'READ_ONLY';
    const approvalRequirement = pin.approval_requirement ?? 'NONE';
    if (!['READ_ONLY', 'MUTATING', 'DESTRUCTIVE'].includes(effectClass as string)) {
      fail(
        failures,
        'studio-validate',
        `pin ${pin.name}: effect_class must be READ_ONLY|MUTATING|DESTRUCTIVE`,
      );
      continue;
    }
    if (!['NONE', 'REQUIRED'].includes(approvalRequirement as string)) {
      fail(
        failures,
        'studio-validate',
        `pin ${pin.name}: approval_requirement must be NONE|REQUIRED`,
      );
      continue;
    }
    synthesized.push({
      toolId: pin.name,
      version: '0.0.0-template',
      inputSchema: { type: 'object' },
      effectClass: effectClass as ToolDescriptor['effectClass'],
      approvalRequirement: approvalRequirement as ToolDescriptor['approvalRequirement'],
      egressClass: 'limited',
      timeoutMs: typeof pin.timeout_ms === 'number' ? pin.timeout_ms : 30000,
      idempotency: 'unsupported',
      redactionPolicy: 'strict',
      auditEventType: `tool.${pin.name}`,
      executionMode: 'activity',
    });
  }
  return [...DEFAULT_TOOL_DESCRIPTORS, ...synthesized];
}

/** Assignment-shape secret scan — port of the Engine rule (keys never scanned). */
const SECRET_ASSIGNMENT = /\b(api[_-]?key|secret|password|bearer|token)\b\s*[:=]\s*\S{4,}/i;
function scanSecrets(value: unknown, path: string, failures: string[]): void {
  if (typeof value === 'string') {
    if (SECRET_ASSIGNMENT.test(value)) {
      fail(failures, 'secrets', `${path}: suspected credential material (assignment shape)`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanSecrets(item, `${path}[${i}]`, failures));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      scanSecrets(v, `${path}.${k}`, failures);
  }
}

const SECTION_ORDER = [
  'Role',
  'Goal',
  'Grounding',
  'Steps',
  'Constraints',
  'Tool use',
  'Failure',
  'Format',
];

/** Header NAME is the text before the first —/–/:/- (`# Role — …` → `Role`). */
function headerName(line: string): string {
  return (line.slice(2).split(/\s*[—–:-]\s*/)[0] ?? '').trim();
}

function checkInstructions(
  source: string,
  dump: LintDump,
  bindings: Record<string, unknown>,
  failures: string[],
): void {
  const lines = source.split('\n');
  // Headers carry their content on the same line (`# Role — …`) per the
  // plan's worked example.
  const headers = lines.filter((l) => l.startsWith('# ')).map(headerName);
  const order = headers.filter((h) => SECTION_ORDER.includes(h));
  if (order.join('|') !== SECTION_ORDER.join('|')) {
    fail(
      failures,
      'instructions',
      `sections must appear in order ${SECTION_ORDER.join(' → ')} (found: ${headers.join(', ') || 'none'})`,
    );
  }
  const roleLine = lines.find((l) => headerName(l) === 'Role');
  if (!roleLine || !roleLine.includes('{org_name}')) {
    fail(failures, 'instructions', 'ROLE line must name the org ({org_name}) plus the job');
  }
  // Grounded-task commitment: a verb+ONLY sourcing rule plus an invention ban.
  if (
    !/\b(use|rely on|draft|answer|reason|score|brief|quote|resolve|triage|summarize|recall|classify|establish|identify|ground\w*)\b[^.\n]*\bONLY\b/i.test(
      source,
    )
  ) {
    fail(
      failures,
      'instructions',
      'missing grounded-task clause (a verb+ONLY sourcing commitment)',
    );
  }
  if (!/never (invent|hallucinate|trust|guess)/i.test(source)) {
    fail(
      failures,
      'instructions',
      'missing invention ban (never invent/hallucinate/… from memory)',
    );
  }
  // Slots use colons or dashes interchangeably in hand-authored markdown
  // ("Banned claims: {…}" vs "Banned claims — {…}") — accept both.
  const constraints = sectionText(source, 'Constraints');
  const banned = /banned claims?\s*[-—–:]\s*\{([^}]*)\}/i.exec(constraints)?.[1] ?? '';
  if (banned.trim().length === 0 || /todo|tbd|placeholder|fixme/i.test(banned)) {
    fail(failures, 'instructions', 'Constraints must carry a filled banned-claims slot');
  }
  const disclaimer =
    /required disclaimer[^-—–:]*\s*[-—–:]\s*(\{[^}]*\}|[^\n]+)/i.exec(source)?.[1] ?? '';
  if (disclaimer.trim().length === 0 || /todo|tbd|placeholder|fixme/i.test(disclaimer)) {
    fail(failures, 'instructions', 'Constraints must carry a filled required-disclaimer slot');
  }
  // Failure script beats (§5 rule 6): plain acknowledgment + forward path
  // (retry / escalate / handoff / continue / route / fallback).
  const failure = sectionText(source, 'Failure');
  if (!/say so|acknowledg|report|note the|mark the/i.test(failure)) {
    fail(failures, 'instructions', 'Failure section must acknowledge tool errors plainly');
  }
  if (!/retr|escalat|hand off|continue|fallback|rout/i.test(failure)) {
    fail(
      failures,
      'instructions',
      'Failure section must script the forward path (retry / escalate / handoff / continue)',
    );
  }
  if (!new RegExp(`<!-- template: ${dump.slug}@${dump.version}`).test(source)) {
    fail(
      failures,
      'instructions',
      `missing provenance footer (<!-- template: ${dump.slug}@${dump.version} … -->)`,
    );
  }
  // when_to_use per required tool.
  const required =
    (bindings.tools as { required?: Array<{ name?: string; when_to_use?: string }> } | undefined)
      ?.required ?? [];
  for (const tool of required) {
    if (!tool.when_to_use || tool.when_to_use.trim().length < 10) {
      fail(
        failures,
        'instructions',
        `tool ${tool.name ?? '(unnamed)'} lacks when_to_use (1–2 sentences)`,
      );
    }
  }
  // Channel variants: voice-bound templates need spoken-format rules.
  const channels = ((bindings.channels as { channels?: string[] } | undefined)?.channels ??
    []) as string[];
  if (channels.includes('voice') && !/spoken|sentence/i.test(source)) {
    fail(
      failures,
      'instructions',
      'voice-bound template must declare spoken-format rules (≤2 sentences, confirm-back)',
    );
  }
}

function sectionText(source: string, name: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith('# ') && headerName(l) === name);
  if (start === -1) return '';
  // Content lives on the header line itself (after the dash) AND on the
  // following lines until the next header.
  const headerRemainder = (lines[start] ?? '')
    .slice(2)
    .split(/\s*[—–:-]\s*/)
    .slice(1)
    .join(' — ');
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('# '));
  const following = (end === -1 ? rest : rest.slice(0, end)).join('\n');
  return `${headerRemainder}\n${following}`;
}

export function lintTemplate(dump: LintDump, dir: string): string[] {
  const failures: string[] = [];
  const where = `${dump.slug}@${dump.version}`;
  const definition = dump.definition;
  // The generator guarantees bindings/eval_ref/release_policy; a dump missing
  // them is a foreign/stale generator — fail fast with a clear message.
  // Typed unknown (not optional fields): JSON.parse output is never trusted,
  // so every check below is meaningful to the type system too.
  const rawBindings: unknown = dump.bindings;
  const rawEvalRef: unknown = dump.eval_ref;
  const rawReleasePolicy: unknown = dump.release_policy;
  if (
    typeof rawBindings !== 'object' ||
    rawBindings === null ||
    typeof rawEvalRef !== 'object' ||
    rawEvalRef === null ||
    typeof rawReleasePolicy !== 'object' ||
    rawReleasePolicy === null
  ) {
    return [
      `${where}: dump missing bindings/eval_ref/release_policy (regenerate with the current generator)`,
    ];
  }
  const bindings = rawBindings as Record<string, unknown>;
  const evalRef = rawEvalRef as {
    evaluators?: unknown;
    rubric_markdown?: string;
    cases?: Array<Record<string, unknown>>;
  };
  const releasePolicy = rawReleasePolicy as Record<string, unknown>;

  // Console-side companion (retrieval policy for the contract mapping).
  let consoleJson: Record<string, unknown> = {};
  try {
    consoleJson = JSON.parse(
      readFileSync(join(dir, 'definition', 'console.json'), 'utf8'),
    ) as Record<string, unknown>;
  } catch {
    fail(failures, 'contract-map', 'definition/console.json unreadable');
  }

  // 1. Studio validation over the contract shape.
  const contract = toContractShape(dump.slug, dump.version, definition, consoleJson);
  const parsed = AgentDefinitionV1Schema.safeParse(contract);
  if (!parsed.success) {
    fail(
      failures,
      'studio-validate',
      `contract shape invalid: ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`,
    );
  } else {
    // One extended registry for validation AND compilation — the compiler is
    // fail-closed on unregistered tools, so both stages see the same truth.
    const toolRegistry = extendedToolRegistry(bindings, failures);
    const result = validateAgentDefinition(parsed.data, { toolRegistry });
    if (!result.ok) {
      const details = (result.error.details ?? {}) as { code?: string };
      fail(
        failures,
        'studio-validate',
        `${details.code ?? 'DEFINITION_INVALID'}: ${result.error.message}`,
      );
    }
    // 4. Compile parity: must succeed; instructionsHash self-consistent; deterministic.
    try {
      const compiled = compileDefinition(parsed.data, {
        agentVersionId: `tpl_${dump.slug}_v${dump.version}`,
        toolRegistry,
      });
      const expectedInstructionsHash = createHash('sha256')
        .update(definition.instructions as string)
        .digest('hex');
      if (compiled.instructionsHash !== expectedInstructionsHash) {
        fail(failures, 'compile', 'instructionsHash mismatch — compiler input diverged');
      }
      if (compiled.compilerVersion !== COMPILER_VERSION) {
        fail(
          failures,
          'compile',
          `compiler version drift (${compiled.compilerVersion} vs ${COMPILER_VERSION})`,
        );
      }
      if (
        hashDefinition(parsed.data) !==
        hashDefinition(JSON.parse(JSON.stringify(parsed.data)) as typeof parsed.data)
      ) {
        fail(
          failures,
          'compile',
          'definition hash unstable across JSON round-trip (non-JSON-safe values)',
        );
      }
    } catch (err) {
      fail(failures, 'compile', `compileDefinition failed: ${(err as Error).message}`);
    }
  }

  // 2. Engine bounds tightened to the contract.
  const instructions = definition.instructions as string;
  if (
    typeof instructions !== 'string' ||
    instructions.length === 0 ||
    instructions.length > 20000
  ) {
    fail(
      failures,
      'engine-bounds',
      `instructions must be 1..20000 chars (contract cap), got ${typeof instructions === 'string' ? instructions.length : typeof instructions}`,
    );
  }
  const allowedModels = ((definition.model_policy as { allowed_models?: unknown[] } | undefined)
    ?.allowed_models ?? []) as unknown[];
  if (allowedModels.length < 1 || allowedModels.length > 16) {
    fail(failures, 'engine-bounds', `allowed_models must be 1..16, got ${allowedModels.length}`);
  }
  const tools = ((definition.tool_policy as { tools?: unknown[] } | undefined)?.tools ??
    []) as unknown[];
  if (tools.length > 32) {
    fail(failures, 'engine-bounds', `tools must be ≤32, got ${tools.length}`);
  }
  const sources = ((definition.context_policy as { knowledge_sources?: unknown[] } | undefined)
    ?.knowledge_sources ?? []) as unknown[];
  if (sources.length > 16) {
    fail(failures, 'engine-bounds', `knowledge_sources must be ≤16, got ${sources.length}`);
  }

  // 3. Secret scan over the assembled definition (values only, never keys).
  scanSecrets(definition, `${where}.definition`, failures);

  // 5. Instruction standard on source.
  try {
    const md = readFileSync(join(dir, 'definition', 'instructions.md'), 'utf8').replace(/\s+$/, '');
    checkInstructions(md, dump, bindings, failures);
  } catch {
    fail(failures, 'instructions', 'definition/instructions.md unreadable');
  }

  // 6. Eval + release presence.
  const cases = evalRef.cases ?? [];
  if (cases.length < 10) {
    fail(failures, 'eval', `need ≥10 eval cases, found ${cases.length}`);
  }
  if (evalRef.evaluators === undefined || evalRef.evaluators === null) {
    fail(failures, 'eval', 'evaluators.yaml content missing from eval_ref');
  }
  const policy = releasePolicy;
  for (const key of ['required', 'critical_failures']) {
    const value: unknown = policy[key];
    if (!Array.isArray(value) || value.length === 0) {
      fail(failures, 'eval', `release_policy.yaml missing non-empty ${key}`);
    }
  }
  if (typeof policy.thresholds !== 'object' || policy.thresholds === null) {
    fail(failures, 'eval', 'release_policy.yaml missing thresholds');
  }

  return failures;
}

function discoverTemplates(root: string): Array<{ slug: string; family: string; dir: string }> {
  const out: Array<{ slug: string; family: string; dir: string }> = [];
  const templatesDir = join(root, 'templates');
  for (const family of readdirSync(templatesDir, { withFileTypes: true })) {
    if (!family.isDirectory() || family.name.startsWith('_') || family.name.startsWith('.'))
      continue;
    for (const slug of readdirSync(join(templatesDir, family.name), { withFileTypes: true })) {
      if (!slug.isDirectory() || slug.name.startsWith('_') || slug.name.startsWith('.')) continue;
      if (!existsSync(join(templatesDir, family.name, slug.name, 'template.yaml'))) continue;
      out.push({
        slug: slug.name,
        family: family.name,
        dir: join(templatesDir, family.name, slug.name),
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const script = 'tsx scripts/neryva-template-lint.ts';
  if (argv.includes('--all')) {
    const rootIndex = argv.indexOf('--root');
    const rootFlag = rootIndex === -1 ? undefined : argv[rootIndex + 1];
    if (rootIndex !== -1 && rootFlag === undefined) {
      console.error(`usage: ${script} --all [--root <repo>]`);
      process.exit(2);
    }
    const root = resolve(rootFlag ?? join(import.meta.dirname, '..'));
    const found = discoverTemplates(root);
    if (found.length === 0) {
      console.error('lint: no templates discovered');
      process.exit(1);
    }
    const tmp = join(tmpdir(), `neryva-template-lint-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    let failed = 0;
    for (const t of found) {
      const dumpPath = join(tmp, `${t.family}-${t.slug}.json`);
      try {
        execFileSync(
          'node',
          [
            join(root, 'scripts', 'generate-template-registry.mjs'),
            '--dump',
            `${t.family}/${t.slug}`,
            '--out',
            dumpPath,
          ],
          { stdio: 'pipe' },
        );
      } catch {
        console.error(`FAIL ${t.family}/${t.slug}: assembly failed (generator --dump error)`);
        failed += 1;
        continue;
      }
      const dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as LintDump;
      const failures = lintTemplate(dump, t.dir);
      if (failures.length > 0) {
        console.error(`FAIL ${t.family}/${t.slug}:`);
        for (const f of failures) console.error(`  - ${f}`);
        failed += 1;
      } else {
        console.log(`PASS ${t.family}/${t.slug}`);
      }
    }
    if (failed > 0) {
      console.error(`lint: ${failed}/${found.length} template(s) failed`);
      process.exit(1);
    }
    console.log(`lint: all ${found.length} template(s) passed`);
    return;
  }
  const dumpIndex = argv.indexOf('--dump');
  const dirIndex = argv.indexOf('--dir');
  const dumpPath = dumpIndex === -1 ? undefined : argv[dumpIndex + 1];
  const templateDir = dirIndex === -1 ? undefined : argv[dirIndex + 1];
  if (dumpPath === undefined || templateDir === undefined) {
    console.error(`usage: ${script} --dump <dump.json> --dir <template dir>`);
    console.error(`   or: ${script} --all [--root <repo>]`);
    process.exit(2);
  }
  const dump = JSON.parse(readFileSync(resolve(dumpPath), 'utf8')) as LintDump;
  const failures = lintTemplate(dump, resolve(templateDir));
  if (failures.length > 0) {
    console.error(`FAIL ${dump.slug}@${dump.version}:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`PASS ${dump.slug}@${dump.version}`);
}

main().catch((err: unknown) => {
  console.error(`lint failed: ${(err as Error).message}`);
  process.exit(1);
});
