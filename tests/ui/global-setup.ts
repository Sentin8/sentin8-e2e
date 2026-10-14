// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/ui/global-setup.ts — runs ONCE before all UI test files.
//
// Launches one browser, signs in via Dash, creates org + env,
// and saves the browser storage state (cookies + localStorage) to a file.
// All test files reuse this storage state — no per-file sign-in needed.

// Run-id writer MUST be imported first: its module body executes before
// testdata.ts (imported below) initializes RUN_ID, so globalSetup writes
// the authoritative run id that worker processes will read.
import '../../fixtures/run-id-writer.js';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import { URLs, Personas, RUN_ID } from '../../fixtures/testdata.js';
import {
  signInToDash, signUpAs, waitForFlutterSemantics,
  createOrganizationViaUI, createEnvironmentViaUI,
  enableFeatureViaUI, waitForFlutterContent,
} from '../../fixtures/harness.js';
import { cliSignIn, cliCall, assertCliOk, cliRefreshToken } from '../../fixtures/cli.js';
import { logStep } from '../../fixtures/log.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const STORAGE_STATE_PATH = join(process.cwd(), '.tmp', 'storage-state.json');

let _done = false;

export async function globalSetup(): Promise<void> {
  if (_done) return;
  _done = true;

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    baseURL: URLs.dash,
    ignoreHTTPSErrors: true,
    bypassCSP: true,
  });
  const page = await context.newPage();

  // Mirror the browser console + page errors into the run log: the dash app
  // logs its full request lifecycle (DashLogger) to the console, so a
  // client-side failure (cast error, uncaught exception, hung fetch) is
  // visible without re-running with DevTools open.
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' || msg.type() === 'warning' || text.includes('[ERROR]') || text.includes('[WARN]') || text.includes('route:') || text.includes('HTTP ')) {
      logStep(`[console:${msg.type()}] ${text.slice(0, 400)}`);
    }
  });
  page.on('pageerror', (err) => {
    logStep(`[pageerror] ${String(err).slice(0, 500)}`);
  });

  // Sign up (idempotent — OK if user already exists).
  try {
    await signUpAs(
      page, context,
      Personas.admin.email,
      Personas.admin.firstName,
      Personas.admin.lastName,
      Personas.admin.password,
      URLs.auth,
    );
  } catch {
    // User may already exist.
  }

  // Sign in the CLI once (device flow — stores credentials in ~/.sentin8/).
  await cliSignIn(Personas.admin.email, Personas.admin.password);

  // Sign in to Dash.
  await signInToDash(page, context, Personas.admin.email, Personas.admin.password);
  await waitForFlutterSemantics(page, 5_000);

  // Create org + env once.
  const orgSlug = `e2e-${RUN_ID}`;
  const orgName = `E2E Test Org ${RUN_ID}`;
  const orgId = await createOrganizationViaUI(page, orgSlug, orgName);
  if (!orgId) throw new Error('globalSetup: failed to create org');

  // CLI verify org — Synchronous lifecycle contract (sys DESIGN §2):
  // org creation returns 200 ONLY after the access model is fully
  // provisioned (record + roles/groups/creator membership + events), so
  // the verify must succeed immediately — a 403 here is a REAL failure,
  // never a transient state to retry away.
  const orgResult = await cliCall('sys', 'GET', `/v1/org/${orgId}`, undefined, undefined);
  await assertCliOk(orgResult, 'globalSetup: CLI verify org');

  const envId = await createEnvironmentViaUI(page, orgId, orgSlug, `E2E Test Env ${RUN_ID}`, 'production');
  if (!envId) throw new Error('globalSetup: failed to create env');

  // CLI verify env — same synchronous contract as the org verify.
  const envResult = await cliCall('sys', 'GET', `/v1/env/${envId}`, undefined, undefined);
  await assertCliOk(envResult, 'globalSetup: CLI verify env');

  // Force CLI token refresh — env creation assigned env:admin role.
  await cliRefreshToken();

  // Enable acme.
  try {
    await enableFeatureViaUI(page, orgId, envId, 'acme');
  } catch {
    // May already be enabled.
  }

  // Save org/env IDs + RUN_ID + email for test files to read.
  const meta = { orgId, envId, runId: RUN_ID, email: Personas.admin.email };
  mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });
  writeFileSync(
    join(process.cwd(), '.tmp', 'test-meta.json'),
    JSON.stringify(meta, null, 2),
  );

  // Save browser storage state (cookies + localStorage).
  await context.storageState({ path: STORAGE_STATE_PATH });

  await browser.close();
}

export default globalSetup;

export function getStorageStatePath(): string {
  return STORAGE_STATE_PATH;
}