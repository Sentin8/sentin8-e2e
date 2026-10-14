// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/ui/post.spec.ts — E2E-UI-14: post UI suite — full functional.
//
// Full lifecycle: messages → list; gateways → list; dlq → list.

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { URLs, RUN_ID } from '../../fixtures/testdata.js';
import { waitForFlutterSemantics, getFlutterTexts, waitForFlutterContent, rfwCreateViaForm, rfwVerifyInList, clickFlutterButton } from '../../fixtures/harness.js';
import { ensureSignedIn, getTestOrgId, getTestEnvId, navigateToDashPage } from './_setup.js';
import { StrictPage } from '../../fixtures/strictpage.js';
import { cliDo, cliCall, assertCliOk } from '../../fixtures/cli.js';


test.describe.configure({ mode: 'serial' });
test.describe('UI — post (full functional)', () => {
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

  test('post/messages — list messages', async () => {
    await navigateToDashPage(page, 'post', 'messages', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    expect((await getFlutterTexts(page)).length).toBeGreaterThan(0);
    strict.assertNoFailures();

    // CLI verify: post gateways admin data is accessible.
    const r = await cliCall('post', 'GET', '/v1/admin/gateways', undefined, envId);
    assertCliOk(r, 'post messages (CLI verify)');
  });

  test('post/gateways — list gateways', async () => {
    await navigateToDashPage(page, 'post', 'gateways', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    expect((await getFlutterTexts(page)).length).toBeGreaterThan(0);
    strict.assertNoFailures();

    // CLI verify: post gateways admin data is accessible.
    const r = await cliCall('post', 'GET', '/v1/admin/gateways', undefined, envId);
    assertCliOk(r, 'post gateways (CLI verify)');
  });

  test('post/dlq — list dead-lettered messages', async () => {
    await navigateToDashPage(page, 'post', 'dlq', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    expect((await getFlutterTexts(page)).length).toBeGreaterThan(0);
    strict.assertNoFailures();

    // CLI verify: post gateways admin data is accessible (dlq uses same admin layer).
    const r = await cliCall('post', 'GET', '/v1/admin/gateways', undefined, envId);
    assertCliOk(r, 'post dlq (CLI verify)');
  });

  // ════════════════════════════════════════════════════════════════════
  // Phase 3: Full functional CRUD test (E2E-UI-Full-12)
  // ════════════════════════════════════════════════════════════════════

  test('post/gateways — create gateway, verify in UI + CLI', async () => {
    const provider = `e2e-smtp-${RUN_ID}`;
    const gatewaysUrl = `${URLs.dash}/#/sentin8-post/gateways?env=${envId}`;

    // Create gateway via UI form (like a human: select Scope, Channel, type Provider, submit).
    await rfwCreateViaForm(page, gatewaysUrl, 'Create Gateway', [
      { label: 'Provider', value: provider },
    ], 'Create Gateway', [
      { label: 'Scope', option: 'Environment' },
      { label: 'Channel', option: 'Email' },
    ]);

    // UI verify: gateway appears in the list.
    const inUi = await rfwVerifyInList(page, gatewaysUrl, provider, 5_000);
    expect(inUi).toBe(true);

    // CLI verify: gateway appears in CLI output.
    const r = await cliCall('post', 'GET', '/v1/admin/gateways', undefined, envId);
    assertCliOk(r, 'post gateway list (CLI verify)');
    expect(r.stdout.toLowerCase()).toContain(provider.toLowerCase());
    strict.assertNoFailures();
  });
});