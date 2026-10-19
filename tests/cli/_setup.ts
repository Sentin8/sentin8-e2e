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
 * Provision the CLI's event-producer M2M workload (bus DESIGN §4.3
 * CLI-producer path): the VDC-2 gate is M2M-only - produce carries the
 * workload's `vertical` claim (stamped from the `auth.m2m_scope_grants`
 * row at token mint) and rejects the operator's USER token (no claim).
 * The row is the same declarative shape every service's `m2m_grants`
 * produces; the DCR scope gate requires it before the workload registers.
 * Idempotent upsert, seeded via the operator DSN - the SAME fixture
 * discipline as the Rust test harness (superuser DSN for SEEDING, never
 * for what the test exercises).
 */
async function seedCliProducerGrant(): Promise<void> {
  const pg = await import('pg');
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL || 'postgres://sentin8:sentin8@localhost:5432/sentin8',
  });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO auth.m2m_scope_grants (service_name, allowed_scopes, vertical, service_type)
       VALUES ('cli-producer', '{sentin8:bus:produce}', 'sentin8', 'sentin8:cli')
       ON CONFLICT (service_name) DO UPDATE SET
         allowed_scopes = EXCLUDED.allowed_scopes,
         vertical = EXCLUDED.vertical,
         service_type = EXCLUDED.service_type`,
    );
  } finally {
    await client.end();
  }
}

/**
 * Ensure the CLI is signed in before any CLI suite runs.
 * Also pins `default_env_id` to the system env: admin endpoints
 * (`/v1/admin/...`) reject calls without `--env` when no default env
 * is configured, and the bidirectional suites call them bare.
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
  // The producer workload grant must exist before any bus produce test
  // (the CLI's gate-triggered fallback DCRs 'cli-producer', which the
  // DCR scope gate rejects without the row).
  await seedCliProducerGrant();
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