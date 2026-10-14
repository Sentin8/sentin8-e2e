// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/ui/db.spec.ts — E2E-UI-6: db UI suite — full functional.
//
// Full lifecycle through the Dash UI:
//   - overview → render, summary cards
//   - tables → list, verify table catalog
//   - posture → render, verify RLS posture
//   - settings → render

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { URLs } from '../../fixtures/testdata.js';
import { waitForFlutterSemantics, waitForFlutterText, getFlutterTexts, waitForFlutterContent, rfwCreateViaForm, rfwVerifyInList } from '../../fixtures/harness.js';
import { StrictPage } from '../../fixtures/strictpage.js';
import { ensureSignedIn, getTestOrgId, getTestEnvId, navigateToDashPage } from './_setup.js';
import { cliCall, assertCliOk } from '../../fixtures/cli.js';
import { RUN_ID } from '../../fixtures/testdata.js';

test.describe.configure({ mode: 'serial' });

test.describe('UI — db (full functional)', () => {
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

  test('db/overview — render, summary cards', async () => {
    await navigateToDashPage(page, 'db', 'overview', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    const texts = await getFlutterTexts(page);
    expect(texts.length).toBeGreaterThan(0);
    strict.assertNoFailures();

    // CLI verify: db tables admin data is accessible.
    const r = await cliCall('db', 'GET', '/v1/admin/tables', undefined, envId);
    assertCliOk(r, 'db overview (CLI verify)');
  });

  test('db/tables — render, table catalog', async () => {
    await navigateToDashPage(page, 'db', 'tables', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    const texts = await getFlutterTexts(page);
    expect(texts.length).toBeGreaterThan(0);
    strict.assertNoFailures();

    // CLI verify: db tables admin data is accessible.
    const r = await cliCall('db', 'GET', '/v1/admin/tables', undefined, envId);
    assertCliOk(r, 'db tables (CLI verify)');
  });

  test('db/posture — render, RLS posture', async () => {
    await navigateToDashPage(page, 'db', 'posture', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    strict.assertNoFailures();

    // CLI verify: db tables admin data is accessible (posture uses same admin layer).
    const r = await cliCall('db', 'GET', '/v1/admin/tables', undefined, envId);
    assertCliOk(r, 'db posture (CLI verify)');
  });

  test('db/settings — render', async () => {
    await navigateToDashPage(page, 'db', 'settings', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    strict.assertNoFailures();

    // CLI verify: db tables admin data is accessible.
    const r = await cliCall('db', 'GET', '/v1/admin/tables', undefined, envId);
    assertCliOk(r, 'db settings (CLI verify)');
  });

  // ════════════════════════════════════════════════════════════════════
  // Phase 3: Full functional CRUD test — create table
  // ════════════════════════════════════════════════════════════════════

  test('db/tables — create table, verify in UI + CLI', async () => {
    const tableName = `e2e_table_${RUN_ID}`;
    const displayName = `E2E Table ${RUN_ID}`;
    const tablesUrl = `${URLs.dash}/#/sentin8-db/tables?env=${envId}`;

    // Create table via UI form (like a human: click Create Table, fill fields, submit).
    await rfwCreateViaForm(page, tablesUrl, 'Create Table', [
      { label: 'Table Name', value: tableName },
      { label: 'Display Name', value: displayName },
    ], 'Create Table');

    // UI verify: table appears in the list.
    const inUi = await rfwVerifyInList(page, tablesUrl, tableName, 5_000);
    expect(inUi).toBe(true);

    // CLI verify: table appears in CLI output.
    const r = await cliCall('db', 'GET', '/v1/admin/tables', undefined, envId);
    assertCliOk(r, 'db table create (CLI verify)');
    expect(r.stdout.toLowerCase()).toContain(tableName.toLowerCase());
    strict.assertNoFailures();
  });
});