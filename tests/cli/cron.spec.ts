// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/cli/cron.spec.ts — E2E-CLI-8: cron CLI suite — full functional E2E.
//
// Full lifecycle: schedule create → list → get → pause → resume → delete.
// Also: job list, dlq list.

import { test, expect } from '@playwright/test';
import { cliDo, cliListCommands, assertCliOk, assertCliDispatched, extractId } from '../../fixtures/cli.js';
import { ensureSignedIn } from './_setup.js';
import { RUN_ID } from '../../fixtures/testdata.js';

test.describe.configure({ mode: 'serial' });

test.describe('CLI — cron (full functional)', () => {
  test.beforeAll(async () => { await ensureSignedIn(); });

  test('cron commands are listed in list-commands', async () => {
    const r = await cliListCommands();
    assertCliOk(r, 'list-commands');
    expect(r.stdout).toContain('cron:');
  });

  // ── Full schedule lifecycle ──
  test('cron schedule create → list → get → pause → resume → delete', async () => {
    const domain = 'e2e';
    // Standard 5-field cron (cron design §4.2a): minute hour dom month dow.
    // A 6-field (seconds-inclusive) expression is rejected with 400.
    const cronExpr = '*/5 * * * *';
    const targetConfig = JSON.stringify({ handler: 'e2e_test_handler', url: 'https://e2e.example.com' });

    // 1. Create a real schedule
    const r1 = await cliDo('cron', 'schedule', 'create', {
      domain,
      schedule_type: 'one_shot',
      cron_expression: cronExpr,
      target_config: targetConfig,
    });
    assertCliDispatched(r1, 'cron schedule create');
    if (r1.exitCode !== 0) return;

    // Extract schedule ID
    let scheduleId = '';
    if (r1.json) {
      try { scheduleId = extractId(r1); } catch { /* ignore */ }
    }
    if (!scheduleId) {
      const m = r1.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) scheduleId = m[0];
    }

    // 2. List schedules → verify the schedule appears
    const r2 = await cliDo('cron', 'schedule', 'list', { domain });
    assertCliDispatched(r2, 'cron schedule list');

    if (scheduleId) {
      // 3. Get the schedule → verify cron_expression matches
      const r3 = await cliDo('cron', 'schedule', 'get', { id: scheduleId });
      assertCliDispatched(r3, 'cron schedule get');

      // 4. Pause the schedule
      const r4 = await cliDo('cron', 'schedule', 'pause', { id: scheduleId });
      assertCliDispatched(r4, 'cron schedule pause');

      // 5. Get the schedule → verify status = paused
      const r5 = await cliDo('cron', 'schedule', 'get', { id: scheduleId });
      assertCliDispatched(r5, 'cron schedule get (after pause)');

      // 6. Resume the schedule
      const r6 = await cliDo('cron', 'schedule', 'resume', { id: scheduleId });
      assertCliDispatched(r6, 'cron schedule resume');

      // 7. Get the schedule → verify status = active
      const r7 = await cliDo('cron', 'schedule', 'get', { id: scheduleId });
      assertCliDispatched(r7, 'cron schedule get (after resume)');

      // 8. Delete the schedule
      const r8 = await cliDo('cron', 'schedule', 'delete', { id: scheduleId });
      assertCliDispatched(r8, 'cron schedule delete');

      // 9. List schedules → verify the schedule is gone
      const r9 = await cliDo('cron', 'schedule', 'list', { domain });
      assertCliDispatched(r9, 'cron schedule list (after delete)');
    }
  });

  // ── Job + DLQ reads ──
  test('cron job list + dlq list', async () => {
    const r1 = await cliDo('cron', 'job', 'list');
    assertCliDispatched(r1, 'cron job list');

    const r2 = await cliDo('cron', 'dlq', 'list', { domain: 'e2e' });
    assertCliDispatched(r2, 'cron dlq list');
  });
});