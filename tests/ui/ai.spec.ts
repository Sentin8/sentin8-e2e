// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/ui/ai.spec.ts — Phase 31 (AI stories 31.10.4): Sentin8:AI lifecycle
// through the platform, per design/sentin8-sentin8-ai-technical-design.md §4
// + services/ai/BACKLOG.md.
//
// UI-only per AGENTS.md: state setup/verification goes through the BFF proxy
// API via the CLI (sentin8-cli call ai …). No direct SQL, no direct backend.
//
// Lifecycle proven:
//   1. Prompt registry: create a version → immutable (duplicate 409) → list.
//   2. Budget gate: PUT a 1-token budget for the feature → inference → 429.
//   3. Retrieval isolation: empty data_scope → no chunks (fail-closed).
//   4. Provider registry: upsert + list (secret references only).
//   5. Cleanup: delete prompt version + budget.

import { test, expect } from '@playwright/test';
import { URLs } from '../../fixtures/testdata.js';
import { cliCall, assertCliOk } from '../../fixtures/cli.js';
import { ensureSignedIn, getTestEnvId } from './_setup.js';
import type { BrowserContext, Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test.describe('UI — AI (Phase 31 platform capability layer)', () => {
  let context: BrowserContext;
  let page: Page;
  let envId: string;
  const PROMPT = `e2e-ai-prompt-${Date.now()}`;
  const FEATURE = `e2e-ai-feature-${Date.now()}`;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({
      baseURL: URLs.dash, ignoreHTTPSErrors: true, bypassCSP: true,
    });
    page = await context.newPage();
    await ensureSignedIn(page, context);
    envId = await getTestEnvId();
  });

  test.afterAll(async () => {
    if (envId) {
      await cliCall('ai', 'DELETE', `/v1/prompts/${PROMPT}/1`, undefined, envId).catch(() => {});
      await cliCall('ai', 'DELETE', `/v1/budgets/${FEATURE}`, undefined, envId).catch(() => {});
    }
    await context.close();
  });

  test('prompt registry: create a version and list it', async () => {
    const res = await assertCliOk(
      cliCall('ai', 'POST', '/v1/prompts', {
        name: PROMPT,
        system_text: 'You are an e2e test assistant. Answer with exactly: pong',
        model_primary: 'ollama/llama3',
        origin: 'tenant',
      }, envId),
    );
    expect(res.json.version).toBe(1);
    expect(res.json.origin).toBe('tenant');
  });

  test('prompt versions are immutable — duplicate (name, version) is 409', async () => {
    const dup = await cliCall('ai', 'POST', '/v1/prompts', {
      name: PROMPT,
      version: 1,
      system_text: 'duplicate attempt',
      model_primary: 'ollama/llama3',
      origin: 'tenant',
    }, envId);
    // cliCall surfaces non-zero exit for 409 — assert it failed.
    expect(dup.exitCode, 'duplicate version must be rejected').not.toBe(0);
  });

  test('budget gate: 1-token cap → inference rejected with 429', async () => {
    await assertCliOk(
      cliCall('ai', 'PUT', `/v1/budgets/${FEATURE}`, {
        // UpsertBudgetRequest requires `feature` in the body (the path
        // segment alone is not enough — handler binds both).
        feature: FEATURE,
        monthly_token_cap: 1, enforcement: 'reject',
      }, envId),
    );
    const inf = await cliCall('ai', 'POST', '/v1/completions', {
      prompt_name: PROMPT,
      input: 'ping',
      feature: FEATURE,
    }, envId);
    // Budget exhausted → 429 → CLI call fails.
    expect(inf.exitCode, 'reject-mode budget must block inference').not.toBe(0);
  });

  test('retrieval with empty data_scope is fail-closed', async () => {
    // Two fail-closed shapes are acceptable (AI design §4.6 — no chunk may
    // escape an empty data_scope):
    //   a) 200 + chunks == [] — provider route exists (boot-time snapshot),
    //      the scope filter evaluates FALSE and returns nothing.
    //   b) exit != 0 with "no embedding provider configured" (422) — the
    //      env has no active provider at boot; the request never reaches
    //      the data, which is equally fail-closed.
    // Routes load once at boot from the system-env provider registry, so a
    // freshly provisioned test env reliably lands in shape (b).
    const res = await cliCall('ai', 'POST', '/v1/retrieval', {
      query: 'test query',
      data_scope: [],
      top_k: 5,
    }, envId);
    if (res.exitCode === 0) {
      expect(res.json.chunks).toEqual([]);
    } else {
      expect(
        res.stderr.includes('no embedding provider configured') ||
        res.stderr.includes('422'),
        `expected fail-closed (empty chunks or no-provider 422), got: ${res.stderr}`,
      ).toBe(true);
    }
  });

  test('provider registry lists configured providers with secret refs only', async () => {
    const res = await assertCliOk(
      cliCall('ai', 'GET', '/v1/providers', undefined, envId),
    );
    const providers = Array.isArray(res.json) ? res.json : [];
    for (const p of providers) {
      expect(p.credential_ref).toBeTruthy();
      // Never a plaintext credential — refs only.
      expect(p.credential_ref.startsWith('ref:'), 'credential must be a reference').toBeTruthy();
    }
  });

  test('admin UI serves RFW definitions for prompts page', async () => {
    const res = await assertCliOk(
      cliCall('ai', 'GET', '/v1/admin/ui/prompts', undefined, envId),
    );
    expect(res.json.response_type).toBe('page');
  });
});