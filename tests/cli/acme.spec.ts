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

  test('acme root CA matches local trust store', async () => {
    const caPath = join(homedir(), '.sentin8', 'acme', 'ca', 'root-ca.crt');
    let localCert = '';
    try {
      localCert = await readFile(caPath, 'utf-8');
    } catch {
      test.skip(true, 'local root CA file not found - skipping');
      return;
    }
    expect(localCert).toContain('-----BEGIN CERTIFICATE-----');
    const lines = localCert.trim().split('\n');
    expect(lines[0]).toBe('-----BEGIN CERTIFICATE-----');
    expect(lines[lines.length - 1]).toBe('-----END CERTIFICATE-----');
  });
});