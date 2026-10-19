// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/testdata.ts - shared test data (URLs, personas).
//
// Platform-scoped: sentin8/ workspace only (no verticals).
//
// Every URL derives from DOMAIN, which comes from the tree-root `.env`
// (the same file the fleet boots from) via fixtures/env.ts - no
// hardcoded fallback (e2e DESIGN §4, invariant 5).
import { platformDomain } from './env.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Sentin8 platform root domain (from `SENTIN8_DOMAIN` - required). */
export const DOMAIN = platformDomain();

// ── Service URLs ──────────────────────────────────────────────────────

export const URLs = {
  auth: `https://auth.ops.sys.${DOMAIN}`,
  dash: `https://dash.ops.sys.${DOMAIN}`,
  sys: `https://sys.ops.sys.${DOMAIN}`,
  app: `https://app.ops.sys.${DOMAIN}`,
  db: `https://db.ops.sys.${DOMAIN}`,
  storage: `https://storage.ops.sys.${DOMAIN}`,
  func: `https://func.ops.sys.${DOMAIN}`,
  cron: `https://cron.ops.sys.${DOMAIN}`,
  flow: `https://flow.ops.sys.${DOMAIN}`,
  stat: `https://stat.ops.sys.${DOMAIN}`,
  bus: `https://bus.ops.sys.${DOMAIN}`,
  post: `https://post.ops.sys.${DOMAIN}`,
  acme: `https://acme.ops.sys.${DOMAIN}`,
  bff: `https://bff.dash.ops.sys.${DOMAIN}`,
} as const;

// ── Personas ───────────────────────────────────────────────────────────

// Run id shared across the globalSetup process and all test-worker
// processes. Playwright runs globalSetup in its own Node process, so an
// import-time random value would differ between processes ("split-brain"
// run ids). tests/ui/global-setup.ts imports fixtures/run-id-writer.ts
// as its FIRST import, which persists a fresh run id to disk; every
// other process (workers, CLI suites) reads the persisted value here.
// Falling back to a generated value keeps direct single-process runs
// (e.g. a lone spec executed manually) working.

let _runId: string | undefined;
function loadPersistedRunId(): string | undefined {
  if (_runId !== undefined) return _runId;
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), '.tmp', 'run-id.json'), 'utf-8')) as { runId?: string };
    if (typeof raw.runId === 'string' && raw.runId.length > 0) _runId = raw.runId;
  } catch {
    // No persisted run id (or unreadable) - fall back to generating one.
  }
  return _runId;
}

// Include a random component so slug collisions don't happen across
// test runs (old test orgs persist in the DB and are never cleaned up).
export const RUN_ID = loadPersistedRunId() ?? (Date.now().toString().slice(-8) + Math.random().toString(36).slice(2, 6));

export function emailWithRunID(base: string): string {
  return `${base}+${RUN_ID}@a.co`;
}

// ── App URL helpers (used by harness for app-level URL construction) ──

/** BFF URL for an app instance: bff.{subdomain}.{env}.{org_domain} */
export function bff8AppURL(envSlug: string, orgSlug: string, subdomain: string, domain: string = DOMAIN): string {
  return `https://bff.${subdomain}.${envSlug}.${orgSlug}.${domain}`;
}

/** App runtime URL: {subdomain}.{env}.{org_domain} */
export function app8RuntimeURL(envSlug: string, orgSlug: string, subdomain: string, domain: string = DOMAIN): string {
  return `https://${subdomain}.${envSlug}.${orgSlug}.${domain}`;
}

export interface Persona {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

export const Personas: Record<'admin', Persona> = {
  // Test user signed up through the Dash UI in beforeAll.
  // Unique email per run to avoid "already exists" errors.
  admin: {
    firstName: 'Test',
    lastName: 'Operator',
    email: `test-operator+${RUN_ID}@a.co`,
    password: 'Test1234!',
  },
} as const;

// ── CLI binary path ────────────────────────────────────────────────────

/**
 * Path to the built sentin8-cli binary.
 *
 * Resolution order: an explicit `SENTIN8_CLI_BIN` → else derived from the
 * tree root (`SENTIN8_REPO_ROOT`, already resolved by fixtures/env.ts):
 * `{repo_root}/sentin8/sentin8-cli/target/{profile}/sentin8-cli`, where
 * `profile` is `SENTIN8_CLI_PROFILE` (default `debug` - the documented dev
 * pipeline builds debug) - with release tried as the fallback so a
 * release-only tree works too. No operator-absolute paths: the suite must
 * run on any checkout.
 */
function resolveCliBin(): string {
  if (process.env.SENTIN8_CLI_BIN) return process.env.SENTIN8_CLI_BIN;
  const repoRoot =
    process.env.SENTIN8_REPO_ROOT ?? resolve(import.meta.dirname ?? '.', '..', '..', '..');
  const profile = process.env.SENTIN8_CLI_PROFILE ?? 'debug';
  const candidates = [
    join(repoRoot, 'sentin8', 'sentin8-cli', 'target', profile, 'sentin8-cli'),
    join(repoRoot, 'sentin8', 'sentin8-cli', 'target', 'release', 'sentin8-cli'),
    join(repoRoot, 'sentin8', 'sentin8-cli', 'target', 'debug', 'sentin8-cli'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Nothing built yet - return the primary candidate so the spawn error
  // names the expected path (fail loud, not silently at a wrong absolute).
  return candidates[0];
}

export const CLI_BIN = resolveCliBin();