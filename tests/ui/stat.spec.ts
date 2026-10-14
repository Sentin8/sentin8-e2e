// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/ui/stat.spec.ts — E2E-UI-12: stat UI suite — full functional.
// Tests: overview render, properties render, events render, metrics render.

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { URLs, RUN_ID } from '../../fixtures/testdata.js';
import { waitForFlutterSemantics, getFlutterTexts, waitForFlutterContent, waitForFlutterText, rfwCreateViaForm, rfwVerifyInList, clickFlutterButton } from '../../fixtures/harness.js';
import { ensureSignedIn, getTestOrgId, getTestEnvId, navigateToDashPage } from './_setup.js';
import { StrictPage } from '../../fixtures/strictpage.js';
import { cliCall, assertCliOk } from '../../fixtures/cli.js';

test.describe.configure({ mode: 'serial' });
test.describe('UI — stat (full functional)', () => {
  let context: BrowserContext; let page: Page; let strict: StrictPage;
  let orgId: string; let envId: string;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ baseURL: URLs.dash, ignoreHTTPSErrors: true, bypassCSP: true });
    page = await context.newPage();
    await ensureSignedIn(page, context);
    // Create StrictPage AFTER setup so setup errors don't pollute test assertions.
    strict = new StrictPage(page);
    orgId = getTestOrgId(); envId = getTestEnvId();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('stat/overview — render, summary cards', async () => {
    await navigateToDashPage(page, 'stat', 'overview', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    expect((await getFlutterTexts(page)).length).toBeGreaterThan(0);
    strict.assertNoFailures();

    // CLI verify: stat properties admin data is accessible.
    const r = await cliCall('stat', 'GET', '/v1/admin/properties', undefined, envId);
    assertCliOk(r, 'stat overview (CLI verify)');
  });

  test('stat/properties — render property list', async () => {
    await navigateToDashPage(page, 'stat', 'properties', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    // The properties page should render with property data (system
    // properties like "Sentin8:Auth Platform Telemetry" are visible
    // to platform operators).
    await waitForFlutterText(page, 'Properties', 5_000);
    const texts = await getFlutterTexts(page);
    expect(texts.some(t => t.includes('Property') || t.includes('Telemetry'))).toBe(true);
    strict.assertNoFailures();

    // CLI verify: stat properties admin data is accessible.
    const r = await cliCall('stat', 'GET', '/v1/admin/properties', undefined, envId);
    assertCliOk(r, 'stat properties (CLI verify)');
  });

  test('stat/events — query events', async () => {
    await navigateToDashPage(page, 'stat', 'events', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    expect((await getFlutterTexts(page)).length).toBeGreaterThan(0);
    strict.assertNoFailures();

    // CLI verify: stat properties admin data is accessible.
    const r = await cliCall('stat', 'GET', '/v1/admin/properties', undefined, envId);
    assertCliOk(r, 'stat events (CLI verify)');
  });

  test('stat/metrics — render metrics chart', async () => {
    await navigateToDashPage(page, 'stat', 'metrics', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    expect((await getFlutterTexts(page)).length).toBeGreaterThan(0);
    strict.assertNoFailures();

    // CLI verify: stat properties admin data is accessible.
    const r = await cliCall('stat', 'GET', '/v1/admin/properties', undefined, envId);
    assertCliOk(r, 'stat metrics (CLI verify)');
  });

  // ════════════════════════════════════════════════════════════════════
  // Phase 3: Full functional CRUD test (E2E-UI-Full-13)
  // ════════════════════════════════════════════════════════════════════

  test('stat/properties — create property, verify in UI + CLI', async () => {
    const propName = `E2E UI Prop ${RUN_ID}`;
    const slug = `e2e-ui-prop-${RUN_ID}`;
    const propsUrl = `${URLs.dash}/#/sentin8-stat/properties?env=${envId}`;

    // Create property via UI form (like a human: click Create Property, fill fields, submit).
    await rfwCreateViaForm(page, propsUrl, 'Create Property', [
      { label: 'Property Name', value: propName },
      { label: 'Slug', value: slug },
    ], 'Create Property');

    // UI verify: property appears in the list.
    const inUi = await rfwVerifyInList(page, propsUrl, propName, 5_000);
    expect(inUi).toBe(true);

    // CLI verify: property appears in CLI output.
    const r = await cliCall('stat', 'GET', '/v1/admin/properties', undefined, envId);
    assertCliOk(r, 'stat property list (CLI verify)');
    expect(r.stdout).toContain(propName);
    strict.assertNoFailures();
  });
});