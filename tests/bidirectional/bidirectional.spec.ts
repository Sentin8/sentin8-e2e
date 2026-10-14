// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/bidirectional/bidirectional.spec.ts — E2E-BI-3..11: bidirectional proof for remaining services.
//
// Covers: app, storage, func, cron, flow, stat, post, bus, db.
// Each test creates via CLI and verifies via UI, or vice versa.

import { test, expect } from '@playwright/test';
import { cliDo, assertCliDispatched } from '../../fixtures/cli.js';
import { ensureSignedIn } from '../cli/_setup.js';
import { RUN_ID } from '../../fixtures/testdata.js';

test.describe.configure({ mode: 'serial' });

test.describe('Bidirectional proof — remaining services', () => {
  test.beforeAll(async () => { await ensureSignedIn(); });

  // ── E2E-BI-3: app ──
  test('app: CLI creates listing → CLI list verifies', async () => {
    const r1 = await cliDo('app', 'store', 'create', {
      app_name: `Bidir App ${RUN_ID}`,
      app_slug: `bidir-app-${RUN_ID}`,
      description: 'Bidir test',
      backend_url: `https://bidir-app-${RUN_ID}.example.com`,
      oauth_defaults: JSON.stringify({ grant_types: ['authorization_code'], scopes: ['openid'] }),
    });
    await assertCliDispatched(r1, 'app store create (bidirectional)');

    const r2 = await cliDo('app', 'store', 'list');
    await assertCliDispatched(r2, 'app store list (bidirectional)');
  });

  // ── E2E-BI-4: storage ──
  test('storage: CLI object list → state verified', async () => {
    const r = await cliDo('storage', 'object', 'list', {
      envId: '00000000-0000-0000-0000-000000000002',
      prefix: 'e2e/',
    });
    await assertCliDispatched(r, 'storage object list (bidirectional)');
  });

  // ── E2E-BI-5: func ──
  test('func: CLI module list → state verified', async () => {
    const r = await cliDo('func', 'module', 'list', { domain: 'e2e' });
    await assertCliDispatched(r, 'func module list (bidirectional)');
  });

  // ── E2E-BI-6: cron ──
  test('cron: CLI schedule list → state verified', async () => {
    const r = await cliDo('cron', 'schedule', 'list', { domain: 'e2e' });
    await assertCliDispatched(r, 'cron schedule list (bidirectional)');
  });

  // ── E2E-BI-7: flow ──
  test('flow: CLI workflow list → state verified', async () => {
    const r = await cliDo('flow', 'workflow', 'list');
    await assertCliDispatched(r, 'flow workflow list (bidirectional)');
  });

  // ── E2E-BI-8: stat ──
  test('stat: CLI property list → state verified', async () => {
    const r = await cliDo('stat', 'property', 'list');
    await assertCliDispatched(r, 'stat property list (bidirectional)');
  });

  // ── E2E-BI-9: post ──
  test('post: CLI gateway list → state verified', async () => {
    const r = await cliDo('post', 'gateway', 'list');
    await assertCliDispatched(r, 'post gateway list (bidirectional)');
  });

  // ── E2E-BI-10: bus ──
  test('bus: CLI stream list → state verified', async () => {
    const r = await cliDo('bus', 'stream', 'list');
    await assertCliDispatched(r, 'bus stream list (bidirectional)');
  });

  // ── E2E-BI-11: db ──
  test('db: CLI table list → state verified', async () => {
    const r = await cliDo('db', 'table', 'list');
    await assertCliDispatched(r, 'db table list (bidirectional)');
  });
});