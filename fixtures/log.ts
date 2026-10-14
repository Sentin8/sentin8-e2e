// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/log.ts — shared step-log helper with a consistent timestamp prefix.
//
// Mirrors bank8/e2e-ts/fixtures/log.ts — identical implementation.

function fmtTimestamp(d: Date = new Date()): string {
  return d.toISOString();
}

export function logStep(message: string, ...rest: unknown[]): void {
  console.log(`[${fmtTimestamp()}] ${message}`, ...rest);
}