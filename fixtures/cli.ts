// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/cli.ts - sentin8-cli subprocess runner + output parser.
//
// Story E2E-CLI-1: Spawns the sentin8-cli binary as a real subprocess,
// captures stdout/stderr, parses JSON/table output. This exercises the
// actual binary, its token storage (~/.sentin8/credentials), and its
// delegation path - not a re-implementation of the executor.
//
// Story E2E-CLI-2: Headless device-flow sign-in. The CLI's RFC 8628
// Device Flow is completed by reading the user_code from stdout and
// approving via a direct API call to Sentin8:Auth.

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CLI_BIN, URLs, DOMAIN, Personas } from './testdata.js';
import { loadAllScopes } from './registry.js';
import { clearAuthRateLimits } from './harness.js';
import { logStep } from './log.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: unknown;
  /** Full command line used to invoke the CLI (for logging). */
  cmdLine: string;
}

/**
 * A parsed-JSON record view of a `CliResult.json` for property access in
 * specs: the CLI's JSON body is service-defined and untyped at the
 * fixture layer, so the specs that read fields cast through this shape.
 * `null` for non-object bodies (the caller's expectation then fails
 * loudly at the property read, naming the real body shape).
 */
export type CliJson = Record<string, unknown>;

/**
 * Typed record view of a CLI result's JSON body (throws on absent JSON -
 * a spec reading fields means the call was expected to return an object).
 */
export function jsonObj(r: CliResult): CliJson {
  if (r.json && typeof r.json === 'object' && !Array.isArray(r.json)) {
    return r.json as CliJson;
  }
  throw new Error(`expected a JSON object body, got: ${r.stdout.slice(0, 200)}`);
}

// ── Core runner ────────────────────────────────────────────────────────

/**
 * Spawn the sentin8-cli binary with the given args, wait for it to
 * complete, and return the captured output.
 */
export async function runCli(
  args: string[],
  opts: { env?: Record<string, string>; timeout?: number } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...opts.env };
    const cmdLine = `${CLI_BIN} ${args.join(' ')}`;
    const child: ChildProcess = spawn(CLI_BIN, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = opts.timeout
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`CLI timed out after ${opts.timeout}ms: ${args.join(' ')}`));
        }, opts.timeout)
      : undefined;

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer);
      const result: CliResult = {
        exitCode: code ?? -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        cmdLine,
      };
      // Try to parse JSON if the output looks like JSON.
      // The CLI may print a version banner line ("sentin8-cli v0.1.0 …")
      // before the JSON body - strip everything before the first '{' or
      // '[' so result.json is populated. Without this, extractId falls
      // back to the first-UUID-in-text regex, which can match an
      // unrelated field (e.g. created_by) that happens to sort before id.
      const trimmedRaw = result.stdout.trim();
      let jsonCandidate = trimmedRaw;
      if (!jsonCandidate.startsWith('{') && !jsonCandidate.startsWith('[')) {
        const brace = jsonCandidate.search(/[{[]/);
        if (brace > 0) jsonCandidate = jsonCandidate.slice(brace);
      }
      const trimmed = jsonCandidate.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          result.json = JSON.parse(trimmed);
        } catch {
          // not JSON - leave json undefined
        }
      }
      resolve(result);
    });

    child.on('error', (err: Error) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Convenience wrappers ───────────────────────────────────────────────

/**
 * Execute a declarative service command:
 *   sentin8-cli do <command> <subcommand> <action> [--field value ...] [--env ID]
 */
export async function cliDo(
  command: string,
  subcommand: string,
  action: string,
  fields: Record<string, string> = {},
  opts: { env?: string } = {},
): Promise<CliResult> {
  const args = ['do', command, subcommand, action];
  for (const [k, v] of Object.entries(fields)) {
    args.push(`--${k}=${v}`);
  }
  if (opts.env) {
    args.push(`--env=${opts.env}`);
  }
  return runCli(args);
}

/**
 * Execute the generic passthrough:
 *   sentin8-cli call <service> <method> <path> [--body=JSON] [--env=ENV_ID]
 * When envId is provided, the CLI targets that env (target_env_id query param).
 */
export async function cliCall(
  service: string,
  method: string,
  path: string,
  body?: unknown,
  envId?: string,
): Promise<CliResult> {
  const args = ['call', service, method, path];
  if (body) {
    args.push(`--body=${JSON.stringify(body)}`);
  }
  if (envId) {
    args.push(`--env=${envId}`);
  }
  return runCli(args);
}

/**
 * Execute the generic passthrough:
 *   sentin8-cli list-commands
 */
export async function cliListCommands(): Promise<CliResult> {
  return runCli(['list-commands']);
}

/** Get the current signed-in user. */
export async function cliWhoami(): Promise<CliResult> {
  return runCli(['whoami']);
}

/**
 * Force a token refresh by calling the auth refresh endpoint directly.
 * This is needed after the user gains new roles (e.g. env:admin after
 * creating an env) - the stored access token is still valid but carries
 * the old (pre-env-creation) scope set. A refresh re-computes role scopes
 * server-side via fetch_role_scopes and returns an updated token.
 */
export async function cliRefreshToken(): Promise<void> {
  const sentin8Dir = join(homedir(), '.sentin8');
  const credPath = join(sentin8Dir, 'credentials');
  const raw = await readFile(credPath, 'utf-8').catch(() => {
    throw new Error('cliRefreshToken: no credentials file found');
  });
  const creds = JSON.parse(raw) as {
    access_token: string;
    refresh_token: string;
    expires_at: string;
    sentin8_auth_url: string;
  };
  if (!creds.refresh_token) {
    throw new Error('cliRefreshToken: no refresh token in credentials');
  }
  const resp = await fetch(`${creds.sentin8_auth_url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refresh_token,
      client_id: 'sentin8-cli',
    }),
  });
  if (!resp.ok) {
    throw new Error(`cliRefreshToken: refresh failed: HTTP ${resp.status} ${await resp.text()}`);
  }
  const token = await resp.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  creds.access_token = token.access_token;
  if (token.refresh_token) {
    creds.refresh_token = token.refresh_token;
  }
  creds.expires_at = new Date(
    Date.now() + (token.expires_in ?? 3600) * 1000,
  ).toISOString();
  await writeFile(credPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

// ── Sign-in (E2E-CLI-2: headless device-flow) ──────────────────────────

/**
 * Sign in the CLI using OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * Implements the full device flow:
 *   1. CLI signup - `sentin8-cli signup --email --password` creates the user.
 *   2. POST /oauth/device to get a device_code + user_code + verification_uri.
 *   3. Open a browser to the verification_uri, sign in via the auth sign-in
 *      page (fill email + password, click Continue), then approve the device.
 *   4. Poll POST /oauth/token with grant_type=device_code until approved.
 *   5. Write the resulting token to ~/.sentin8/credentials.
 */
export async function cliSignIn(
  email: string = Personas.admin.email,
  password: string = Personas.admin.password,
): Promise<void> {
  // Check if already signed in AS THE RIGHT USER with scopes.
  // Force re-sign-in if:
  //   - not signed in at all
  //   - signed in as a different user
  //   - signed in but has no scopes (old token without scope discovery)
  try {
    const who = await cliWhoami();
    if (who.exitCode === 0) {
      const whoEmail = who.stdout.match(/User:\s*(\S+)/)?.[1] ?? '';
      const whoScopes = who.stdout.match(/Scopes:\s*(.*)/)?.[1]?.trim() ?? '';
      if (whoEmail === email && whoScopes.length > 0) {
        return; // Already signed in as the right user with scopes.
      }
      // Wrong user or no scopes - sign out first, then re-sign in.
      logStep(`[step] cliSignIn: re-signing in (was ${whoEmail || 'unknown'}, need ${email})`);
      await runCli(['signout']);
    }
  } catch {
    // not signed in - proceed
  }

  // Disable TLS verification for the local self-signed CA
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  try {
    // Step 1: Sign up the user via CLI (idempotent - OK if already exists).
    const signupResult = await runCli([
      'signup', '--email', email, '--password', password,
      '--first-name', 'Test', '--last-name', 'Operator',
    ]);
    // exit 0 = created, non-zero = already exists (both are OK).

    // Step 2-5: Browser-assisted device flow.
    // Clear auth rate limits first - the device flow browser sign-in
    // counts against the rate limiter.
    clearAuthRateLimits(email);
    await deviceFlowSignIn(email, password);
  } finally {
    if (prev === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }
}

/** Full device-flow: request code → browser sign-in + approve → poll → write credentials. */
async function deviceFlowSignIn(email: string, password: string): Promise<void> {
  // Collect all scopes from the registry so the token covers every
  // service command - no command gets a 403 for missing scopes.
  const scope = await loadAllScopes();

  // 1. Request device code
  const deviceResp = await fetch(`${URLs.auth}/oauth/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'sentin8-cli',
      scope,
      audience: 'sentin8',
    }),
  });

  if (!deviceResp.ok) {
    throw new Error(`Device auth request failed: ${deviceResp.status} ${await deviceResp.text()}`);
  }

  const deviceData = await deviceResp.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };

  // 2. Approve the device code via browser sign-in
  await approveDeviceViaBrowser(deviceData.verification_uri_complete, email, password);

  // 3. Poll for the token - poll immediately, then every 1 second.
  const startTime = Date.now();
  const maxWait = (deviceData.expires_in ?? 900) * 1000;
  const pollInterval = 1000; // 1 second (faster than server's suggested 5s)

  while (Date.now() - startTime < maxWait) {
    await sleep(pollInterval);

    const tokenResp = await fetch(`${URLs.auth}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceData.device_code,
        client_id: 'sentin8-cli',
      }),
    });

    const tokenData = await tokenResp.json() as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
      error?: string;
    };

    // RFC 8628 §3.5 - only `authorization_pending` and `slow_down` mean
    // "keep polling". Any other error is terminal: fail fast (with the
    // server's error_description when present) instead of looping to the
    // 15-minute device-code expiry.
    const POLLABLE = new Set(['authorization_pending', 'slow_down']);
    if (tokenData.error && !POLLABLE.has(tokenData.error)) {
      const desc = (tokenData as { error_description?: string }).error_description ?? '';
      throw new Error(`Device token poll failed: ${tokenData.error}${desc ? ` - ${desc}` : ''}`);
    }

    if (tokenData.access_token) {
      // 4. Write credentials to ~/.sentin8/credentials
      const expiresAt = new Date(
        Date.now() + (tokenData.expires_in ?? 3600) * 1000,
      ).toISOString();

      const credentials = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token ?? '',
          token_type: tokenData.token_type ?? 'Bearer',
          expires_at: expiresAt,
          sentin8_auth_url: URLs.auth,
          user: {
            email,
            subject_id: '',
            scopes: [],
            org_id: undefined,
            env_id: undefined,
          },
        };

        const sentin8Dir = join(homedir(), '.sentin8');
        await mkdir(sentin8Dir, { recursive: true });
        await writeFile(
          join(sentin8Dir, 'credentials'),
          JSON.stringify(credentials, null, 2),
          { mode: 0o600 },
        );
      return;
    }

    if (tokenData.error === 'authorization_pending' || tokenData.error === 'slow_down') {
      continue;
    }

    if (tokenData.error === 'expired_token' || tokenData.error === 'access_denied') {
      throw new Error(`Device flow failed: ${tokenData.error}`);
    }
  }

  throw new Error('Device flow timed out waiting for approval');
}

/**
 * Approve a device code by opening a browser, signing in via the auth
 * sign-in page, and approving the device code - exactly like a real user.
 * Falls back to direct API approval if the browser flow can't complete.
 */
async function approveDeviceViaBrowser(
  verificationUri: string,
  email: string,
  password: string,
): Promise<void> {
  const userCodeMatch = verificationUri.match(/user_code=([^&]+)/);
  const userCode = userCodeMatch ? userCodeMatch[1] : '';

  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({
    headless: false,
    args: ['--ignore-certificate-errors', '--disable-features=DnsOverHttps'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  let approved = false;
  try {
    // 1. Navigate to the verification URL and sign in.
    await page.goto(verificationUri, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    const emailBox = page.getByRole('textbox', { name: 'Email', exact: false });
    if (await emailBox.count() > 0) {
      await emailBox.first().click({ force: true });
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.insertText(email);
      await page.waitForTimeout(200);

      const pwBox = page.getByRole('textbox', { name: 'Password', exact: false });
      if (await pwBox.count() > 0) {
        await pwBox.first().click({ force: true });
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.insertText(password);
        await page.waitForTimeout(200);
      }

      const continueBtn = page.getByRole('button', { name: 'Continue', exact: true });
      if (await continueBtn.count() > 0) {
        await continueBtn.first().click({ force: true });
        await page.waitForTimeout(1000);
      }
    }

    // 2. After sign-in, look for an approval button.
    for (const label of ['Allow', 'Approve', 'Authorize']) {
      const btn = page.getByRole('button', { name: label, exact: true });
      if (await btn.count() > 0) {
        await btn.first().click({ force: true });
        await page.waitForTimeout(500);
        approved = true;
        break;
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  // Fallback: if browser didn't find an approval button, approve via API.
  // SEC-2.1.4 - device verification requires a session; the approving
  // user comes from the session token, not the request body.
  if (!approved && userCode) {
    // The hostname header routes the request through the ingress; it is
    // DERIVED from the suite's domain (never a hardcoded literal - e2e
    // DESIGN §4 invariant 5).
    const authHost = `auth.ops.sys.${DOMAIN}`;
    const signInResp = await fetch(`${URLs.auth}/v1/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sentin8-hostname': authHost },
      body: JSON.stringify({ email, password }),
    });
    if (signInResp.ok) {
      const signInData = await signInResp.json() as { user_id: string; token: string };
      await fetch(`${URLs.auth}/device/verify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${signInData.token}`,
        },
        body: JSON.stringify({ user_code: userCode }),
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Test fixtures ─────────────────────────────────────────────────────

/**
 * Load a WASM binary fixture and return it as a base64 string (for the
 * `func module upload` command which expects `wasm_binary` as base64).
 */
export async function loadWasmFixture(name: string = 'minimal.wasm'): Promise<string> {
  const fixturesDir = dirname(fileURLToPath(import.meta.url));
  const wasmPath = join(fixturesDir, 'wasm', name);
  const bytes = await readFile(wasmPath);
  return bytes.toString('base64');
}

/**
 * Build a DISTINCT wasm binary from a base fixture by appending an empty
 * custom section carrying the given tag. Custom sections are ignorable,
 * so the module stays valid for the func validator - but its content
 * hash differs, which the content-addressed module registry (func
 * DESIGN §3: same (env, domain, product, hash) re-registers the existing
 * version) needs to treat v2/v3 as NEW versions.
 */
export async function loadWasmFixtureVariant(
  name: string,
  tag: string,
): Promise<string> {
  const fixturesDir = dirname(fileURLToPath(import.meta.url));
  const wasmPath = join(fixturesDir, 'wasm', name);
  const bytes = new Uint8Array(await readFile(wasmPath));
  const sectionId = 0; // custom section
  const nameBytes = Buffer.from(tag, 'utf8');
  const payloadLen = nameBytes.length + 1; // name len byte + name
  const section = Buffer.from([
    sectionId,
    ...Buffer.from(LEB128(payloadLen)),
    nameBytes.length,
    ...nameBytes,
  ]);
  const out = Buffer.concat([Buffer.from(bytes), section]);
  return out.toString('base64');
}

function LEB128(value: number): number[] {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

/** Sign out and clear credentials. */
export async function cliSignOut(): Promise<CliResult> {
  return runCli(['signout']);
}

// ── Assertions ───────────────────────────────────────────────────────

/** Normalize a `CliResult | Promise<CliResult>` into a resolved result.
 *  Two call shapes exist across the specs: `assertCliOk(r, …)` with an
 *  already-awaited result, and `await assertCliOk(cliCall(…))` passing the
 *  raw promise. Passing a promise to the sync form silently read
 *  `Promise.exitCode === undefined` and threw a misleading
 *  `exit=undefined` error (incident 2026-09-09: ai/policy specs failed on
 *  their first CLI call while the same call succeeded manually).
 *  Accepting both shapes fixes the 21 call sites at once; the helpers
 *  return the resolved result so the awaited form can read `.json`.
 */
async function resolveResult(
  result: CliResult | Promise<CliResult>,
): Promise<CliResult> {
  return result instanceof Promise ? result : Promise.resolve(result);
}

/** Throw the standard CLI-failure error (shared by the assert helpers). */
function cliFailureError(r: CliResult, context?: string, expected?: string): Error {
  const head = expected
    ? `CLI command should have failed${context ? ` (${context})` : ''} but succeeded`
    : `CLI command failed${context ? ` (${context})` : ''}: exit=${r.exitCode}`;
  return new Error(`${head}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
}

/**
 * Assert the CLI command succeeded (exit code 0). Returns the resolved
 * result (so the awaited form can read `.json`).
 *
 * Contract (E2E-BI-12, 2026-09-23): when called with an ALREADY-RESOLVED
 * `CliResult` the failure throws SYNCHRONOUSLY - no promise escapes the
 * test body. The helpers are `async` (to support the
 * `await assertCliOk(cliCall(…))` shape) and the specs historically called
 * them un-awaited with resolved inputs: a rejected promise then propagated
 * out of the test body, Playwright attributed the failure to the NEXT
 * serial test, and the remaining suite was skipped (2026-09-23 e2e run:
 * storage's exit=1 reported as the func test, 156 tests skipped). The
 * sync-throw form guarantees the failure lands on the test that caused it,
 * whether or not the call site awaits. Passing a PROMISE still requires
 * awaiting the helper for the throw to be observed.
 */
export async function assertCliOk(
  result: CliResult | Promise<CliResult>,
  context?: string,
): Promise<CliResult> {
  if (result instanceof Promise) {
    const r = await result;
    logStep(`[cli-verify] ${context ?? 'CLI command'} - exit=${r.exitCode} | ${r.cmdLine}`);
    if (r.exitCode !== 0) throw cliFailureError(r, context);
    return r;
  }
  const r = result;
  logStep(`[cli-verify] ${context ?? 'CLI command'} - exit=${r.exitCode} | ${r.cmdLine}`);
  if (r.exitCode !== 0) throw cliFailureError(r, context);
  return r;
}

/**
 * Assert the CLI command succeeded (exit code 0).
 * FAIL FAST - no silent swallowing of HTTP errors.
 * If the CLI gets 403, 422, 404, etc., that's a real failure.
 * Same resolved-input sync-throw contract as `assertCliOk` (E2E-BI-12).
 */
export async function assertCliDispatched(
  result: CliResult | Promise<CliResult>,
  context?: string,
): Promise<CliResult> {
  if (result instanceof Promise) {
    const r = await result;
    logStep(`[cli-verify] ${context ?? 'CLI command'} - exit=${r.exitCode} | ${r.cmdLine}`);
    if (r.exitCode !== 0) throw cliFailureError(r, context);
    return r;
  }
  const r = result;
  logStep(`[cli-verify] ${context ?? 'CLI command'} - exit=${r.exitCode} | ${r.cmdLine}`);
  if (r.exitCode !== 0) throw cliFailureError(r, context);
  return r;
}

/** Assert the CLI command failed (exit code non-zero) - for scope-gate tests.
 *  Same resolved-input sync-throw contract as `assertCliOk` (E2E-BI-12). */
export async function assertCliFailed(
  result: CliResult | Promise<CliResult>,
  context?: string,
): Promise<CliResult> {
  if (result instanceof Promise) {
    const r = await result;
    if (r.exitCode === 0) throw cliFailureError(r, context, 'expected-failure');
    return r;
  }
  const r = result;
  if (r.exitCode === 0) throw cliFailureError(r, context, 'expected-failure');
  return r;
}

/** Extract a field from the CLI's JSON output. */
export function extractJsonField(result: CliResult, field: string): unknown {
  if (!result.json || typeof result.json !== 'object') {
    throw new Error(`CLI output is not JSON: ${result.stdout}`);
  }
  const obj = result.json as Record<string, unknown>;
  return obj[field];
}

/** Extract an ID from the CLI's JSON output (tries 'id', then 'uuid', then 'table rows'). */
export function extractId(result: CliResult): string {
  if (!result.json) {
    // If the output is not JSON, try to extract a UUID from the text
    // (the CLI may output a table format with the ID visible)
    const uuidMatch = result.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) return uuidMatch[0];
    throw new Error(`Could not extract ID from CLI output: ${result.stdout}`);
  }
  const obj = result.json as Record<string, unknown>;
  // Direct field
  if (typeof obj.id === 'string') return obj.id;
  if (typeof obj.uuid === 'string') return obj.uuid;
  // Array - take first row's id
  if (Array.isArray(obj.rows) && obj.rows.length > 0) {
    const row = obj.rows[0] as Record<string, unknown>;
    if (typeof row.id === 'string') return row.id;
  }
  if (Array.isArray(obj) && obj.length > 0) {
    const row = obj[0] as Record<string, unknown>;
    if (typeof row.id === 'string') return row.id;
  }
  // Try UUID extraction from the raw stdout as fallback
  const uuidMatch = result.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuidMatch) return uuidMatch[0];
  throw new Error(`Could not extract ID from CLI output: ${result.stdout}`);
}