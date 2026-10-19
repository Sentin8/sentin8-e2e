// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/env.ts - tree-root `.env` loader (the fleet's own configuration).
//
// The suite must test the deployment the operator actually booted, so its
// target configuration is read from the SAME `.env` the fleet is booted
// from - the tree-root `.env` (the sentin8/ group's `../.env`, resolved
// from `SENTIN8_REPO_ROOT`). There is NO hardcoded-domain fallback: URLs
// are DERIVED from `SENTIN8_DOMAIN`, and when nothing defines it the run
// fails right here at configuration load - never mid-test with a browser
// pointed at a domain nothing serves (e2e DESIGN §4, invariant 5).
//
// Precedence: a variable already present in `process.env` wins (an
// operator's explicit export overrides the `.env` file, mirroring dotenv
// semantics); `.env` lines fill in the rest.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Variables read from the tree root `.env` by this suite. */
const DOTENV_VARS = ['SENTIN8_DOMAIN', 'SENTIN8_REPO_ROOT', 'SENTIN8_CLI_BIN'] as const;

function repoRoot(): string {
  // Explicit operator override → then resolve from THIS module's location:
  // fixtures/ → sentin8-e2e/ → sentin8/ (group repo, cwd) → tree root,
  // where the group Makefile expects `../.env`.
  if (process.env.SENTIN8_REPO_ROOT) return resolve(process.env.SENTIN8_REPO_ROOT);
  // fixtures/env.ts → fixtures/ → sentin8-e2e/ → sentin8/ group → tree root.
  return resolve(import.meta.dirname ?? '.', '..', '..', '..');
}

/**
 * Load the tree-root `.env` into `process.env` for the suite's own
 * variables. Idempotent and import-time safe (module-level, runs once
 * per process - the same discipline as fixtures/run-id-writer.ts).
 * A variable present in the real environment is never overwritten.
 */
function loadTreeEnv(): void {
  const path = join(repoRoot(), '.env');
  if (!existsSync(path)) return; // environment-only runs are fine - vars must still resolve.
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return; // unreadable file → same contract: only real env vars available.
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!(DOTENV_VARS as readonly string[]).includes(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes (single or double) the operator may have used.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.length === 0) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadTreeEnv();

/**
 * The platform root domain the suite (and the fleet) targets.
 *
 * Resolution: the real environment first, then the tree-root `.env` -
 * and a hard error when NEITHER defines it. There is deliberately no
 * fallback literal: a guessed domain points the whole suite at hostnames
 * nothing serves (every URL 404s at the ingress) and turns the entire
 * run into noise.
 */
export function platformDomain(): string {
  const domain = process.env.SENTIN8_DOMAIN;
  if (!domain || domain.trim().length === 0) {
    throw new Error(
      'SENTIN8_DOMAIN is not set - the e2e suite derives every target URL ' +
      'from it. Export it or define it in the tree-root .env ' +
      `(searched: ${join(repoRoot(), '.env')}); there is no fallback domain.`,
    );
  }
  return domain;
}

/** The resolved tree root (repo group parent), as this module resolved it. */
export function treeRoot(): string {
  return repoRoot();
}