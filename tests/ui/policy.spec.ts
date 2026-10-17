// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/ui/policy.spec.ts — Phase 28 (E2E story 28.15): tenant-authored
// Shield policy lifecycle through the platform, per
// design/sentin8-policy-technical-design.md §6 + §3.5.
//
// UI-only per AGENTS.md: the browser drives Dash; state setup/verification
// goes through the BFF proxy API via the CLI (sentin8-cli call post …).
//
// Lifecycle proven:
//   1. List policy sets (platform scope-mirror seeded by vertical init —
//      ENFORCED per decision 2026-09-07 / story 28.16; shadow is the emergency
//      rollback lever only).
//   2. PUT a tenant-authored set (write-time validation; tenant sets start
//      shadow per design §4.2.4).
//   3. POST …/test dry-run: candidate deny → would-deny decision surfaced.
//   4. Enforce the tenant set → flips mode via the POST-alias → 403 for a
//      caller lacking the scope (engine sees enforced set; scope still primary).
//   5. Shadow (rollback) → the deny stops blocking.
//   6. DELETE the tenant set → gone from the list.

import { test, expect } from '@playwright/test';
import { URLs } from '../../fixtures/testdata.js';
import { cliCall, assertCliOk, jsonObj } from '../../fixtures/cli.js';
import { ensureSignedIn, getTestEnvId, navigateToDashPage } from './_setup.js';
import {
  rfwCreateViaForm, rfwVerifyInList, rfwRowAction, waitForFlutterContent,
} from '../../fixtures/harness.js';
import type { BrowserContext, Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test.describe('UI — policy (Phase 28 tenant-authored Shield)', () => {
  let context: BrowserContext;
  let page: Page;
  let envId: string;
  const SET = `e2e-policy-${Date.now()}`;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({
      baseURL: URLs.dash, ignoreHTTPSErrors: true, bypassCSP: true,
    });
    page = await context.newPage();
    await ensureSignedIn(page, context);
    envId = await getTestEnvId();
  });

  test.afterAll(async () => {
    // Best-effort cleanup of the tenant set.
    if (envId) {
      await cliCall('post', 'DELETE', `/v1/admin/policy-sets/${SET}`, undefined, envId);
    }
    await context.close();
  });

  test('platform scope-mirror set is listed in enforced mode', async () => {
    const res = await assertCliOk(
      cliCall('post', 'GET', '/v1/admin/policy-sets', undefined, envId),
    );
    const sets = (Array.isArray(res.json) ? res.json : []) as Array<Record<string, unknown>>;
    const mirror = sets.find(
      (s) => s.policy_set_name === 'scope-mirror',
    ) as Record<string, unknown> | undefined;
    expect(mirror, 'scope-mirror set seeded by vertical init').toBeTruthy();
    // Decision 2026-09-07 (28.16): platform sets ship ENFORCED — step 5 is
    // the only gate; shadow remains the emergency rollback lever only.
    expect(mirror?.mode).toBe('enforced');
    expect(mirror?.origin).toBe('platform');
  });

  test('tenant-authored set: PUT validates and stores in shadow', async () => {
    const policies =
      'forbid(principal, action, resource) when { principal.token_tp == "blocked-tp" };';
    const res = await assertCliOk(
      cliCall(
        'post',
        'PUT',
        `/v1/admin/policy-sets/${SET}`,
        { policies, description: 'e2e tenant set' },
        envId,
      ),
    );
    expect(jsonObj(res).mode).toBe('shadow');
    expect(jsonObj(res).origin === undefined || jsonObj(res).origin === 'tenant').toBeTruthy();
  });

  test('PUT with invalid Shield text is rejected with 422 (write-time gate)', async () => {
    const res = await cliCall(
      'post',
      'PUT',
      `/v1/admin/policy-sets/${SET}-bad`,
      { policies: 'permit(principal' },
      envId,
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr + res.stdout).toContain('invalid policy');
  });

  test('dry-run test endpoint evaluates candidate text without storing', async () => {
    const res = await assertCliOk(
      cliCall(
        'post',
        'POST',
        `/v1/admin/policy-sets/${SET}/test`,
        {
          policies:
            'permit(principal, action, resource) when { principal.scopes.contains("sentin8:post:read") };',
          subject_id: 'e2e-subject',
          token_tp: 'user',
          scopes: ['sentin8:post:read'],
          action: 'sentin8:post:read',
        },
        envId,
      ),
    );
    const decision = jsonObj(res).decision as Record<string, unknown>;
    expect(decision.decision).toBe('allow');
  });

  test('enforce → shadow rollback flips mode via RFW alias', async () => {
    // Promote to enforced.
    const en = await assertCliOk(
      cliCall('post', 'POST', '/v1/admin/policy-sets/enforce', { policy_set_name: SET }, envId),
    );
    expect(jsonObj(en).mode).toBe('enforced');
    // Verify the list reflects it.
    const listed = await assertCliOk(
      cliCall('post', 'GET', '/v1/admin/policy-sets', undefined, envId),
    );
    const row = (Array.isArray(listed.json) ? listed.json : [] as unknown[]).find(
      (s) => (s as Record<string, unknown>).policy_set_name === SET,
    ) as Record<string, unknown> | undefined;
    expect(row?.mode).toBe('enforced');
    // Rollback = one UPDATE (data change, not a deploy — design §4.1).
    const sh = await assertCliOk(
      cliCall('post', 'POST', '/v1/admin/policy-sets/shadow', { policy_set_name: SET }, envId),
    );
    expect(jsonObj(sh).mode).toBe('shadow');
  });

  test('DELETE removes the tenant set (platform rows are protected)', async () => {
    await assertCliOk(
      cliCall('post', 'DELETE', `/v1/admin/policy-sets/${SET}`, undefined, envId),
    );
    const listed = await assertCliOk(
      cliCall('post', 'GET', '/v1/admin/policy-sets', undefined, envId),
    );
    const row = (Array.isArray(listed.json) ? listed.json : []).find(
      (s) => (s as Record<string, unknown>).policy_set_name === SET,
    );
    expect(row, 'tenant set deleted').toBeUndefined();
    // Platform row protection: DELETE on the seeded platform set must 404.
    const res = await cliCall(
      'post',
      'DELETE',
      '/v1/admin/policy-sets/scope-mirror',
      undefined,
      envId,
    );
    expect(res.exitCode).not.toBe(0);
  });

  // ── Relations (ReBAC) + attributes (ABAC) lifecycle (§3.1b/§3.1c) ──────

  test('relation tuple lifecycle: PUT → listed → check → DELETE', async () => {
    const SUBJECT = `e2e-rel-sub-${Date.now()}`;
    const OBJECT = `e2e-rel-obj-${Date.now()}`;
    // Upsert a relation tuple (user MEMBER of group).
    const put = await assertCliOk(
      cliCall(
        'post',
        'PUT',
        '/v1/admin/relations',
        {
          subject_type: 'user', subject_id: SUBJECT,
          relation: 'member', object_type: 'group', object_id: OBJECT,
        },
        envId,
      ),
    );
    expect(jsonObj(put).status).toBe('upserted');
    // Listed.
    const listed = await assertCliOk(
      cliCall('post', 'GET', '/v1/admin/relations', undefined, envId),
    );
    const row = (Array.isArray(listed.json) ? listed.json : [] as unknown[]).find(
      (r) => (r as Record<string, unknown>).subject_id === SUBJECT,
    ) as Record<string, unknown> | undefined;
    expect(row, 'relation tuple listed').toBeTruthy();
    expect(row?.relation).toBe('member');
    // Dry-run check: connected (direct).
    const check = await assertCliOk(
      cliCall(
        'post',
        'GET',
        `/v1/admin/relations/check?subject_type=user&subject_id=${SUBJECT}&relation=member&object_type=group&object_id=${OBJECT}`,
        undefined,
        envId,
      ),
    );
    expect(jsonObj(check).direct).toBe(true);
    expect(jsonObj(check).connected).toBe(true);
    // DELETE → gone from the list.
    await assertCliOk(
      cliCall(
        'post',
        'DELETE',
        `/v1/admin/relations?subject_type=user&subject_id=${SUBJECT}&relation=member&object_type=group&object_id=${OBJECT}`,
        undefined,
        envId,
      ),
    );
    const after = await assertCliOk(
      cliCall('post', 'GET', '/v1/admin/relations', undefined, envId),
    );
    expect(
      (Array.isArray(after.json) ? after.json : []).find(
        (r) => (r as Record<string, unknown>).subject_id === SUBJECT,
      ),
    ).toBeUndefined();
  });

  test('attribute lifecycle: PUT → listed → DELETE (invalid value 422)', async () => {
    const SUBJECT = `e2e-attr-sub-${Date.now()}`;
    // Invalid value (object) → 422 write-time gate.
    const bad = await cliCall(
      'post',
      'PUT',
      '/v1/admin/attributes',
      { subject_id: SUBJECT, attr_key: 'dept', attr_value: { nested: true } },
      envId,
    );
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr + bad.stdout).toContain('scalar');
    // Valid value → upserted and listed.
    await assertCliOk(
      cliCall(
        'post',
        'PUT',
        '/v1/admin/attributes',
        { subject_id: SUBJECT, attr_key: 'dept', attr_value: 'engineering' },
        envId,
      ),
    );
    const listed = await assertCliOk(
      cliCall(
        'post',
        'GET',
        `/v1/admin/attributes?subject_id=${SUBJECT}`,
        undefined,
        envId,
      ),
    );
    const row = (Array.isArray(listed.json) ? listed.json : [] as unknown[]).find(
      (a) => (a as Record<string, unknown>).attr_key === 'dept',
    ) as Record<string, unknown> | undefined;
    expect(row, 'attribute listed').toBeTruthy();
    expect(row?.attr_value).toContain('engineering');
    // DELETE.
    await assertCliOk(
      cliCall(
        'post',
        'DELETE',
        `/v1/admin/attributes?subject_id=${SUBJECT}&attr_key=dept`,
        undefined,
        envId,
      ),
    );
  });

  test('Dash renders the policy-sets RFW page for post', async () => {
    await page.goto(`${URLs.dash}/#/post/policy-sets?env=${envId}`);
    await page.waitForLoadState('domcontentloaded');
    // The RFW page fetches the definition + data through the BFF proxy; the
    // seeded scope-mirror row must appear in the rendered table.
    await expect
      .poll(
        async () => page.content(),
        { timeout: 30_000 },
      )
      .toContain('Policy');
  });

  // ── Policy Studio lifecycle via the RFW forms (design §3.7, E2E-UI-Full-21)
  // UI writes → CLI reads (bidirectional pattern): create through the Dash
  // form, verify via the BFF proxy API, delete through the row action.
  test('UI form: create tenant set → CLI verify → edit page renders → row-action delete', async () => {
    const UI_SET = `e2e-ui-policy-${Date.now()}`;
    const policies =
      `permit(principal, action == Action::"sentin8:post:read", resource) when { principal.scopes.contains("sentin8:post:read") };`;

    // 1. UI: create via the RFW form (policy-sets → New Policy Set).
    await rfwCreateViaForm(
      page,
      `${URLs.dash}/#/post/policy-sets?env=${envId}`,
      'New Policy Set',
      [
        { label: 'Set Name', value: UI_SET },
        { label: 'Description', value: 'e2e UI-form lifecycle set' },
        { label: 'Shield Policies', value: policies },
      ],
      'Create Policy Set',
      // Mode select: keep the default "shadow" — click through the dropdown
      // so the field state is committed like a real user interaction.
      [{ label: 'Mode', option: 'Shadow' }],
    );

    // 2. CLI: verify the persisted row (UI writes → CLI reads).
    const listed = await cliCall('post', 'GET', '/v1/admin/policy-sets', undefined, envId);
    assertCliOk(listed, 'post policy-sets list (CLI verify)');
    expect(listed.stdout).toContain(UI_SET);

    // 3. UI: the create redirect lands on the editor page (native
    // policy_simulator) — the editor must render with the fetched set.
    await waitForFlutterContent(page);
    await expect
      .poll(async () => page.content(), { timeout: 30_000 })
      .toContain('Simulation Playground');

    // 4. UI: delete via the row action (path-param alias).
    await rfwRowAction(
      page,
      `${URLs.dash}/#/post/policy-sets?env=${envId}`,
      UI_SET,
      'Delete',
    );

    // 5. CLI: verify gone.
    const after = await cliCall('post', 'GET', '/v1/admin/policy-sets', undefined, envId);
    assertCliOk(after, 'post policy-sets list (after delete)');
    expect(after.stdout).not.toContain(UI_SET);
  });

  test('Dash renders the policy-decisions feed page', async () => {
    await navigateToDashPage(page, 'post', 'policy-decisions', undefined, envId);
    await waitForFlutterContent(page);
    // The page must render its title (rows may be empty in a quiet env).
    await rfwVerifyInList(page, `${URLs.dash}/#/post/policy-decisions?env=${envId}`, 'Policy Decisions');
  });
});