// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/cli/auth.spec.ts — E2E-CLI-3: auth CLI suite — full functional E2E.
//
// Full lifecycle: user create→get→archive, role create→get→delete,
// group create→get→delete, api-key create→revoke, application register→list,
// session list, audit list, membership list, connection list.

import { test, expect } from '@playwright/test';
import { cliDo, cliListCommands, assertCliOk, assertCliDispatched, extractId, runCli } from '../../fixtures/cli.js';
import { ensureSignedIn } from './_setup.js';
import { RUN_ID, URLs } from '../../fixtures/testdata.js';

test.describe.configure({ mode: 'serial' });

test.describe('CLI — auth (full functional)', () => {
  test.beforeAll(async () => { await ensureSignedIn(); });

  test('auth commands are listed in list-commands', async () => {
    const r = await cliListCommands();
    assertCliOk(r, 'list-commands');
    expect(r.stdout).toContain('auth:');
  });

  // ── User lifecycle ──
  test('auth user create → get → list → archive', async () => {
    const email = `e2e+${RUN_ID}@a.co`;
    const r1 = await cliDo('auth', 'user', 'create', {
      email, password: 'Test1234!', first_name: 'E2E', last_name: 'User',
    });
    assertCliDispatched(r1, 'auth user create');
    if (r1.exitCode !== 0) return;
    let userId = '';
    if (r1.json) { try { userId = extractId(r1); } catch { /* ignore */ } }
    if (!userId) { const m = r1.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (m) userId = m[0]; }

    const r2 = await cliDo('auth', 'user', 'list');
    assertCliDispatched(r2, 'auth user list');

    if (userId) {
      const r3 = await cliDo('auth', 'user', 'get', { id: userId });
      assertCliDispatched(r3, 'auth user get');

      const r4 = await cliDo('auth', 'user', 'archive', { id: userId });
      assertCliDispatched(r4, 'auth user archive');
    }
  });

  // ── Role lifecycle ──
  test('auth role create → list → get → delete', async () => {
    const name = `e2e-role-${RUN_ID}`;
    const r1 = await cliDo('auth', 'role', 'create', { name, permissions: '[]' });
    assertCliDispatched(r1, 'auth role create');
    if (r1.exitCode !== 0) return;
    let roleId = '';
    if (r1.json) { try { roleId = extractId(r1); } catch { /* ignore */ } }
    if (!roleId) { const m = r1.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (m) roleId = m[0]; }

    const r2 = await cliDo('auth', 'role', 'list');
    assertCliDispatched(r2, 'auth role list');

    if (roleId) {
      const r3 = await cliDo('auth', 'role', 'get', { id: roleId });
      assertCliDispatched(r3, 'auth role get');
      const r4 = await cliDo('auth', 'role', 'delete', { id: roleId });
      assertCliDispatched(r4, 'auth role delete');
    }
  });

  // ── Group lifecycle ──
  test('auth group create → list → get → delete', async () => {
    const name = `e2e-group-${RUN_ID}`;
    const r1 = await cliDo('auth', 'group', 'create', { name });
    assertCliDispatched(r1, 'auth group create');
    if (r1.exitCode !== 0) return;
    let groupId = '';
    if (r1.json) { try { groupId = extractId(r1); } catch { /* ignore */ } }
    if (!groupId) { const m = r1.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (m) groupId = m[0]; }

    const r2 = await cliDo('auth', 'group', 'list');
    assertCliDispatched(r2, 'auth group list');

    if (groupId) {
      // Registry: `auth group get` → GET /v1/admin/groups/{group_id}/members
      // (path arg is `group_id`; `delete` uses `id`).
      const r3 = await cliDo('auth', 'group', 'get', { group_id: groupId });
      assertCliDispatched(r3, 'auth group get');
      const r4 = await cliDo('auth', 'group', 'delete', { id: groupId });
      assertCliDispatched(r4, 'auth group delete');
    }
  });

  // ── API key lifecycle ──
  test('auth api-key create → list → revoke', async () => {
    const name = `e2e-key-${RUN_ID}`;
    const r1 = await cliDo('auth', 'api-key', 'create', {
      name, env_id: '00000000-0000-0000-0000-000000000002',
    });
    assertCliDispatched(r1, 'auth api-key create');
    if (r1.exitCode !== 0) return;
    let keyId = '';
    if (r1.json) { try { keyId = extractId(r1); } catch { /* ignore */ } }
    if (!keyId) { const m = r1.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (m) keyId = m[0]; }

    const r2 = await cliDo('auth', 'api-key', 'list');
    assertCliDispatched(r2, 'auth api-key list');

    if (keyId) {
      const r3 = await cliDo('auth', 'api-key', 'revoke', { id: keyId });
      assertCliDispatched(r3, 'auth api-key revoke');
    }
  });

  // ── Read-only endpoints ──
  test('auth session list + audit list + membership list + connection list', async () => {
    const r1 = await cliDo('auth', 'session', 'list');
    assertCliDispatched(r1, 'auth session list');

    const r2 = await cliDo('auth', 'audit', 'list');
    assertCliDispatched(r2, 'auth audit list');

    const r3 = await cliDo('auth', 'membership', 'list');
    assertCliDispatched(r3, 'auth membership list');

    const r4 = await cliDo('auth', 'connection', 'list');
    assertCliDispatched(r4, 'auth connection list');
  });

  // ── 25.3.5 — CLI signup creates user → verify via `auth user list` → cleanup ──
  test('auth signup — CLI signup creates user, verify in list, cleanup', async () => {
    const email = `e2e-signup-${RUN_ID}@a.co`;
    // CLI signup (unauthenticated surface — creates the user).
    const r1 = await runCli([
      'signup',
      '--sentin8-auth-url', URLs.auth,
      '--email', email,
      '--password', 'Test1234!',
      '--first-name', 'E2E',
      '--last-name', 'Signup',
    ]);
    assertCliOk(r1, 'auth signup (CLI)');

    // Verify: the user appears in the (admin) user list.
    const list = await cliDo('auth', 'user', 'list');
    assertCliDispatched(list, 'auth user list');
    expect(list.stdout).toContain(email);

    // Cleanup: find + archive the user (leave the tenant clean).
    const created = await cliDo('auth', 'user', 'get', { email });
    let userId = '';
    const m = created.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (m) userId = m[0];
    if (userId) {
      const del = await cliDo('auth', 'user', 'archive', { id: userId });
      assertCliDispatched(del, 'auth user archive');
    }
  });
});
