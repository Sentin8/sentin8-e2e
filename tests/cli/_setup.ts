// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/cli/_setup.ts - shared setup for CLI suites.
//
// Signs in the CLI once (headless device-flow or direct token write),
// then all suites reuse the stored credentials. This runs as a
// beforeAll in the first test of each suite file.

import { cliSignIn, cliWhoami, cliListCommands, assertCliOk, runCli } from '../../fixtures/cli.js';
import { resetState } from '../../fixtures/state.js';

let _signedIn = false;

/** System env (ops) - matches Sentin8Config's own fallback for platform-scoped commands. */
const SYS_ENV = '00000000-0000-0000-0000-000000000002';

/**
 * Ensure the CLI is signed in before any CLI suite runs.
 * Also pins `default_env_id` to the system env: admin endpoints
 * (`/v1/admin/...`) reject calls without `--env` when no default env
 * is configured, and the bidirectional suites call them bare.
 *
 * The CLI's M2M workload grant rows (`cli-producer` etc.) are NOT seeded
 * here - they are declarative enrollment data (`sentin8-cli
 * --print-registration --section=m2m_grants`, upserted by
 * `vertical enroll ../sentin8-cli`). Direct database access in fixtures is
 * banned by the suite's defining constraint (DESIGN.md §1) and the platform
 * DB has been certificate-identity-only since PGMTLS-1 (a password DSN
 * cannot connect at all - the 2026-10-29 bidirectional-suite break).
 */
export async function ensureSignedIn(): Promise<void> {
  if (_signedIn) return;
  await resetState();
  await cliSignIn();
  // Pin the default env once (idempotent - no-op if already set).
  const cfg = await runCli(['config', 'get', 'default_env_id']);
  if (!cfg.stdout.includes(SYS_ENV)) {
    await runCli(['config', 'set', 'default_env_id', SYS_ENV]);
  }
  _signedIn = true;
}

/** Verify the CLI is authenticated and commands are available. */
export async function verifyCliReady(): Promise<void> {
  await ensureSignedIn();

  // whoami should succeed
  const who = await cliWhoami();
  await assertCliOk(who, 'whoami');

  // list-commands should include the sentin8 platform commands
  const list = await cliListCommands();
  await assertCliOk(list, 'list-commands');
}