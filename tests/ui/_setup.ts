// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/ui/_setup.ts - shared setup for Dash UI suites.
//
// The global setup (global-setup.ts) runs ONCE before all test files:
// signs in, creates org + env, saves browser storage state.
// This file reads the org/env IDs from the saved meta file.
// Each test file creates its own browser context but reuses the
// storage state (cookies) - no sign-in needed.

// Allow self-signed certs for local dev.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { type Page, type BrowserContext } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { URLs } from '../../fixtures/testdata.js';
import { waitForFlutterSemantics, waitForFlutterContent, navigateViaSidebar, clickFlutterButton, waitForFlutterText } from '../../fixtures/harness.js';

let _orgId = '';
let _envId = '';
let _email = '';
let _loaded = false;

/** Read org/env IDs from the global setup meta file. */
function loadMeta(): void {
  if (_loaded) return;
  _loaded = true;
  const metaPath = join(process.cwd(), '.tmp', 'test-meta.json');
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    _orgId = meta.orgId;
    _envId = meta.envId;
    _email = meta.email;
  }
}

/** Ensure the CLI is signed in (idempotent - skips if already done). */
let _cliSignedIn = false;
export async function ensureSignedIn(
  _page: Page,
  _context: BrowserContext,
): Promise<void> {
  loadMeta();
  if (!_cliSignedIn) {
    // Use the email from the meta file (same as global setup).
    const { cliSignIn } = await import('../../fixtures/cli.js');
    await cliSignIn(_email || undefined, undefined);
    _cliSignedIn = true;
  }
}

/** Get the test org ID created during global setup. */
export function getTestOrgId(): string {
  loadMeta();
  return _orgId;
}

/** Get the test env ID created during global setup. */
export function getTestEnvId(): string {
  loadMeta();
  return _envId;
}

/** Navigate to a Dash RFW page via the sidebar (like a human user).
 *  Uses navigateViaSidebar to click through the sidebar menu instead of
 *  navigating directly via URL. Falls back to direct URL if sidebar
 *  navigation fails (e.g. on first load when sidebar isn't ready).
 */
export async function navigateToDashPage(
  page: Page,
  service: string,
  route: string,
  _orgId?: string,
  envId?: string,
): Promise<void> {
  // Build the sidebar path: service label → route segments.
  // Sidebar labels are like "Sentin8:Auth", "Bank8:Ledger", "Hotel8:PMS".
  // Map the service identity to the sidebar label the user sees. Keys use
  // the colon identity (architecture-principles.md §6.0) and its legacy
  // hyphen alias.
  const serviceLabelMap: Record<string, string> = {
    'sentin8:auth': 'Auth', 'sentin8:bus': 'Bus', 'sentin8:cron': 'Cron',
    'sentin8:db': 'DB', 'sentin8:flow': 'Flow', 'sentin8:func': 'Func',
    'sentin8:post': 'Post', 'sentin8:stat': 'Stat', 'sentin8:storage': 'Storage',
    'sentin8:sys': 'System', 'sentin8:app': 'App', 'sentin8:acme': 'Acme',
    'bank8:ledger': 'Ledger', 'bank8:fdx': 'FDX', 'bank8:payments': 'Payments',
    'hotel8:pms': 'PMS', 'hotel8:pos': 'POS', 'hotel8:loyalty': 'Loyalty',
    'hotel8:meta': 'Meta', 'hotel8:distrib': 'Distrib', 'hotel8:upsell': 'Upsell',
    // Legacy hyphen aliases
    'sentin8-auth': 'Auth', 'sentin8-bus': 'Bus', 'sentin8-cron': 'Cron',
    'sentin8-db': 'DB', 'sentin8-flow': 'Flow', 'sentin8-func': 'Func',
    'sentin8-post': 'Post', 'sentin8-stat': 'Stat', 'sentin8-storage': 'Storage',
    'sentin8-sys': 'System', 'sentin8-app': 'App', 'sentin8-acme': 'Acme',
    'bank8-ledger': 'Ledger', 'bank8-fdx': 'FDX', 'bank8-payments': 'Payments',
    'hotel8-pms': 'PMS', 'hotel8-pos': 'POS', 'hotel8-loyalty': 'Loyalty',
    'hotel8-meta': 'Meta', 'hotel8-distrib': 'Distrib', 'hotel8-upsell': 'Upsell',
    // Short forms (fallback)
    'auth': 'Auth', 'bus': 'Bus', 'cron': 'Cron', 'db': 'DB',
    'flow': 'Flow', 'func': 'Func', 'post': 'Post', 'stat': 'Stat',
    'storage': 'Storage', 'sys': 'System', 'app': 'App', 'acme': 'Acme',
  };
  const serviceLabel = serviceLabelMap[service] ?? service.replace(/^sentin8[:-]/, '').replace(/^bank8[:-]/, '').replace(/^hotel8[:-]/, '');
  const routeParts = route.split('/').filter((s) => s.length > 0);

  // Sys routes map to top-level sidebar items, not under a "System" parent.
  // e.g. sys/home → Organization, sys/settings → Settings, sys/audit → Audit.
  const sysRouteMap: Record<string, string[]> = {
    'home': ['Organization'],
    'settings': ['Settings'],
    'audit': ['Audit'],
    'branding': ['Branding'],
  };

  let sidebarPath: string[];
  if (service === 'sys' && sysRouteMap[route]) {
    sidebarPath = sysRouteMap[route];
  } else {
    sidebarPath = [serviceLabel, ...routeParts.map((p) => {
      if (p === 'overview') return 'Overview';
      return p.charAt(0).toUpperCase() + p.slice(1);
    })];
    // When the service label equals the leaf label (e.g. sentin8-secrets
    // service label "Secrets" + page route "secrets" → leaf "Secrets") the
    // leaf click resolves to the FIRST matching button - the service parent
    // - which navigates to the service's first page (overview), not the
    // requested page. Route such collisions through the direct-URL fallback
    // below instead of the sidebar.
    if (
      sidebarPath.length >= 2 &&
      sidebarPath[0].toLowerCase() === sidebarPath[1].toLowerCase()
    ) {
      sidebarPath = [];
    }
  }
  if (sidebarPath.length === 0) {
    throw new Error('sidebar-path collision - use direct URL navigation');
  }

  try {
    // Navigate via sidebar - the human way.
    await navigateViaSidebar(page, sidebarPath);
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
  } catch {
    // Fallback: direct URL navigation if sidebar isn't available.
    // Sys native pages (home/settings/audit/branding) live at TOP-LEVEL
    // hash paths (#/audit, not #/sys/audit - the dash main.dart treats
    // single-segment routes as native pages; #/sys/audit falls into the
    // RFW catch-all where sys has no admin UI and 404s).
    const params = new URLSearchParams();
    if (envId) params.set('env', envId);
    const query = params.toString();
    const hashPath = service === 'sys' && sysRouteMap[route]
      ? `/${route}`
      : `/${service}/${route}`;
    const url = `${URLs.dash}/#${hashPath}${query ? `?${query}` : ''}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForFlutterSemantics(page, 10_000);
    await waitForFlutterContent(page);
  }
}