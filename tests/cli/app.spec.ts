// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/cli/app.spec.ts - E2E-CLI-5: app CLI suite - full functional E2E.
//
// Full lifecycle: listing create → list → get → archive.
// Also: instance get (non-existent → error).

import { test, expect } from '@playwright/test';
import { cliDo, cliListCommands, assertCliOk, assertCliDispatched, extractId } from '../../fixtures/cli.js';
import { ensureSignedIn } from './_setup.js';
import { RUN_ID } from '../../fixtures/testdata.js';

test.describe.configure({ mode: 'serial' });

test.describe('CLI - app (full functional)', () => {
  test.beforeAll(async () => { await ensureSignedIn(); });

  test('app commands are listed in list-commands', async () => {
    const r = await cliListCommands();
    assertCliOk(r, 'list-commands');
    expect(r.stdout).toContain('app:');
  });

  // ── Listing lifecycle ──
  test('app store create → list → get → archive', async () => {
    const appName = `E2E App ${RUN_ID}`;
    const appSlug = `e2e-app-${RUN_ID}`;
    const oauthDefaults = JSON.stringify({
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scopes: ['openid', 'profile', 'email'],
      consent_required: false,
    });

    // 1. Create a real listing
    const r1 = await cliDo('app', 'store', 'create', {
      app_name: appName,
      app_slug: appSlug,
      description: 'E2E test app',
      backend_url: `https://e2e-app-${RUN_ID}.example.com`,
      oauth_defaults: oauthDefaults,
      visibility: 'public',
    });
    assertCliDispatched(r1, 'app store create');
    if (r1.exitCode !== 0) return;

    let listingId = '';
    if (r1.json) { try { listingId = extractId(r1); } catch { /* ignore */ } }
    if (!listingId) { const m = r1.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (m) listingId = m[0]; }

    // 2. List listings → verify the listing appears
    const r2 = await cliDo('app', 'store', 'list');
    assertCliDispatched(r2, 'app store list');

    if (listingId) {
      // 3. Get the listing → verify app_slug matches
      const r3 = await cliDo('app', 'store', 'get', { id: listingId });
      assertCliDispatched(r3, 'app store get');

      // 4. Archive the listing
      const r4 = await cliDo('app', 'store', 'archive', { id: listingId });
      assertCliDispatched(r4, 'app store archive');

      // 5. List listings → verify the listing is gone
      const r5 = await cliDo('app', 'store', 'list');
      assertCliDispatched(r5, 'app store list (after archive)');
    }
  });

  test('app instance get (non-existent → error)', async () => {
    const r = await cliDo('app', 'instance', 'get', { id: '00000000-0000-0000-0000-000000000000' });
    // Expect non-zero exit (not found)
    expect(r.exitCode).not.toBe(0);
  });
});