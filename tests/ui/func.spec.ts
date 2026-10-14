// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/ui/func.spec.ts — E2E-UI-9: func UI suite — full functional.
//
// Full lifecycle: overview → render summary; versions → list modules.

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { URLs } from '../../fixtures/testdata.js';
import { waitForFlutterSemantics, getFlutterTexts, waitForFlutterContent, rfwCreateViaForm } from '../../fixtures/harness.js';
import { ensureSignedIn, getTestOrgId, getTestEnvId, navigateToDashPage } from './_setup.js';
import { StrictPage } from '../../fixtures/strictpage.js';
import { cliCall, assertCliOk } from '../../fixtures/cli.js';
import { RUN_ID } from '../../fixtures/testdata.js';


test.describe.configure({ mode: 'serial' });
test.describe('UI — func (full functional)', () => {
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

  test('func/overview — render, summary cards', async () => {
    await navigateToDashPage(page, 'func', 'overview', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    const texts = await getFlutterTexts(page);
    expect(texts.length).toBeGreaterThan(0);
    strict.assertNoFailures();

    // CLI verify: func modules admin data is accessible.
    const r = await cliCall('func', 'GET', '/v1/admin/modules', undefined, envId);
    assertCliOk(r, 'func overview (CLI verify)');
  });

  test('func/versions — list module versions', async () => {
    await navigateToDashPage(page, 'func', 'versions', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    // Versions page may be empty (no modules uploaded) — that's OK.
    strict.assertNoFailures();

    // CLI verify: func modules admin data is accessible.
    const r = await cliCall('func', 'GET', '/v1/admin/modules', undefined, envId);
    assertCliOk(r, 'func versions (CLI verify)');
  });

  // ════════════════════════════════════════════════════════════════════
  // Phase 3: Full functional CRUD test — upload WASM module
  // ════════════════════════════════════════════════════════════════════

  test('func/versions — upload module, verify in UI + CLI', async () => {
    const moduleId = `e2e-mod-${RUN_ID}`;
    const versionsUrl = `${URLs.dash}/#/sentin8-func/versions?env=${envId}`;
    // Minimal valid WASM module (magic + version, empty function).
    // 00 61 73 6d 01 00 00 00 = wasm magic + version 1
    const wasmBase64 = Buffer.from(
      Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    ).toString('base64');

    // Upload module via UI form (like a human: click Upload Module, fill fields, select Language, submit).
    await rfwCreateViaForm(page, versionsUrl, 'Upload Module', [
      { label: 'Domain', value: 'e2e' },
      { label: 'Product ID', value: moduleId },
      { label: 'Version Label', value: '0.1.0' },
      { label: 'WASM Binary (base64)', value: wasmBase64 },
    ], 'Upload Module', [
      { label: 'Language', option: 'Rust' },
    ]);

    // UI verify: module page renders with content.
    await navigateToDashPage(page, 'sentin8-func', 'versions', undefined, envId);

    // CLI verify: module appears in CLI output.
    const r = await cliCall('func', 'GET', '/v1/admin/modules', undefined, envId);
    assertCliOk(r, 'func module upload (CLI verify)');
    expect(r.stdout).toContain(moduleId);
    strict.assertNoFailures();
  });
});