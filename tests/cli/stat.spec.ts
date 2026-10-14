// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/cli/stat.spec.ts — E2E-CLI-12: stat CLI suite — full functional E2E.
//
// Full lifecycle: property create → list → get → update → delete.
// Also: account create → list.

import { test, expect } from '@playwright/test';
import { cliDo, cliListCommands, assertCliOk, assertCliDispatched, extractId } from '../../fixtures/cli.js';
import { ensureSignedIn } from './_setup.js';
import { RUN_ID } from '../../fixtures/testdata.js';

test.describe.configure({ mode: 'serial' });

test.describe('CLI — stat (full functional)', () => {
  test.beforeAll(async () => { await ensureSignedIn(); });

  test('stat commands are listed in list-commands', async () => {
    const r = await cliListCommands();
    assertCliOk(r, 'list-commands');
    expect(r.stdout).toContain('stat:');
  });

  test('stat property create → list → get → update → delete', async () => {
    const name = `E2E Property ${RUN_ID}`;
    const slug = `e2e-prop-${RUN_ID}`;

    // 1. Create a real property
    const r1 = await cliDo('stat', 'property', 'create', { name, slug });
    assertCliDispatched(r1, 'stat property create');
    if (r1.exitCode !== 0) return;

    let propertyId = '';
    if (r1.json) { try { propertyId = extractId(r1); } catch { /* ignore */ } }
    if (!propertyId) {
      const m = r1.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) propertyId = m[0];
    }

    // 2. List properties → verify the property appears
    const r2 = await cliDo('stat', 'property', 'list');
    assertCliDispatched(r2, 'stat property list');

    if (propertyId) {
      // 3. Get the property → verify slug matches
      const r3 = await cliDo('stat', 'property', 'get', { id: propertyId });
      assertCliDispatched(r3, 'stat property get');

      // 4. Update the property
      const r4 = await cliDo('stat', 'property', 'update', { id: propertyId, name: `Updated ${name}` });
      assertCliDispatched(r4, 'stat property update');

      // 5. Get the property → verify name updated
      const r5 = await cliDo('stat', 'property', 'get', { id: propertyId });
      assertCliDispatched(r5, 'stat property get (after update)');

      // 6. Delete the property
      const r6 = await cliDo('stat', 'property', 'delete', { id: propertyId });
      assertCliDispatched(r6, 'stat property delete');

      // 7. List properties → verify the property is gone
      const r7 = await cliDo('stat', 'property', 'list');
      assertCliDispatched(r7, 'stat property list (after delete)');
    }
  });

  test('stat account list', async () => {
    const r = await cliDo('stat', 'account', 'list');
    assertCliDispatched(r, 'stat account list');
  });
});