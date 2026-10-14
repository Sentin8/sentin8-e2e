// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/ui/app.spec.ts — E2E-UI-8: app UI suite — full functional.
//
// Full lifecycle through the Dash UI:
//   - store → list published listings, install app
//   - instances → list instances, detail

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { URLs } from '../../fixtures/testdata.js';
import { waitForFlutterSemantics, getFlutterTexts, waitForFlutterContent } from '../../fixtures/harness.js';
import { ensureSignedIn, getTestOrgId, getTestEnvId, navigateToDashPage } from './_setup.js';
import { StrictPage } from '../../fixtures/strictpage.js';
import { cliCall, assertCliOk } from '../../fixtures/cli.js';
import { RUN_ID } from '../../fixtures/testdata.js';
import { rfwCreateViaForm, rfwVerifyInList, waitForFlutterText } from '../../fixtures/harness.js';


test.describe.configure({ mode: 'serial' });

test.describe('UI — app (full functional)', () => {
  let context: BrowserContext;
  let page: Page;
  let strict: StrictPage;
  let orgId: string;
  let envId: string;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ baseURL: URLs.dash, ignoreHTTPSErrors: true, bypassCSP: true });
    page = await context.newPage();
    await ensureSignedIn(page, context);
    // Create StrictPage AFTER setup so setup errors don't pollute test assertions.
    strict = new StrictPage(page);
    orgId = getTestOrgId(); envId = getTestEnvId();
  });

  test.afterAll(async () => { await context?.close(); });

  test('app/store — list published listings', async () => {
    await navigateToDashPage(page, 'app', 'store', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    const texts = await getFlutterTexts(page);
    expect(texts.length).toBeGreaterThan(0);
    // The store page should show either listings or an empty state
    strict.assertNoFailures();

    // CLI verify: app store admin data is accessible.
    const r = await cliCall('app', 'GET', '/v1/admin/store', undefined, envId);
    assertCliOk(r, 'app store (CLI verify)');
  });

  test('app/instances — list instances', async () => {
    await navigateToDashPage(page, 'app', 'instances', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    // Instances page may be empty (no apps installed) — that's OK.
    strict.assertNoFailures();

    // CLI verify: app instances admin data is accessible.
    const r = await cliCall('app', 'GET', '/v1/admin/instances', undefined, envId);
    assertCliOk(r, 'app instances (CLI verify)');
  });

  // ════════════════════════════════════════════════════════════════════
  // Phase 3: Full functional CRUD test — create store listing
  // ════════════════════════════════════════════════════════════════════

  test('app/store — create listing, verify in UI + CLI', async () => {
    const appName = `E2E App ${RUN_ID}`;
    // Distinct from the CLI suite's slug (both suites share RUN_ID —
    // app_slug is globally unique in app_store_listings).
    const appSlug = `e2e-app-ui-${RUN_ID}`;
    const storeUrl = `${URLs.dash}/#/app/store?env=${envId}`;

    // Create store listing via UI form (like a human: click Create Listing, fill fields, submit).
    // Visibility has a default value ("public") so we don't need to select it.
    await rfwCreateViaForm(page, storeUrl, 'Create Listing', [
      { label: 'App Name', value: appName },
      { label: 'App Slug', value: appSlug },
      { label: 'Description', value: 'E2E test app' },
      { label: 'Backend URL', value: 'https://example.com' },
    ], 'Create Listing');

    // UI verify: listing appears in the store list.
    // Re-navigate to the list page to see the newly created listing.
    const inUi = await rfwVerifyInList(page, storeUrl, appName, 5_000);
    expect(inUi).toBe(true);

    // CLI verify: listing appears in CLI output.
    const r = await cliCall('app', 'GET', '/v1/admin/store', undefined, envId);
    assertCliOk(r, 'app store listing (CLI verify)');
    expect(r.stdout).toContain(appName);
    strict.assertNoFailures();
  });
});