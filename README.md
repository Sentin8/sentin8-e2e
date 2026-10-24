# sentin8-e2e - End-to-End UI Test Suite

## 1. Summary

The platform's Playwright E2E suite. Tests drive the platform exactly
like a real user: browser UI + the BFF proxy API only - **no direct
DB/backend access, no `psql`, no bypassed authorization** (AGENTS.md
E2E rule). Test state is built through real flows (sign-up, org/env
creation, feature enablement) or the BFF proxy.

## 2. Layout

```
sentin8-e2e/
├── playwright.config.ts    # browser matrix + base URL
├── fixtures/               # page objects + authenticated fixtures
├── scripts/                # run helpers
└── tests/                  # the suites (auth, orgs, apps, …)
```

## 3. Usage

```bash
pnpm install
pnpm run test:ui            # headless run against a running fleet
npx playwright show-report  # last run's report
```

Requires a booted platform (captain fleet + infra; see the group
Makefile and the root `Makefile`). The suite reads the tree-root
`.env` for its target (`SENTIN8_DOMAIN` → e.g. `dash.ops.sys.{domain}`;
`process.env` overrides win). No `SENTIN8_DOMAIN` in `.env` or the
environment fails the run at startup - URLs are derived, never guessed.

## 4. Rules

- UI + BFF proxy only - a setup step impossible through the UI/API is
  a **product gap** to fix in the backend, never a reason to reach
  for SQL.
- No secrets in fixtures; credentials come from the environment.
- All target URLs derive from `fixtures/testdata.ts` (`DOMAIN`);
  hard-coded hostname literals in specs are defects.

---

**Architecture & Design:** sentin8:e2e and its underlying concepts were designed by [Hamid Jahanzad](https://www.linkedin.com/in/hamidjahanzad/).
