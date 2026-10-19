// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/state.ts - cross-suite state shared via .e2e-state.json.
//
// CLI suites pass IDs and tokens via this file so later suites can
// read them (e.g. a user created in the auth suite is used by the
// bidirectional proof suite).

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const STATE_PATH = '.e2e-state.json';

export interface E2EState {
  // CLI sign-in state
  cliSignedIn?: boolean;
  cliUserEmail?: string;

  // Auth suite
  authUserId?: string;
  authRoleId?: string;
  authGroupId?: string;
  authApiKey?: string;
  authApplicationId?: string;
  authConnectionId?: string;

  // Sys suite
  sysOrgId?: string;
  sysEnvId?: string;

  // App suite
  appListingId?: string;
  appInstanceId?: string;

  // Storage suite
  storageObjectPath?: string;

  // Func suite
  funcModuleId?: string;

  // Cron suite
  cronScheduleId?: string;

  // Flow suite
  flowWorkflowId?: string;

  // Stat suite
  statPropertyId?: string;
  statAccountId?: string;

  // Post suite
  postGatewayId?: string;

  // Bus suite
  busStreamFamily?: string;
  busMessageId?: string;

  // DB suite
  dbTableId?: string;
}

export async function loadState(): Promise<E2EState> {
  try {
    const raw = await readFile(STATE_PATH, 'utf-8');
    return JSON.parse(raw) as E2EState;
  } catch {
    return {};
  }
}

export async function saveState(state: E2EState): Promise<void> {
  await mkdir(dirname(STATE_PATH) || '.', { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmp, STATE_PATH);
}

export async function updateState(partial: Partial<E2EState>): Promise<E2EState> {
  const current = await loadState();
  const merged: E2EState = { ...current };
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined && v !== '') {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  await saveState(merged);
  return merged;
}

export async function resetState(): Promise<void> {
  try {
    await unlink(STATE_PATH);
  } catch {
    // already gone
  }
}

// ── In-memory state (for tests within a single worker) ─────────────────

let _state: E2EState | undefined;

export async function getState(): Promise<E2EState> {
  if (!_state) _state = await loadState();
  return _state;
}

export async function setState(partial: Partial<E2EState>): Promise<E2EState> {
  const current = await getState();
  _state = { ...current, ...partial };
  await saveState(_state);
  return _state;
}