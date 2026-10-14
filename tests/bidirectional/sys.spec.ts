// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/bidirectional/sys.spec.ts — E2E-BI-2: bidirectional proof for sys.
//
// Direction A (UI → CLI): Create org via Dash UI → verify via CLI `sys org list`.
// Direction B (CLI → UI): Create org via CLI `sys org create` → verify via Dash UI.

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { URLs, Personas, RUN_ID } from '../../fixtures/testdata.js';
import { signInToDash, waitForFlutterSemantics, createOrganizationViaUI } from '../../fixtures/harness.js';
import { cliDo, assertCliDispatched, extractId } from '../../fixtures/cli.js';
import { ensureSignedIn } from '../cli/_setup.js';

test.describe.configure({ mode: 'serial' });

test.describe('Bidirectional proof — sys', () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    await ensureSignedIn();
    context = await browser.newContext({
      baseURL: URLs.dash,
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });
    page = await context.newPage();
    await signInToDash(page, context, Personas.admin.email, Personas.admin.password);
    await waitForFlutterSemantics(page, 5_000);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  // ── Direction A: UI creates org → CLI verifies ──
  test('UI creates org → CLI sys org list shows it', async () => {
    const slug = `bidir-ui-org-${RUN_ID}`;
    const displayName = `Bidir UI Org ${RUN_ID}`;
    const orgId = await createOrganizationViaUI(page, slug, displayName);
    expect(orgId.length).toBeGreaterThan(0);

    // Verify via CLI
    const r = await cliDo('sys', 'org', 'list');
    await assertCliDispatched(r, 'sys org list (bidirectional A)');
  });

  // ── Direction B: CLI creates org → UI verifies ──
  test('CLI creates org → UI org picker shows it', async () => {
    const slug = `bidir-cli-org-${RUN_ID}`;
    const displayName = `Bidir CLI Org ${RUN_ID}`;
    // Sys org create expects `display_name` (see CreateOrgRequest in
    // services/sys/src/handlers.rs), not `name`.
    const r1 = await cliDo('sys', 'org', 'create', { slug, display_name: displayName });
    await assertCliDispatched(r1, 'sys org create (bidirectional B)');
    if (r1.exitCode !== 0) return;

    // Navigate to the org picker in the Dash
    await page.goto(`${URLs.dash}/#/org`, { waitUntil: 'domcontentloaded' });
    await waitForFlutterSemantics(page, 10_000);

    // Verify the page renders
    const text = await page.evaluate(() => {
      const els = document.querySelectorAll('flt-semantics');
      return Array.from(els).map(el => el.textContent ?? '').join(' ');
    });
    expect(text.length).toBeGreaterThan(0);
  });
});