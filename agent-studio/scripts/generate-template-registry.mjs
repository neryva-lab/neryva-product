#!/usr/bin/env node
/**
 * generate-template-registry.mjs — template BOM assembler + registry emitter (TPL-3.1).
 *
 * Scans templates/<family>/<slug>/, assembles the Engine-payload-shaped
 * `definition` object from definition/, and emits registry.json:
 *   { version: 1, templates: [{ slug, version, hash, status, min_engine_schema }] }
 *
 * Hash contract (MUST stay identical to the Engine):
 *   sha256 hex over JSON.stringify with recursively localeCompare-sorted keys
 *   (arrays keep order) — byte-for-byte the algorithm in
 *   engine/src/common/crypto/canonical-hash.ts. If you change one, change both.
 *
 * Two purposes, kept distinct on purpose:
 *  - generator `hash` = tamper evidence of the template SOURCE (definition/
 *    bytes as assembled). The release job re-verifies it before upsert.
 *  - Engine install/publish hashes = identity of the NORMALIZED payload
 *    (zod defaults applied). Never equal by construction; never compared.
 * "Hash parity" in the gates means: committed registry.json === fresh
 * regeneration from definition/ (generator determinism), verified by
 * `pnpm templates:check`.
 *
 * template.yaml carries a `hash` field (plan §4.1 frontmatter). It is
 * generator-managed: default mode FAILS on mismatch (fail loud in CI);
 * --write refreshes stale hashes and rewrites registry.json after editing.
 *
 * Usage:
 *   node scripts/generate-template-registry.mjs [--write] [--dir templates]
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

const args = new Set(process.argv.slice(2));
const WRITE = args.has('--write');
const ROOT = resolve(join(import.meta.dirname, '..'));
const TEMPLATES_DIR = resolve(
  ROOT,
  args.has('--dir') ? process.argv[process.argv.indexOf('--dir') + 1] : 'templates',
);
const REGISTRY_PATH = join(TEMPLATES_DIR, 'registry.json');

const STATUSES = new Set(['stable', 'beta', 'deprecated']);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const failures = [];
function fail(where, message) {
  failures.push(`${where}: ${message}`);
}

// Stale template.yaml hashes are EXPECTED drift after editing definition/ —
// they are refresh jobs, not structural errors. Structural failures (missing
// files, bad semver, unparsable content) abort every mode WITHOUT writing.
const staleHashes = [];

/** Verbatim port of engine/src/common/crypto/canonical-hash.ts — keep in sync. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

function canonicalHash(value) {
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(value)))
    .digest('hex');
}

function readJson(path, where) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(where, `unparsable JSON in ${path} (${err.message})`);
    return null;
  }
}

function readYaml(path, where) {
  try {
    return yaml.load(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(where, `unparsable YAML in ${path} (${err.message})`);
    return null;
  }
}

function readText(path, where) {
  try {
    return readFileSync(path, 'utf8').replace(/\s+$/, '');
  } catch (err) {
    fail(where, `unreadable file ${path} (${err.message})`);
    return null;
  }
}

/** cases.jsonl — one JSON object per line; every case needs a string input. */
function readCases(path, where) {
  let text = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    fail(where, `unreadable file ${path} (${err.message})`);
    return null;
  }
  const cases = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      fail(where, `eval/cases.jsonl line ${index + 1}: invalid JSON (${err.message})`);
      continue;
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.input !== 'string' ||
      parsed.input.length === 0
    ) {
      fail(where, `eval/cases.jsonl line ${index + 1}: case needs a non-empty string input`);
      continue;
    }
    cases.push(parsed);
  }
  return cases;
}

function requireFile(dir, rel, where) {
  const path = join(dir, rel);
  try {
    if (!statSync(path).isFile()) {
      fail(where, `missing required file ${rel}`);
      return null;
    }
  } catch {
    fail(where, `missing required file ${rel}`);
    return null;
  }
  return path;
}

/** Assemble the Engine-payload-shaped definition + hash it. Returns null on structural failure. */
function assembleTemplate(family, slug) {
  const where = `${family}/${slug}`;
  const dir = join(TEMPLATES_DIR, family, slug);

  const manifestPath = requireFile(dir, 'template.yaml', where);
  if (!manifestPath) return null;
  const manifest = readYaml(manifestPath, where);
  if (!manifest || typeof manifest !== 'object') return null;

  if (manifest.slug !== slug)
    fail(where, `template.yaml slug '${manifest.slug}' does not match directory '${slug}'`);
  if (manifest.family !== family)
    fail(where, `template.yaml family '${manifest.family}' does not match directory '${family}'`);
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version))
    fail(where, `version '${manifest.version}' is not semver`);
  if (!STATUSES.has(manifest.status))
    fail(where, `status '${manifest.status}' must be stable|beta|deprecated`);
  if (!KEBAB.test(slug) || slug.length > 64)
    fail(where, `slug '${slug}' must be kebab-case, max 64 chars`);
  if (!Number.isInteger(manifest.min_engine_schema) || manifest.min_engine_schema < 1) {
    fail(where, `min_engine_schema '${manifest.min_engine_schema}' must be a positive integer`);
  }

  // Required BOM files (plan §4.2) — presence here, content rules in lint.
  const def = (rel) => requireFile(dir, `definition/${rel}`, where);
  const instructionsPath = def('instructions.md');
  const modelPath = def('model.json');
  const contextPath = def('context.json');
  const toolsPath = def('tools.json');
  const knowledgePath = def('knowledge.json');
  const guardrailsPath = def('guardrails.json');
  const budgetsPath = def('budgets.json');
  def('console.json');
  const bind = (rel) => requireFile(dir, `bindings/${rel}`, where);
  const toolsRequiredPath = bind('tools.required.json');
  const knowledgeSeedsPath = bind('knowledge.seeds.json');
  const channelsPath = bind('channels.json');
  const ev = (rel) => requireFile(dir, `eval/${rel}`, where);
  const casesPath = ev('cases.jsonl');
  const evaluatorsPath = ev('evaluators.yaml');
  const rubricPath = ev('rubric.md');
  const releasePolicyPath = requireFile(dir, 'release_policy.yaml', where);
  requireFile(dir, 'samples/demo-script.md', where);
  requireFile(dir, 'samples/edge-cases.md', where);
  requireFile(dir, 'README.md', where);
  requireFile(dir, 'SETUP.md', where);

  const instructions = instructionsPath ? readText(instructionsPath, where) : null;
  const model = modelPath ? readJson(modelPath, where) : null;
  const context = contextPath ? readJson(contextPath, where) : null;
  const tools = toolsPath ? readJson(toolsPath, where) : null;
  const knowledge = knowledgePath ? readJson(knowledgePath, where) : null;
  const guardrails = guardrailsPath ? readJson(guardrailsPath, where) : null;
  const budgets = budgetsPath ? readJson(budgetsPath, where) : null;
  if (failures.length > 0) return null;
  if (!instructions || !model || !context || !tools || !knowledge || !guardrails || !budgets)
    return null;

  const toolsRequired = toolsRequiredPath ? readJson(toolsRequiredPath, where) : null;
  const knowledgeSeeds = knowledgeSeedsPath ? readJson(knowledgeSeedsPath, where) : null;
  const channels = channelsPath ? readJson(channelsPath, where) : null;
  const releasePolicy = releasePolicyPath ? readYaml(releasePolicyPath, where) : null;
  const evaluators = evaluatorsPath ? readYaml(evaluatorsPath, where) : null;
  const rubric = rubricPath ? readText(rubricPath, where) : null;
  const cases = casesPath ? readCases(casesPath, where) : null;
  if (failures.length > 0) return null;
  if (
    !toolsRequired ||
    !knowledgeSeeds ||
    !channels ||
    !releasePolicy ||
    !evaluators ||
    rubric === null ||
    !cases
  )
    return null;

  // Assemble Engine-payload keys (model.json splits into policy + params).
  const { model_params: modelParams, ...modelPolicy } = model;
  const definition = {
    model_policy: modelPolicy,
    context_policy: context,
    tool_policy: tools,
    knowledge_policy: knowledge,
    guardrail_policy: guardrails,
    instructions,
    ...(modelParams !== undefined ? { model_params: modelParams } : {}),
    budget_policy: budgets,
  };
  const hash = canonicalHash(definition);

  if (
    typeof manifest.hash === 'string' &&
    manifest.hash.length > 0 &&
    manifest.hash !== hash &&
    manifest.hash !== `sha256:${hash}`
  ) {
    staleHashes.push({ family, slug, manifest, hash });
  }

  // Full sync row (TPL-1.2): the release job upserts exactly this content —
  // definition (Engine-payload keys) + bindings + eval_ref + release policy.
  // eval_ref carries the full cases: small bounded JSON, safe as a row value
  // (the provisioning consumer seeds datasets from it — no filesystem reads
  // at release/runtime, no cross-repo dependency).
  const bindings = { tools: toolsRequired, knowledge: knowledgeSeeds, channels };
  const evalRef = { evaluators, rubric_markdown: rubric, cases };
  return { manifest, definition, bindings, evalRef, releasePolicy, hash };
}

function discoverTemplates() {
  const out = [];
  let families = [];
  try {
    families = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch (err) {
    fail('<root>', `cannot read templates dir ${TEMPLATES_DIR} (${err.message})`);
    return out;
  }
  for (const family of families) {
    const slugs = readdirSync(join(TEMPLATES_DIR, family), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name);
    for (const slug of slugs) {
      const assembled = assembleTemplate(family, slug);
      if (assembled) out.push({ family, slug, ...assembled });
    }
  }
  return out;
}

const assembled = discoverTemplates();

function reportFailuresAndExit() {
  console.error(`template registry: ${failures.length} structural error(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

if (args.has('--dump')) {
  // --dump serves lint tooling: structural failures abort, stale hashes do
  // not (the dump carries the recomputed hash either way).
  if (failures.length > 0) reportFailuresAndExit();
  const target = process.argv[process.argv.indexOf('--dump') + 1];
  const found = assembled.find((t) => `${t.family}/${t.slug}` === target || t.slug === target);
  if (!found) {
    console.error(`template not found: ${target}`);
    process.exit(1);
  }
  // Assembled Engine-payload definition + metadata for lint/validation tooling.
  const rendered_dump = `${JSON.stringify({ slug: found.slug, version: found.manifest.version, hash: found.hash, definition: found.definition, bindings: found.bindings, eval_ref: found.evalRef, release_policy: found.releasePolicy }, null, 2)}\n`;
  if (args.has('--out')) {
    const { writeFileSync: writeDump } = await import('node:fs');
    writeDump(process.argv[process.argv.indexOf('--out') + 1], rendered_dump, 'utf8');
  } else {
    process.stdout.write(rendered_dump);
  }
  process.exit(0);
}

if (failures.length > 0) reportFailuresAndExit();

if (staleHashes.length > 0 && !WRITE) {
  console.error(
    `template registry: ${staleHashes.length} stale template.yaml hash(es) — refresh with: node scripts/generate-template-registry.mjs --write`,
  );
  for (const s of staleHashes)
    console.error(
      `  - ${s.family}/${s.slug}: committed ${String(s.manifest.hash).slice(0, 16)}… vs recomputed ${s.hash.slice(0, 16)}…`,
    );
  process.exit(1);
}

const entries = assembled
  .map(({ family, manifest, hash, definition, bindings, evalRef, releasePolicy }) => ({
    slug: manifest.slug,
    version: manifest.version,
    hash,
    status: manifest.status,
    family,
    min_engine_schema: manifest.min_engine_schema,
    // Full sync row (TPL-1.2): the release job upserts exactly this content
    // into assistant_templates — one file, no cross-repo reads at release.
    definition,
    bindings,
    eval_ref: evalRef,
    release_policy: releasePolicy,
  }))
  .sort((a, b) =>
    a.slug === b.slug ? a.version.localeCompare(b.version) : a.slug.localeCompare(b.slug),
  );

const envelope = { version: 1, templates: entries };
const rendered = `${JSON.stringify(envelope, null, 2)}\n`;

if (WRITE) {
  // Refresh stale template.yaml hashes, then write the registry.
  // Structural failures already exited above — --write never persists
  // a partial registry.
  const { dump } = yaml;
  for (const { family, slug, manifest, hash } of staleHashes) {
    const path = join(TEMPLATES_DIR, family, slug, 'template.yaml');
    const updated = { ...manifest, hash };
    writeFileSync(path, dump(updated, { lineWidth: 100 }));
    console.log(`hash refreshed: ${family}/${slug} -> ${hash.slice(0, 16)}…`);
  }
  writeFileSync(REGISTRY_PATH, rendered);
  console.log(`registry written: ${REGISTRY_PATH} (${entries.length} template(s))`);
} else {
  let committed = null;
  try {
    committed = readFileSync(REGISTRY_PATH, 'utf8');
  } catch {
    fail('<root>', 'registry.json missing — run with --write to generate');
  }
  if (committed !== null && committed !== rendered) {
    console.error(
      'registry.json is stale — regenerate with: node scripts/generate-template-registry.mjs --write',
    );
    process.exit(1);
  }
  console.log(`registry check passed (${entries.length} template(s), hashes verified)`);
}
