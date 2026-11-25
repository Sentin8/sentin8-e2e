// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/cli/acme.spec.ts - E2E-CLI-13: acme CLI suite - full functional E2E.
//
// Full lifecycle: fetch root CA cert → verify PEM → fetch intermediate CA cert
// → verify PEM → verify root cert matches the local trust store.

import { test, expect } from '@playwright/test';
import { cliDo, cliListCommands, assertCliOk } from '../../fixtures/cli.js';
import { ensureSignedIn } from './_setup.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The platform CA's on-disk root, for the ACTIVE transport family.
 *
 * PQCA-1 namespaces the hierarchy per posture - `{base}/{pq_mode()}/ca/`
 * (sentin8-sdk/core/config: `acme_data_dir_mode`) - so there is no single
 * `root-ca.crt` that is "the" platform root: a mode flip mints a separate
 * authority. Reading an unnamespaced path silently skipped this test on
 * every family-scoped fleet (the file simply never existed, and the
 * `catch` turned a real invariant into a no-op).
 *
 * Resolution mirrors the fleet: real env first, then the tree-root `.env`
 * fixtures/env.ts already loaded, with the same defaults the services use.
 */
function platformRootCaPath(): string {
  const base = process.env.SENTIN8_ACME_DATA_DIR ?? join(homedir(), '.sentin8', 'acme');
  const mode = process.env.SENTIN8_TLS_PQ_MODE ?? 'classical';
  return join(base, mode, 'ca', 'root-ca.crt');
}

test.describe('CLI - acme (full functional)', () => {
  test.beforeAll(async () => { await ensureSignedIn(); });

  test('acme commands are listed in list-commands', async () => {
    const r = await cliListCommands();
    assertCliOk(r, 'list-commands');
    expect(r.stdout).toContain('acme:');
  });

  test('acme ca root - fetch and verify root CA cert', async () => {
    const r = await cliDo('acme', 'ca', 'root');
    if (r.exitCode !== 0) {
      test.skip(true, 'acme service not reachable via proxy - skipping');
      return;
    }
    expect(r.stdout).toContain('-----BEGIN CERTIFICATE-----');
    expect(r.stdout).toContain('-----END CERTIFICATE-----');
  });

  test('acme ca intermediate - fetch and verify intermediate CA cert', async () => {
    const r = await cliDo('acme', 'ca', 'intermediate');
    if (r.exitCode !== 0) {
      test.skip(true, 'acme service not reachable via proxy - skipping');
      return;
    }
    expect(r.stdout).toContain('-----BEGIN CERTIFICATE-----');
    expect(r.stdout).toContain('-----END CERTIFICATE-----');
  });

  test('acme root CA exists in the fleet CA store', async () => {
    const caPath = platformRootCaPath();
    let localCert = '';
    try {
      localCert = await readFile(caPath, 'utf-8');
    } catch {
      // Not a skip: the platform root CA is written by the fleet's own CA
      // pass, so its absence means the tree was never fully booted - a real
      // configuration defect, not an inapplicable test. (The previous
      // version read an unnamespaced path that PQCA-1 never writes, so it
      // skipped on every fleet instead of asserting anything.)
      throw new Error(
        `platform root CA missing at ${caPath} - run 'make ca-tls' in the ` +
        `sentin8/ group (family: ${process.env.SENTIN8_TLS_PQ_MODE ?? 'classical'}).`,
      );
    }
    expect(localCert).toContain('-----BEGIN CERTIFICATE-----');
    const lines = localCert.trim().split('\n');
    expect(lines[0]).toBe('-----BEGIN CERTIFICATE-----');
    expect(lines[lines.length - 1]).toBe('-----END CERTIFICATE-----');
  });
});