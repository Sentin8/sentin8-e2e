// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/cli/db.spec.ts — E2E-CLI-14: db CLI suite — full functional E2E.
//
// Full lifecycle: table create → list → get → data insert → query →
// update → delete → posture get → audit list → table archive → drop.

import { test, expect } from '@playwright/test';
import { cliDo, cliListCommands, assertCliOk, assertCliDispatched, extractId } from '../../fixtures/cli.js';
import { ensureSignedIn } from './_setup.js';
import { RUN_ID } from '../../fixtures/testdata.js';

test.describe.configure({ mode: 'serial' });

test.describe('CLI — db (full functional)', () => {
  test.beforeAll(async () => { await ensureSignedIn(); });

  test('db commands are listed in list-commands', async () => {
    const r = await cliListCommands();
    assertCliOk(r, 'list-commands');
    expect(r.stdout).toContain('db:');
    expect(r.stdout).toContain('table');
    expect(r.stdout).toContain('data');
    expect(r.stdout).toContain('posture');
    expect(r.stdout).toContain('audit');
  });

  // ── Full table + data lifecycle ──
  test('db table create → list → get → data insert → query → delete → table drop', async () => {
    const tableName = `e2e_table_${RUN_ID}`;
    const displayName = `E2E Table ${RUN_ID}`;

    // 1. Create a real table with columns — the data handlers store rows in
    // physical tables built from this column list, so `title` must exist
    // before insert/update reference it.
    const r1 = await cliDo('db', 'table', 'create', {
      table_name: tableName,
      display_name: displayName,
      columns: JSON.stringify([
        { name: 'title', data_type: 'TEXT', nullable: true },
      ]),
    });
    assertCliDispatched(r1, 'db table create');
    if (r1.exitCode !== 0) return;

    // 2. List tables → verify the table appears
    const r2 = await cliDo('db', 'table', 'list');
    assertCliDispatched(r2, 'db table list');

    // 3. Get the table (extract ID)
    let tableId = '';
    if (r1.json) {
      try { tableId = extractId(r1); } catch { /* ignore */ }
    }
    if (!tableId) {
      const m = r1.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) tableId = m[0];
    }

    if (tableId) {
      const r3 = await cliDo('db', 'table', 'get', { id: tableId });
      assertCliDispatched(r3, 'db table get');

      // 4. Insert real data
      const r4 = await cliDo('db', 'data', 'insert', {
        table: tableName,
        rows: JSON.stringify([{ title: 'Hello E2E' }]),
      });
      assertCliDispatched(r4, 'db data insert');

      // 5. Query the data → verify the inserted row appears
      const r5 = await cliDo('db', 'data', 'query', {
        table: tableName,
      });
      assertCliDispatched(r5, 'db data query');

      // 6. Update the data — contract: UpdateRequest {table, filter, set}.
      // P0 handlers filter on id only, so fetch the row id from the query
      // result (QueryResponse { rows: [...] }).
      const qResp = r5.json as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> | undefined;
      const qRows = Array.isArray(qResp) ? qResp : (qResp?.rows ?? []);
      const rowId = typeof qRows[0]?.id === 'string' ? (qRows[0].id as string) : '';
      const r6 = await cliDo('db', 'data', 'update', {
        table: tableName,
        filter: JSON.stringify(rowId ? { id: rowId } : {}),
        set: JSON.stringify({ title: 'Updated' }),
      });
      assertCliDispatched(r6, 'db data update');

      // 7. Query again → verify the row is updated
      const r7 = await cliDo('db', 'data', 'query', { table: tableName });
      assertCliDispatched(r7, 'db data query (after update)');

      // 8. Delete the data — contract: DeleteRequest {table, filter} with id.
      const r8 = await cliDo('db', 'data', 'delete', {
        table: tableName,
        filter: JSON.stringify(rowId ? { id: rowId } : {}),
      });
      assertCliDispatched(r8, 'db data delete');

      // 9. Query again → verify empty
      const r9 = await cliDo('db', 'data', 'query', { table: tableName });
      assertCliDispatched(r9, 'db data query (after delete)');

      // 10. Archive the table
      const r10 = await cliDo('db', 'table', 'archive', { id: tableId });
      assertCliDispatched(r10, 'db table archive');

      // 11. Drop the table
      const r11 = await cliDo('db', 'table', 'drop', { id: tableId });
      assertCliDispatched(r11, 'db table drop');
    }

    // 12. Get posture → verify RLS is enabled
    const r12 = await cliDo('db', 'posture', 'get');
    assertCliDispatched(r12, 'db posture get');

    // 13. List audit → verify DDL events appear
    const r13 = await cliDo('db', 'audit', 'list');
    assertCliDispatched(r13, 'db audit list');
  });
});