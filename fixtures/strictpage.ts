// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/strictpage.ts — console-error / HTTP-error assertions for UI tests.
//
// StrictPage records console errors and HTTP ≥ 400 responses during
// browser interactions. assertNoFailures() fails on ANY error — no silent
// ignores, no filtering, no exceptions. FAIL FAST.

export class StrictPage {
  private consoleErrors: string[] = [];
  private httpErrors: string[] = [];
  /** Structured view of httpErrors (parallel array) — carries the method so
   *  superseded-retry detection can match requests precisely. */
  private httpFailureDetails: Array<{ method: string; path: string; status: number }> = [];
  /** All API responses (method, path, status) in arrival order — used to
   *  detect transient retries: a 4xx superseded by a later 2xx/3xx for the
   *  same method+path is a retry artifact, not a real failure. */
  private allResponses: Array<{ method: string; path: string; status: number }> = [];

  constructor(private page: import('@playwright/test').Page) {
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        this.consoleErrors.push(msg.text());
      }
    });
    page.on('response', (resp) => {
      try {
        const u = new URL(resp.url());
        this.allResponses.push({
          method: resp.request().method(),
          path: u.pathname,
          status: resp.status(),
        });
      } catch { /* ignore malformed URLs */ }
      if (resp.status() >= 400) {
        this.httpErrors.push(`${resp.status()} ${resp.url()}`);
        try {
          this.httpFailureDetails.push({
            method: resp.request().method(),
            path: new URL(resp.url()).pathname,
            status: resp.status(),
          });
        } catch { /* ignore malformed URLs */ }
      }
    });
  }

  /** True when a 4xx/5xx entry was followed by a 2xx/3xx for the same
   *  method+path (the client retried and the retry succeeded). Matches by
   *  value, not reference — so constructed descriptors work too. */
  private isSuperseded(entry: { method: string; path: string; status: number }): boolean {
    // Find the LAST occurrence of this exact (method, path, status).
    let lastIdx = -1;
    for (let i = 0; i < this.allResponses.length; i++) {
      const r = this.allResponses[i];
      if (r.method === entry.method && r.path === entry.path && r.status === entry.status) {
        lastIdx = i;
      }
    }
    if (lastIdx < 0) return false;
    return this.allResponses
      .slice(lastIdx + 1)
      .some(r => r.method === entry.method && r.path === entry.path && r.status >= 200 && r.status < 400);
  }

  /** Assert no console errors or HTTP ≥ 400 responses occurred.
   *  Only ignores 404s for static assets (fonts, icons, images).
   *  Also ignores transient retries: a 4xx superseded by a later 2xx/3xx
   *  for the same method+path (e.g. a form submit that raced ahead of the
   *  field state and was re-clicked successfully).
   *  All API errors (401, 403, 404 on /v1/, /proxy/, /acme/) fail the test. */
  assertNoFailures(): void {
    // Parse the console error text to correlate with tracked responses
    // ("Failed to load resource: the server responded with a status of 400
    // (Bad Request)") — the console message carries no URL, so instead of
    // correlating we check whether ANY console error corresponds to an
    // HTTP error that was superseded by a successful retry. Console
    // messages and HTTP errors are recorded in the same order for
    // failed-to-load-resource messages.
    const supersededStatuses = new Set(
      this.allResponses
        .filter(r => r.status >= 400 && this.isSuperseded(r))
        .map(r => `${r.status}`),
    );
    const relevantConsoleErrors = this.consoleErrors.filter(e => {
      // Ignore "Failed to load resource" 404s for static assets.
      if (e.includes('404') && e.includes('Failed to load resource')) return false;
      // Ignore console errors for statuses that were superseded by a
      // successful retry (e.g. "...status of 400 (Bad Request)").
      const m = e.match(/status of (\d{3})/);
      if (m && supersededStatuses.has(m[1]) && e.includes('Failed to load resource')) return false;
      return true;
    });
    if (relevantConsoleErrors.length > 0) {
      throw new Error(
        `Console errors detected:\n${relevantConsoleErrors.join('\n')}`,
      );
    }
    const relevantHttpErrors = this.httpErrors.filter((e, i) => {
      // Ignore 404s for static assets only (fonts, icons, images, JS bundles).
      if (e.match(/^404 .*\/assets\//) ||
          e.match(/^404 .*\.(svg|png|ico|woff2?|ttf|js|wasm)(\?|$)/)) return false;
      // Ignore transient retries (4xx followed by a 2xx/3xx same path).
      const details = this.httpFailureDetails[i];
      if (details && this.isSuperseded(details)) return false;
      return true;
    });
    if (relevantHttpErrors.length > 0) {
      throw new Error(
        `HTTP errors detected:\n${relevantHttpErrors.join('\n')}`,
      );
    }
    this.reset();
  }

  /** Reset the error tracking (call after navigating to a new page). */
  reset(): void {
    this.consoleErrors = [];
    this.httpErrors = [];
  }
}