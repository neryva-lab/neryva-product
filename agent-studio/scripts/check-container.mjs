#!/usr/bin/env node
/**
 * check-container.mjs — Dockerfile + image scan + SBOM placeholder
 * Source: agent_studio_implementation_plan.md:1316-1322 (check:container)
 * Phase 0: ensures infra/docker/* exists and is not empty stub when containers are added.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DOCKER_DIR = join(ROOT, 'infra/docker');

let warnings = 0;

if (!existsSync(DOCKER_DIR)) {
  console.log(
    '[check:container] No infra/docker — skeleton phase, skipping (will be required Phase 3+).',
  );
  process.exit(0);
}

const files = readdirSync(DOCKER_DIR);
if (files.length === 0) {
  console.log('[check:container] infra/docker empty — skeleton phase, skipping.');
  process.exit(0);
}

for (const file of files) {
  if (!file.endsWith('.Dockerfile') && !file.endsWith('.dockerfile')) {
    console.warn(
      `[check:container] WARN ${file}: expected *.Dockerfile naming per infra/docker/runtime-worker.Dockerfile pattern.`,
    );
    warnings++;
  }
  const content = readFileSync(join(DOCKER_DIR, file), 'utf8');
  if (!/FROM\s+node:22/.test(content)) {
    console.warn(`[check:container] WARN ${file}: expected FROM node:22 LTS base (toolchain.md).`);
    warnings++;
  }
  if (/COPY\s+.*\.env/.test(content)) {
    console.error(
      `[check:container] ${file}: COPY .env forbidden — secrets via secret-manager only (agent_studio_implementation_plan.md:605).`,
    );
    process.exit(1);
  }
}

if (warnings > 0) {
  console.log(
    `[check:container] OK with ${warnings} warning(s) — add SBOM + image scan in Phase 10.`,
  );
} else {
  console.log('[check:container] OK — Dockerfiles present and basic checks pass.');
}
