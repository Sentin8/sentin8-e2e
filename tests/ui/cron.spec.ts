// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/ui/cron.spec.ts — E2E-UI-10: cron UI suite — full functional.
//
// Full lifecycle: overview → summary; jobs → list; schedules → list.

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { URLs, RUN_ID } from '../../fixtures/testdata.js';
import { waitForFlutterSemantics, getFlutterTexts, waitForFlutterContent, rfwCreateViaForm, rfwVerifyInList, clickFlutterButton } from '../../fixtures/harness.js';
import { ensureSignedIn, getTestOrgId, getTestEnvId, navigateToDashPage } from './_setup.js';
import { StrictPage } from '../../fixtures/strictpage.js';
import { cliDo, cliCall, assertCliOk } from '../../fixtures/cli.js';


test.describe.configure({ mode: 'serial' });
test.describe('UI — cron (full functional)', () => {
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
  test.afterAll(async () => { await context?.close(); });

  test('cron/overview — render, summary cards', async () => {
    await navigateToDashPage(page, 'cron', 'overview', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    expect((await getFlutterTexts(page)).length).toBeGreaterThan(0);
    strict.assertNoFailures();

    // CLI verify: cron schedules admin data is accessible.
    const r = await cliCall('cron', 'GET', '/v1/admin/schedules', undefined, envId);
    assertCliOk(r, 'cron overview (CLI verify)');
  });

  test('cron/jobs — list job runs', async () => {
    await navigateToDashPage(page, 'cron', 'jobs', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    expect((await getFlutterTexts(page)).length).toBeGreaterThan(0);
    strict.assertNoFailures();

    // CLI verify: cron schedules admin data is accessible.
    const r = await cliCall('cron', 'GET', '/v1/admin/schedules', undefined, envId);
    assertCliOk(r, 'cron jobs (CLI verify)');
  });

  test('cron/schedules — list schedules', async () => {
    await navigateToDashPage(page, 'cron', 'schedules', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    expect((await getFlutterTexts(page)).length).toBeGreaterThan(0);
    strict.assertNoFailures();

    // CLI verify: cron schedules admin data is accessible.
    const r = await cliCall('cron', 'GET', '/v1/admin/schedules', undefined, envId);
    assertCliOk(r, 'cron schedules (CLI verify)');
  });

  // ════════════════════════════════════════════════════════════════════
  // Phase 3: Full functional CRUD test (E2E-UI-Full-8)
  // ════════════════════════════════════════════════════════════════════

  test('cron/schedules — create schedule, verify in UI + CLI', async () => {
    const domain = `e2e-${RUN_ID}`;
    const schedulesUrl = `${URLs.dash}/#/sentin8-cron/schedules?env=${envId}`;

    // Create schedule via UI form (like a human: click Create Schedule, fill
    // fields, submit). The target_config carries the proxy-back contract the
    // create-time validation enforces (cron DESIGN §3, WARN-22): a
    // non-empty `baseUrl` — the executor dials `{baseUrl}{internalPath}/schedules/run`.
    await rfwCreateViaForm(page, schedulesUrl, 'Create Schedule', [
      { label: 'Domain', value: domain },
      { label: 'Cron Expression', value: '*/5 * * * *' },
      {
        label: 'Target Config (JSON)',
        value: JSON.stringify({ baseUrl: 'https://e2e.example.com', internalPath: '/v1/internal' }),
      },
    ], 'Create Schedule', [
      { label: 'Schedule Type', option: 'Cron (recurring)' },
    ]);

    // UI verify: schedule appears in the list.
    const inUi = await rfwVerifyInList(page, schedulesUrl, domain, 5_000);
    expect(inUi).toBe(true);

    // CLI verify: schedule appears in CLI output.
    const r = await cliCall('cron', 'GET', '/v1/admin/schedules', undefined, envId);
    assertCliOk(r, 'cron schedule list (CLI verify)');
    expect(r.stdout.toLowerCase()).toContain(domain.toLowerCase());
    strict.assertNoFailures();
  });
});