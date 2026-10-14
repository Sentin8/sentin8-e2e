// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/testdata.ts — shared test data (URLs, personas).
//
// Platform-scoped: sentin8/ workspace only (no verticals).
//
// Every URL derives from DOMAIN, which comes from the tree-root `.env`
// (the same file the fleet boots from) via fixtures/env.ts — no
// hardcoded fallback (e2e DESIGN §4, invariant 5).
import { platformDomain } from './env.js';

/** Sentin8 platform root domain (from `SENTIN8_DOMAIN` — required). */
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let _runId: string | undefined;
function loadPersistedRunId(): string | undefined {
  if (_runId !== undefined) return _runId;
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), '.tmp', 'run-id.json'), 'utf-8')) as { runId?: string };
    if (typeof raw.runId === 'string' && raw.runId.length > 0) _runId = raw.runId;
  } catch {
    // No persisted run id (or unreadable) — fall back to generating one.
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

/** Path to the built sentin8-cli binary. */
export const CLI_BIN =
  process.env.SENTIN8_CLI_BIN ??
  '/home/hamid/dev/sentin8.new/sentin8/sentin8-cli/target/release/sentin8-cli';