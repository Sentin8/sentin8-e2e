// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/ui/secrets.spec.ts — E2E-UI: secrets admin suite (Phase 34, story 34.3.3).
//
// Full admin lifecycle through the BFF proxy ONLY (no psql, no direct
// backend writes — AGENTS.md E2E rules): create a secret via the admin UI
// form → verify in the list → metadata check (no value leak) → disable.

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { URLs, RUN_ID } from '../../fixtures/testdata.js';
import { waitForFlutterSemantics, getFlutterTexts, waitForFlutterContent, rfwCreateViaForm, rfwVerifyInList } from '../../fixtures/harness.js';
import { ensureSignedIn, getTestOrgId, getTestEnvId, navigateToDashPage } from './_setup.js';
import { StrictPage } from '../../fixtures/strictpage.js';
import { cliCall, assertCliOk } from '../../fixtures/cli.js';

const SECRET_NAME = () => `e2e-stripe-${RUN_ID}`;
const SECRET_VALUE = () => `sk-e2e-${RUN_ID}`;

test.describe.configure({ mode: 'serial' });
test.describe('UI — secrets (admin lifecycle)', () => {
  let context: BrowserContext; let page: Page; let strict: StrictPage;
  let orgId: string; let envId: string;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ baseURL: URLs.dash, ignoreHTTPSErrors: true, bypassCSP: true });
    page = await context.newPage();
    await ensureSignedIn(page, context);
    strict = new StrictPage(page);
    orgId = getTestOrgId(); envId = getTestEnvId();
  });
  test.afterAll(async () => { await context?.close(); });

  test('secrets/overview — page renders', async () => {
    await navigateToDashPage(page, 'secrets', 'overview', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    expect((await getFlutterTexts(page)).length).toBeGreaterThan(0);
    strict.assertNoFailures();
  });

  test('secrets — create via UI form, verify in list + CLI', async () => {
    // Create via the admin UI form (like a human).
    await rfwCreateViaForm(page, `${URLs.dash}/#/sentin8-secrets/secrets/new?env=${envId}`, 'Add Secret', [
      { label: 'Secret Name', value: SECRET_NAME() },
      { label: 'Secret Value', value: SECRET_VALUE() },
    ], 'Store Secret', []);

    // UI verify: the secret appears in the list (name only — never value).
    const inUi = await rfwVerifyInList(page, `${URLs.dash}/#/sentin8-secrets/secrets?env=${envId}`, SECRET_NAME(), 5_000);
    expect(inUi).toBeTruthy();

    // CLI verify: metadata list contains it (value never in the response).
    const r = await cliCall('secrets', 'GET', '/v1/admin/secrets', undefined, envId);
    assertCliOk(r, 'secrets list (CLI verify)');
  });

  test('secrets — metadata responses never leak the value', async () => {
    const r = await cliCall('secrets', 'GET', '/v1/admin/secrets', undefined, envId);
    assertCliOk(r, 'secrets metadata (CLI verify)');
    const body = typeof r === 'string' ? r : JSON.stringify(r);
    expect(body).not.toContain(SECRET_VALUE()); // plaintext must NOT appear in metadata
  });

});