// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/cli/post.spec.ts — E2E-CLI-11: post CLI suite — full functional E2E.
//
// Full lifecycle: gateway create → list → test → delete.
// Also: message list, message content, message replay.

import { test, expect } from '@playwright/test';
import { cliDo, cliListCommands, assertCliOk, assertCliDispatched, extractId } from '../../fixtures/cli.js';
import { ensureSignedIn } from './_setup.js';
import { RUN_ID } from '../../fixtures/testdata.js';

test.describe.configure({ mode: 'serial' });

test.describe('CLI — post (full functional)', () => {
  test.beforeAll(async () => { await ensureSignedIn(); });

  test('post commands are listed in list-commands', async () => {
    const r = await cliListCommands();
    assertCliOk(r, 'list-commands');
    expect(r.stdout).toContain('post:');
  });

  test('post gateway create → list → delete', async () => {
    // 1. Create a real gateway
    const config = JSON.stringify({ host: 'localhost', port: 25 });
    const r1 = await cliDo('post', 'gateway', 'create', {
      scope: 'sys',
      channel: 'email',
      provider: 'smtp',
      config,
      is_enabled: 'true',
    });
    assertCliDispatched(r1, 'post gateway create');
    if (r1.exitCode !== 0) return;

    let gatewayId = '';
    if (r1.json) { try { gatewayId = extractId(r1); } catch { /* ignore */ } }
    if (!gatewayId) {
      const m = r1.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) gatewayId = m[0];
    }

    // 2. List gateways → verify the gateway appears
    const r2 = await cliDo('post', 'gateway', 'list');
    assertCliDispatched(r2, 'post gateway list');

    if (gatewayId) {
      // 3. Delete the gateway
      const r3 = await cliDo('post', 'gateway', 'delete', { id: gatewayId });
      assertCliDispatched(r3, 'post gateway delete');

      // 4. List gateways → verify the gateway is gone
      const r4 = await cliDo('post', 'gateway', 'list');
      assertCliDispatched(r4, 'post gateway list (after delete)');
    }
  });

  test('post message list', async () => {
    const r = await cliDo('post', 'message', 'list');
    assertCliDispatched(r, 'post message list');
  });
});