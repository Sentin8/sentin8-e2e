// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/concurrency-guard.ts - fail fast when the fleet is busy.
//
// The e2e suite and the OIDF conformance battery both drive ONE fleet.
// Their data planes are separate (e2e uses run-scoped orgs/personas;
// conformance owns `conformance-local`), so they can run side by side.
// What they cannot do is share the fleet's single, unscoped surfaces:
//
//   * the auth rate limiter (`auth:rate:ip:*` / `auth:rate:email:*`) is
//     one global window per IP and per email, with no per-run prefix;
//   * a conformance module that parks for ten minutes
//     (`par-attempt-to-use-expired-request_uri`) holds tenant state and
//     must not be raced by org/env/service mutations;
//   * the suite KILLS a live module when a second campaign touches the
//     same alias, and that victim lands in a terminal INTERRUPTED state
//     no rerun repairs.
//
// The conformance side already guards itself: `conformance-run-all.sh`
// takes `$TREE_ROOT/.tmp/conformance/run.lock` (flock) and refuses to
// start when a playwright process is live. That guard is one-directional
// - it cannot stop a battery that started FIRST and an e2e run that
// started second. This module supplies the mirror, taking the SAME lock
// file so the mutual exclusion is symmetric rather than a race the
// suite happens to lose.
//
// Refusing to start is deliberate (the same policy the runner states):
// silently queueing behind an unknown run hides the real problem and
// makes runtimes unreadable.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { treeRoot } from './env.js';
import { logStep } from './log.js';

/** Set by the probe; tells the parent shell which tree-local lock to hold. */
export const LOCK_ENV = 'SENTIN8_E2E_LOCK';

/** The tree-local lock the conformance runner also takes. */
function lockPath(): string {
  return join(treeRoot(), '.tmp', 'conformance', 'run.lock');
}

/**
 * True when the conformance battery holds the tree lock right now.
 *
 * `flock -n` is the authority: it either acquires the lock or reports
 * the battery's ownership, with no process-table heuristics to get
 * wrong. The probe opens the file, tries the lock, and immediately
 * closes - acquiring and releasing it costs microseconds and cannot
 * disturb the holder.
 *
 * When `flock` is unavailable (non-Linux dev hosts) the run proceeds
 * rather than blocking: a missing tool must not make the suite
 * unrunnable, and the hazard only exists while a battery is live.
 */
export function conformanceLockHeld(): boolean {
  const lock = lockPath();
  if (!existsSync(lock)) return false;
  try {
    // -n = non-blocking, -x = exclusive. Exit 0 means we took the lock
    // (nobody holds it); a non-zero exit means the holder has it.
    execFileSync('flock', ['-n', '-x', lock, '-c', 'true'], {
      stdio: 'ignore',
      timeout: 2_000,
    });
    return false;
  } catch (err) {
    // Distinguish "lock is held" from "flock is not installed". A missing
    // binary raises ENOENT; a held lock raises a non-zero exit (an Error
    // with `status`).
    const code = (err as NodeJS.ErrnoException).code;
    return code !== 'ENOENT';
  }
}

/**
 * Refuse to start while the conformance battery owns the fleet.
 *
 * Called from global setup so the failure lands before a single test
 * runs - a campaign that is 90 minutes in must not be disturbed by a
 * suite that would then fail intermittently for reasons it cannot
 * explain.
 *
 * The override exists for the case where the operator knows the battery
 * is parked on a module that cannot collide (e.g. it is waiting out a
 * 600 s `request_uri` sleep and touches nothing). It is opt-in because
 * the default has to be the safe answer.
 */
export function assertFleetIsFree(): void {
  if (process.env.SENTIN8_E2E_ALLOW_CONCURRENT === '1') return;
  if (!conformanceLockHeld()) return;
  throw new Error(
    'A conformance battery is running against this fleet ' +
    `(it holds ${lockPath()}).\n` +
    '  Both suites share the auth rate limiter and the cert-user state, ' +
    'and a mid-flight module can be killed by a rival campaign.\n' +
    '  Wait for the battery to finish, or set SENTIN8_E2E_ALLOW_CONCURRENT=1 ' +
    'if you have verified it is parked on a module that cannot collide.',
  );
}

/**
 * Take the shared lock for the lifetime of this process.
 *
 * Called only from the `with-ca.sh` wrapper (via the `LOCK_ENV` probe
 * above), because a lock must be held by a process that OUTLIVES the
 * tests - a Playwright worker or global-setup process exits while the
 * run continues, and its lock would be released to the next family of
 * tests. The shell wrapper holds it around the whole `playwright test`
 * invocation, which is exactly the span that matters.
 *
 * Returns a release function. The descriptor is kept open on purpose:
 * closing it is what releases the lock.
 */
export function holdFleetLock(): () => void {
  const lock = lockPath();
  mkdirSync(join(treeRoot(), '.tmp', 'conformance'), { recursive: true });
  const fd = openSync(lock, 'w');
  try {
    // Blocking acquire: by the time the shell reaches here the probe has
    // already refused to start a run against a live battery, so waiting
    // covers only the narrow window between probe and acquire.
    execFileSync('flock', ['-x', lock, '-c', 'true'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return () => closeSync(fd);
  } catch (err) {
    closeSync(fd);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Log the guard's verdict so the run record says why it proceeded. */
export function reportFleetState(): void {
  if (conformanceLockHeld()) {
    logStep('[guard] conformance lock is HELD by another run');
  } else {
    logStep('[guard] conformance lock is free - fleet is ours');
  }
}
