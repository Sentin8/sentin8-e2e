// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/run-id-writer.ts — side-effect module, imported ONLY by
// tests/ui/global-setup.ts as its FIRST import.
//
// Playwright runs globalSetup in a separate Node process from the test
// workers. Any import-time constant (like fixtures/testdata.ts RUN_ID)
// would therefore differ between processes ("split-brain" run ids: the
// storage state session belongs to globalSetup's persona while workers
// compute a different email). This module body executes before any
// other import of global-setup resolves testdata/harness/cli, so it
// writes the authoritative run id to disk; worker processes later read
// the persisted value from fixtures/testdata.ts.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Same shape as the previous import-time RUN_ID in testdata.ts. */
function generateRunId(): string {
  return Date.now().toString().slice(-8) + Math.random().toString(36).slice(2, 6);
}

const RUN_ID_PATH = join(process.cwd(), '.tmp', 'run-id.json');

mkdirSync(dirname(RUN_ID_PATH), { recursive: true });
writeFileSync(RUN_ID_PATH, JSON.stringify({ runId: generateRunId() }, null, 2));