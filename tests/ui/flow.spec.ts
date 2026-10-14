// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/ui/flow.spec.ts — E2E-UI-11: flow UI suite — full functional.
//
// Full lifecycle: overview → summary; workflows → list; steps → list.

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { URLs } from '../../fixtures/testdata.js';
import { waitForFlutterSemantics, getFlutterTexts, waitForFlutterContent, rfwCreateViaForm } from '../../fixtures/harness.js';
import { ensureSignedIn, getTestOrgId, getTestEnvId, navigateToDashPage } from './_setup.js';
import { StrictPage } from '../../fixtures/strictpage.js';
import { cliCall, assertCliOk } from '../../fixtures/cli.js';
import { RUN_ID } from '../../fixtures/testdata.js';


test.describe.configure({ mode: 'serial' });
test.describe('UI — flow (full functional)', () => {
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

  test('flow/overview — render, summary cards', async () => {
    await navigateToDashPage(page, 'flow', 'overview', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    expect((await getFlutterTexts(page)).length).toBeGreaterThan(0);
    strict.assertNoFailures();

    // CLI verify: flow workflows admin data is accessible.
    const r = await cliCall('flow', 'GET', '/v1/admin/workflows', undefined, envId);
    assertCliOk(r, 'flow overview (CLI verify)');
  });

  test('flow/workflows — list workflows', async () => {
    await navigateToDashPage(page, 'flow', 'workflows', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    expect((await getFlutterTexts(page)).length).toBeGreaterThan(0);
    strict.assertNoFailures();

    // CLI verify: flow workflows admin data is accessible.
    const r = await cliCall('flow', 'GET', '/v1/admin/workflows', undefined, envId);
    assertCliOk(r, 'flow workflows (CLI verify)');
  });

  test('flow/steps — list step executions', async () => {
    await navigateToDashPage(page, 'flow', 'steps', orgId, envId);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
    // Steps page may be empty (no workflows have run) — that's OK.
    // assertNoFailures catches any API errors.
    strict.assertNoFailures();

    // CLI verify: flow steps admin data is accessible.
    const r = await cliCall('flow', 'GET', '/v1/admin/steps', undefined, envId);
    assertCliOk(r, 'flow steps (CLI verify)');
  });

  // ════════════════════════════════════════════════════════════════════
  // Phase 3: Full functional CRUD test — create workflow
  // ════════════════════════════════════════════════════════════════════

  test('flow/workflows — create workflow, verify in UI + CLI', async () => {
    const logicId = `e2e-logic-${RUN_ID}`;
    const workflowsUrl = `${URLs.dash}/#/flow/workflows?env=${envId}`;
    const logicJson = JSON.stringify({ logic_id: logicId, version: 1, steps: [{ name: 'step1', kind: 'noop' }] });

    // Create workflow via UI form (like a human: click Create Workflow, fill fields, submit).
    await rfwCreateViaForm(page, workflowsUrl, 'Create Workflow', [
      { label: 'Domain', value: 'e2e' },
      { label: 'Logic Definition (JSON)', value: logicJson },
      { label: 'Input (JSON)', value: '{}' },
    ], 'Create Workflow');

    // UI verify: workflow page renders.
    await navigateToDashPage(page, 'sentin8-flow', 'workflows', undefined, envId);

    // CLI verify: workflow appears in CLI output.
    const r = await cliCall('flow', 'GET', '/v1/admin/workflows', undefined, envId);
    assertCliOk(r, 'flow workflow create (CLI verify)');
    expect(r.stdout).toContain(logicId);
    strict.assertNoFailures();
  });
});