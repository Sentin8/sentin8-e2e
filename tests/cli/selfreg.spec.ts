// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/cli/selfreg.spec.ts - Service self-registration via --print-registration.
//
// SELFREG-18: Verify that `--print-registration` produces correct output
// for all services, and that `vertical enroll` with `--print-registration`
// produces the same DB state as the old JSON-based enrollment.

import { test, expect } from '@playwright/test';
import { execSync, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename_url = fileURLToPath(import.meta.url);
const __dirname_local = path.dirname(__filename_url);
const SENTRY8_ROOT = path.resolve(__dirname_local, '../../../..');
const SENTIN8_TARGET = path.join(SENTRY8_ROOT, 'sentin8', 'target', 'release');
const BANK8_TARGET = path.join(SENTRY8_ROOT, 'bank8', 'target', 'release');
const HOTEL8_TARGET = path.join(SENTRY8_ROOT, 'hotel8', 'target', 'release');

/** Run a service binary with --print-registration --section=<section> and parse JSON. */
function printRegistration(binary: string, section: string | null): any {
  const args = ['--print-registration'];
  if (section) args.push(`--section=${section}`);
  const output = execFileSync(binary, args, {
    encoding: 'utf-8',
    timeout: 10000,
    cwd: SENTRY8_ROOT,
  });
  return JSON.parse(output);
}

// ── Section: service ──────────────────────────────────────────────────

test.describe('SELFREG: --print-registration --section=service', () => {
  const platformServices = [
    { name: 'sentin8:stat', binary: 'sentin8/sentin8-stat/target/release/sentin8-stat' },
    { name: 'sentin8:auth', binary: 'sentin8/sentin8-auth/target/release/sentin8-auth' },
    { name: 'sentin8:sys', binary: 'sentin8/sentin8-sys/target/release/sentin8-sys' },
    { name: 'sentin8:db', binary: 'sentin8/sentin8-db/target/release/sentin8-db' },
    { name: 'sentin8:storage', binary: 'sentin8/sentin8-storage/target/release/sentin8-storage' },
    { name: 'sentin8:cron', binary: 'sentin8/sentin8-cron/target/release/sentin8-cron' },
    { name: 'sentin8:flow', binary: 'sentin8/sentin8-flow/target/release/sentin8-flow' },
    { name: 'sentin8:func', binary: 'sentin8/sentin8-func/target/release/sentin8-func' },
    { name: 'sentin8:bus', binary: 'sentin8/sentin8-bus/target/release/sentin8-bus' },
    { name: 'sentin8:post', binary: 'sentin8/sentin8-post/target/release/sentin8-post' },
    { name: 'sentin8:acme', binary: 'sentin8/sentin8-acme/target/release/sentin8-acme' },
  ];

  for (const svc of platformServices) {
    test(`${svc.name} --section=service returns service_type`, () => {
      const binaryPath = path.join(SENTRY8_ROOT, svc.binary);
      if (!fs.existsSync(binaryPath)) {
        test.skip(true, `${svc.binary} not built - run \`make build-rust\``);
        return;
      }
      const result = printRegistration(binaryPath, 'service');
      expect(result.service_type).toBe(svc.name);
      expect(result.health_path).toBe('/v1/health');
      expect(result.openapi_url).toBe('/openapi.json');
      expect(result.subdomain).toBeTruthy();
    });
  }
});

// ── Section: openapi ──────────────────────────────────────────────────

test.describe('SELFREG: --print-registration --section=openapi', () => {
  test('sentin8-stat --section=openapi has paths', () => {
    const binaryPath = path.join(SENTRY8_ROOT, 'sentin8/sentin8-stat/target/release/sentin8-stat');
    if (!fs.existsSync(binaryPath)) {
      test.skip(true, 'binary not built');
      return;
    }
    const spec = printRegistration(binaryPath, 'openapi');
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths || {}).length).toBeGreaterThan(0);
  });

  test('bank8-ledger --section=openapi has paths', () => {
    const binaryPath = path.join(SENTRY8_ROOT, 'bank8/bank8-ledger/target/release/bank8-ledger');
    if (!fs.existsSync(binaryPath)) {
      test.skip(true, 'binary not built');
      return;
    }
    const spec = printRegistration(binaryPath, 'openapi');
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths || {}).length).toBeGreaterThan(0);
  });
});

// ── Section: sql ──────────────────────────────────────────────────────

test.describe('SELFREG: --print-registration --section=sql', () => {
  test('sentin8-stat --section=sql has migrations', () => {
    const binaryPath = path.join(SENTRY8_ROOT, 'sentin8/sentin8-stat/target/release/sentin8-stat');
    if (!fs.existsSync(binaryPath)) {
      test.skip(true, 'binary not built');
      return;
    }
    const migrations = printRegistration(binaryPath, 'sql');
    expect(Array.isArray(migrations)).toBe(true);
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0].version).toBe(1);
    expect(migrations[0].sql.length).toBeGreaterThan(100);
  });
});

// ── Section: admin_scopes ─────────────────────────────────────────────

test.describe('SELFREG: --print-registration --section=admin_scopes', () => {
  test('bank8-ledger has admin scopes', () => {
    const binaryPath = path.join(SENTRY8_ROOT, 'bank8/bank8-ledger/target/release/bank8-ledger');
    if (!fs.existsSync(binaryPath)) {
      test.skip(true, 'binary not built');
      return;
    }
    const scopes = printRegistration(binaryPath, 'admin_scopes');
    expect(Array.isArray(scopes)).toBe(true);
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes[0].role).toContain('bank8:ledger');
    expect(scopes[0].scope).toContain('bank8:ledger');
  });
});

// ── Section: audit_findings + service_actions ─────────────────────────

test.describe('SELFREG: --print-registration --section=audit_findings', () => {
  test('bank8-fdx has audit findings', () => {
    const binaryPath = path.join(SENTRY8_ROOT, 'bank8/bank8-fdx/target/release/bank8-fdx');
    if (!fs.existsSync(binaryPath)) {
      test.skip(true, 'binary not built');
      return;
    }
    const findings = printRegistration(binaryPath, 'audit_findings');
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].finding).toBeTruthy();
    expect(findings[0].recommendation).toBeTruthy();
  });

  test('sentin8-stat has empty audit findings', () => {
    const binaryPath = path.join(SENTRY8_ROOT, 'sentin8/sentin8-stat/target/release/sentin8-stat');
    if (!fs.existsSync(binaryPath)) {
      test.skip(true, 'binary not built');
      return;
    }
    const findings = printRegistration(binaryPath, 'audit_findings');
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBe(0);
  });
});

test.describe('SELFREG: --print-registration --section=service_actions', () => {
  test('bank8-fdx has service actions', () => {
    const binaryPath = path.join(SENTRY8_ROOT, 'bank8/bank8-fdx/target/release/bank8-fdx');
    if (!fs.existsSync(binaryPath)) {
      test.skip(true, 'binary not built');
      return;
    }
    const actions = printRegistration(binaryPath, 'service_actions');
    expect(Array.isArray(actions)).toBe(true);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].action).toBe('fdx_consent_start');
    expect(actions[0].endpoint).toBe('/v1/recipient/consents/start');
  });

  test('sentin8-stat has empty service actions', () => {
    const binaryPath = path.join(SENTRY8_ROOT, 'sentin8/sentin8-stat/target/release/sentin8-stat');
    if (!fs.existsSync(binaryPath)) {
      test.skip(true, 'binary not built');
      return;
    }
    const actions = printRegistration(binaryPath, 'service_actions');
    expect(Array.isArray(actions)).toBe(true);
    expect(actions.length).toBe(0);
  });
});

// ── Full output (no section) ─────────────────────────────────────────

test.describe('SELFREG: --print-registration (full output)', () => {
  test('sentin8-stat full output includes all sections', () => {
    const binaryPath = path.join(SENTRY8_ROOT, 'sentin8/sentin8-stat/target/release/sentin8-stat');
    if (!fs.existsSync(binaryPath)) {
      test.skip(true, 'binary not built');
      return;
    }
    const reg = printRegistration(binaryPath, null);
    expect(reg.service_type).toBe('sentin8:stat');
    expect(reg.subdomain).toBe('stat');
    expect(reg.health_path).toBe('/v1/health');
    expect(reg.openapi_url).toBe('/openapi.json');
    expect(reg.admin_ui).toBeTruthy();
    expect(reg.admin_ui.pages).toBeTruthy();
    expect(reg.sql_migrations).toBeTruthy();
    expect(reg.openapi_spec).toBeTruthy();
    expect(reg.openapi_spec.openapi).toBe('3.1.0');
  });
});

// ─-- Unknown section ──────────────────────────────────────────────────

test.describe('SELFREG: --print-registration error handling', () => {
  test('unknown section returns error', () => {
    const binaryPath = path.join(SENTRY8_ROOT, 'sentin8/sentin8-stat/target/release/sentin8-stat');
    if (!fs.existsSync(binaryPath)) {
      test.skip(true, 'binary not built');
      return;
    }
    expect(() => {
      execFileSync(binaryPath, ['--print-registration', '--section=bogus'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
    }).toThrow();
  });
});