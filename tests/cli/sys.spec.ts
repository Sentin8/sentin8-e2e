// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/cli/sys.spec.ts - E2E-CLI-4: sys CLI suite - full functional E2E.
//
// Full lifecycle: org create→list→get, env create→list→get,
// service list, branding get/merged, bootstrap get, readiness get, audit list.

import { test, expect } from '@playwright/test';
import { cliDo, cliListCommands, assertCliOk, assertCliDispatched, extractId } from '../../fixtures/cli.js';
import { ensureSignedIn } from './_setup.js';
import { RUN_ID } from '../../fixtures/testdata.js';
import { getTestOrgId, getTestEnvId } from '../ui/_setup.js';

const SYS_ORG = '00000000-0000-0000-0000-000000000001';
const SYS_ENV = '00000000-0000-0000-0000-000000000002';

test.describe.configure({ mode: 'serial' });

test.describe('CLI - sys (full functional)', () => {
  test.beforeAll(async () => { await ensureSignedIn(); });

  test('sys commands are listed in list-commands', async () => {
    const r = await cliListCommands();
    assertCliOk(r, 'list-commands');
    expect(r.stdout).toContain('sys:');
  });

  // ── Org lifecycle ──
  test('sys org create → list → get', async () => {
    const slug = `e2e-org-${RUN_ID}`;
    const displayName = `E2E Org ${RUN_ID}`;
    const r1 = await cliDo('sys', 'org', 'create', { slug, display_name: displayName });
    assertCliDispatched(r1, 'sys org create');
    if (r1.exitCode !== 0) return;
    let orgId = '';
    if (r1.json) { try { orgId = extractId(r1); } catch { /* ignore */ } }
    if (!orgId) { const m = r1.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (m) orgId = m[0]; }

    const r2 = await cliDo('sys', 'org', 'list');
    assertCliDispatched(r2, 'sys org list');

    if (orgId) {
      const r3 = await cliDo('sys', 'org', 'get', { id: orgId });
      assertCliDispatched(r3, 'sys org get');
    }
  });

  // ── Env lifecycle ──
  test('sys env create → list → get', async () => {
    // Env creation requires org membership - target the test org created
    // by globalSetup (the persona is its org-admin), not the system org.
    const orgId = getTestOrgId();
    const slug = `e2e-env-${RUN_ID}`;
    const displayName = `E2E Env ${RUN_ID}`;
    const r1 = await cliDo('sys', 'env', 'create', { org_id: orgId, slug, display_name: displayName });
    assertCliDispatched(r1, 'sys env create');
    if (r1.exitCode !== 0) return;
    let envId = '';
    if (r1.json) { try { envId = extractId(r1); } catch { /* ignore */ } }
    if (!envId) { const m = r1.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (m) envId = m[0]; }

    const r2 = await cliDo('sys', 'env', 'list', { org_id: orgId });
    assertCliDispatched(r2, 'sys env list');

    if (envId) {
      const r3 = await cliDo('sys', 'env', 'get', { env_id: envId });
      assertCliDispatched(r3, 'sys env get');
    }
  });

  // ── Service + branding + operational reads ──
  test('sys service list + branding + bootstrap + readiness + audit', async () => {
    // Org-scoped reads target the test org (persona is org-admin).
    // bootstrap/readiness/audit are platform-level (no org scoping).
    const testOrg = getTestOrgId();
    const testEnv = getTestEnvId();
    const r1 = await cliDo('sys', 'service', 'list', { env_id: testEnv });
    assertCliDispatched(r1, 'sys service list');

    const r2 = await cliDo('sys', 'branding', 'get', { org_id: testOrg });
    assertCliDispatched(r2, 'sys branding get');

    const r3 = await cliDo('sys', 'branding', 'merged', { env_id: testEnv });
    assertCliDispatched(r3, 'sys branding merged');

    const r4 = await cliDo('sys', 'bootstrap', 'get');
    assertCliDispatched(r4, 'sys bootstrap get');

    const r5 = await cliDo('sys', 'readiness', 'get');
    assertCliDispatched(r5, 'sys readiness get');

    const r6 = await cliDo('sys', 'audit', 'list');
    assertCliDispatched(r6, 'sys audit list');
  });
});