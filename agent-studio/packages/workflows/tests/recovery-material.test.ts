/**
 * recovery-material.test.ts — recovery envelope coverage (Wave 4 GAP 2).
 *
 * The workflow attaches a recovery envelope as the REQUIRED trailing
 * argument of every MCP-dependent activity call (enforced at the type level
 * by `WithRecovery`, which makes the envelope mandatory). This test is the
 * second layer: a source audit proving every invocation of each
 * MCP-dependent activity in agent-run-workflow.ts actually passes
 * `recoveryMaterial()` — so a future call site that somehow bypasses the
 * type (or a hand-edit that drops the argument) fails loudly here instead
 * of reintroducing the worker-kill divergence (Temporal FAILED while the
 * Engine row stayed non-terminal).
 *
 * Also pins the two deliberate exemptions:
 *  - `acquireOrRenewRunLease` — the admission bootstrap; carries its own
 *    scope + dispatch capability and IS the claim path.
 *  - `moderateContent` — local guardrail policy check, not MCP-dependent.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- test audits workflow source via fs (not workflow code)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RECOVERY_FAILED_PREFIX } from '../src/recovery-material.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const fullSrc = readFileSync(join(srcDir, 'agent-run-workflow.ts'), 'utf8');
const materialSrc = readFileSync(join(srcDir, 'recovery-material.ts'), 'utf8');

// Audit only the workflow function body: the module-level `type *Activities`
// interface declarations above it textually resemble invocations
// (`failRun(params: {...}): Promise<unknown>;`) but are not calls.
const fnStart = fullSrc.indexOf('export async function agentRunWorkflow');
const bodyOpen = fullSrc.indexOf('{', fnStart);
// findClosingParen is a hoisted function declaration (defined below).
const workflowSrc = fullSrc.slice(bodyOpen, findClosingParen(fullSrc, bodyOpen) + 1);
// Line numbers in diagnostics stay file-relative.
const bodyLineOffset = fullSrc.slice(0, bodyOpen).split('\n').length - 1;

/** MCP-dependent activities: every invocation must end with recoveryMaterial(). */
const ENVELOPED = [
  'getApprovalState',
  'compileContext',
  'fetchRunImages',
  'emitEvent',
  'callModel',
  'executeTool',
  'createApprovalRequest',
  'getRunVersion',
  'saveCheckpoint',
  'loadCheckpoint',
  'commitRunResult',
  'failRun',
  '_releaseRunLease',
];

/** Deliberate exemptions — must NOT take the envelope. */
const EXEMPT = ['acquireOrRenewRunLease', 'moderateContent'];

/** String/template/comment-aware scan to the paren matching src[openIdx]. */
function findClosingParen(src: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  let sq = false;
  let dq = false;
  let tmpl = false;
  let tmplBraces = 0;
  let lineComment = false;
  while (i < src.length) {
    const c = src.charAt(i);
    const nxt = src.charAt(i + 1);
    if (lineComment) {
      if (c === '\n') lineComment = false;
      i++;
      continue;
    }
    if (sq) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === "'") sq = false;
      i++;
      continue;
    }
    if (dq) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') dq = false;
      i++;
      continue;
    }
    if (tmpl) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`' && tmplBraces === 0) {
        tmpl = false;
        i++;
        continue;
      }
      if (c === '$' && nxt === '{') {
        tmplBraces++;
        i += 2;
        continue;
      }
      if (c === '}' && tmplBraces > 0) {
        tmplBraces--;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (c === '/' && nxt === '/') {
      lineComment = true;
      i += 2;
      continue;
    }
    if (c === "'") sq = true;
    else if (c === '"') dq = true;
    else if (c === '`') tmpl = true;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error('unbalanced parens in workflow source scan');
}

interface Invocation {
  name: string;
  args: string;
  line: number;
}

/** All real invocations of `name(` in the workflow source. */
function invocations(name: string): Invocation[] {
  const out: Invocation[] = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(workflowSrc)) !== null) {
    const lineStart = workflowSrc.lastIndexOf('\n', m.index) + 1;
    const line = workflowSrc.slice(lineStart, m.index + m[0].length);
    // Skip the helper's own definition and commented-out mentions.
    if (line.includes('function _releaseRunLease')) continue;
    if (line.trimStart().startsWith('//')) continue;
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findClosingParen(workflowSrc, openIdx);
    out.push({
      name,
      args: workflowSrc.slice(openIdx + 1, closeIdx),
      line: bodyLineOffset + workflowSrc.slice(0, m.index).split('\n').length,
    });
    re.lastIndex = closeIdx + 1;
  }
  return out;
}

describe('recovery envelope coverage (workflow side)', () => {
  it('every MCP-dependent activity invocation passes recoveryMaterial()', () => {
    const missing: string[] = [];
    let total = 0;
    for (const name of ENVELOPED) {
      const calls = invocations(name);
      expect(calls.length, `${name} should be invoked at least once`).toBeGreaterThan(0);
      for (const call of calls) {
        total++;
        // Trailing comma style (`recoveryMaterial(),`) is accepted — the
        // envelope is still the final argument.
        if (!/recoveryMaterial\(\),?\s*$/.test(call.args)) {
          missing.push(`${name} (line ${call.line})`);
        }
      }
    }
    expect(missing, 'invocations missing the recovery envelope').toEqual([]);
    expect(total).toBeGreaterThan(20);
  });

  it('exempt activities keep their plain signatures (no envelope)', () => {
    for (const name of EXEMPT) {
      const calls = invocations(name);
      expect(calls.length, `${name} should be invoked at least once`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(
          /recoveryMaterial\(\),?\s*$/.test(call.args),
          `${name} (line ${call.line}) must not take the envelope`,
        ).toBe(false);
      }
    }
  });

  it('recovery prefix matches the runtime registry contract', () => {
    // Must equal the RECOVERY_FAILED_PREFIX the runtime-worker's
    // wrapActivitiesWithRecovery throws; the workflow keys its loud
    // reconciliation-failure path off this prefix. Pinned on both sides.
    expect(RECOVERY_FAILED_PREFIX).toBe('RUN_RECOVERY_FAILED:');
  });

  it('recovery-material.ts is deterministic (no banned workflow constructs)', () => {
    for (const banned of ['Date.now()', 'Math.random()', 'process.env', 'setTimeout(', 'fetch(']) {
      expect(materialSrc.includes(banned), `banned construct ${banned}`).toBe(false);
    }
    expect(materialSrc.includes("from '@temporalio/workflow'")).toBe(false);
  });
});
