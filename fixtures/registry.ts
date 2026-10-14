// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/registry.ts — load admin_ui + cli_commands from sentin8/vertical-registry.json.
//
// Story E2E-UI-2: Registry-driven test generation. The suites load the
// admin_ui and cli_commands arrays at runtime and assert every declared
// page/command is exercised. A coverage guard fails on any untested
// surface — making the matrix self-enforcing.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { treeRoot } from './env.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface AdminUiPage {
  service: string;
  route: string;
  label: string;
  ui_endpoint: string;
  data_endpoint: string;
}

export interface CliArg {
  name: string;
  kind: 'path' | 'field' | 'query' | 'flag';
  required: boolean;
  secret: boolean;
  position: string | null;
}

export interface CliCommand {
  command: string;
  subcommand: string;
  action: string;
  method: string;
  path: string;
  scope: string;
  args: CliArg[];
}

interface RegistryData {
  admin_ui?: Array<{
    service: string;
    label: string;
    icon: string;
    service_flag: string;
    pages: Array<{
      route: string;
      label: string;
      ui_endpoint: string;
      data_endpoint: string;
      icon: string;
    }>;
  }>;
  cli_commands?: CliCommand[];
}

// ── Loader ─────────────────────────────────────────────────────────────

let _registry: RegistryData | undefined;

const EMPTY_REGISTRY: RegistryData = {
  admin_ui: [],
  cli_commands: [],
};

async function loadRegistry(): Promise<RegistryData> {
  if (_registry) return _registry;
  // The registry mirror lives in the sentin8/ group repo — resolved from
  // the tree root (SENTIN8_REPO_ROOT override → tree-root resolution in
  // fixtures/env.ts), never a hardcoded absolute path (defect class:
  // /home/<user> literals — RS-13).
  const registryPath = join(
    process.env.SENTIN8_REPO_ROOT ?? treeRoot(),
    'sentin8',
    'vertical-registry.json',
  );
  // OPTIONAL mirror: the authoritative command/audit surface is the DB
  // registry `vertical enroll` populates (cli DESIGN §…, e2e DESIGN §4);
  // this file was a monorepo-era convenience that carried ZERO
  // cli_commands even there — every historical run's device-flow token
  // rode the four base OIDC scopes. Abstaining (empty registry, the
  // exact historical behavior) must never abort the run — and it MUST
  // NOT fall back to a guessed path (invariant: derived, never guessed).
  if (!existsSync(registryPath)) {
    _registry = EMPTY_REGISTRY;
    return _registry;
  }
  const raw = await readFile(registryPath, 'utf-8');
  _registry = JSON.parse(raw) as RegistryData;
  return _registry;
}

/** Load all admin_ui pages from the sentin8 registry. */
export async function loadAdminUiPages(): Promise<AdminUiPage[]> {
  const reg = await loadRegistry();
  const pages: AdminUiPage[] = [];
  for (const svc of reg.admin_ui ?? []) {
    for (const page of svc.pages) {
      pages.push({
        service: svc.service,
        route: page.route,
        label: page.label,
        ui_endpoint: page.ui_endpoint,
        data_endpoint: page.data_endpoint,
      });
    }
  }
  return pages;
}

/** Load all cli_commands from the sentin8 registry. */
export async function loadCliCommands(): Promise<CliCommand[]> {
  const reg = await loadRegistry();
  return reg.cli_commands ?? [];
}

/** Get all unique command groups (e.g. auth, sys, app, bus, db, ...). */
export async function loadCommandGroups(): Promise<string[]> {
  const commands = await loadCliCommands();
  const groups = new Set<string>();
  for (const cmd of commands) {
    groups.add(cmd.command);
  }
  return [...groups].sort();
}

/** Get all commands for a specific service group (e.g. 'auth', 'bus'). */
export async function loadCommandsForGroup(group: string): Promise<CliCommand[]> {
  const commands = await loadCliCommands();
  return commands.filter((c) => c.command === group);
}

/** Get all admin_ui pages for a specific service (e.g. 'auth', 'bus'). */
export async function loadPagesForService(service: string): Promise<AdminUiPage[]> {
  const pages = await loadAdminUiPages();
  return pages.filter((p) => p.service === service);
}

/**
 * Collect all unique scopes declared in the registry's `cli_commands`.
 * Used by the device-flow sign-in to request a token that covers every
 * service command — so no command gets a 403 for missing scopes.
 *
 * Scopes are extracted from each `cli_commands` entry's `scope` field.
 * Empty scopes (e.g. acme's public CA download) are skipped.
 * `openid profile email offline_access` are always included as base OIDC scopes.
 */
export async function loadAllScopes(): Promise<string> {
  const commands = await loadCliCommands();
  const scopes = new Set<string>(['openid', 'profile', 'email', 'offline_access']);
  for (const cmd of commands) {
    if (cmd.scope && !scopes.has(cmd.scope)) {
      // Split multi-scope strings (space-separated)
      for (const s of cmd.scope.split(/\s+/)) {
        if (s.trim()) scopes.add(s.trim());
      }
    }
  }
  return [...scopes].sort().join(' ');
}