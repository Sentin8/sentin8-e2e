// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// ── sentin8 platform e2e - Playwright TypeScript configuration ───────────
//
// Covers the Sentin8 platform admin surfaces:
//   tests/cli/  - sentin8-cli subprocess suites (no browser)
//   tests/ui/   - Dash RFW page suites (browser, future)

import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
// The shared loader resolves SENTIN8_DOMAIN from the tree-root `.env`
// (no hardcoded fallback) - the same source the fleet boots from.
import { platformDomain } from './fixtures/env.js';

const STORAGE_STATE_PATH = join(process.cwd(), '.tmp', 'storage-state.json');

const DOMAIN = platformDomain();
const MAX_FAILURES = Number.parseInt(process.env.PLAYWRIGHT_MAX_FAILURES ?? '1', 10);
// Headed mode: default to headed (visible browser) so failures are visible.
// Override with PLAYWRIGHT_HEADLESS=true for CI.
const HEADLESS = (process.env.PLAYWRIGHT_HEADLESS ?? 'false') === 'true';
const WORKERS = Number.parseInt(process.env.PLAYWRIGHT_WORKERS ?? '1', 10);

export default defineConfig({
  testDir: './tests',
  maxFailures: MAX_FAILURES,
  fullyParallel: false,
  workers: WORKERS,
  retries: 0,
  timeout: 120_000,

  // Global setup - runs ONCE before all tests.
  // Signs in, creates org + env, saves browser storage state.
  globalSetup: './tests/ui/global-setup',
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
  ],
  use: {
    baseURL: `https://dash.ops.sys.${DOMAIN}`,
    headless: HEADLESS,
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
    ignoreHTTPSErrors: true,
    bypassCSP: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Reuse the storage state from global setup (cookies + localStorage).
    storageState: STORAGE_STATE_PATH,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--ignore-certificate-errors',
            '--disable-features=DnsOverHttps',
            '--enable-features=WebContentsForceDark',
            '--force-prefers-color-scheme=dark',
          ],
        },
      },
    },
  ],
  outputDir: 'test-results',
});
