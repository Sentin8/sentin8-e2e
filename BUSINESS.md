# sentin8-e2e - Business Requirements & Functionality

> Audience: product owners, business analysts, and anyone evaluating what
> sentin8-e2e **does for the business**. For the overview read `README.md`;
> for wire-level detail read `DESIGN.md`.

## 1. Business Purpose

The E2E suite is the platform's **proof that the product works for the
person using it**: a real browser, a real sign-up, a real org, real
navigation - with the same restrictions a user has. Its findings are
the business's release gate. The value it delivers:

- **User-journey confidence.** Feature green = a customer can complete
  the journey, not merely that unit tests pass.
- **Security posture exercised as shipped.** The suite cannot bypass
  authorization - it proves the real permission model admits real users
  to real places.
- **A product-gap detector, not a workaround engine.** Any state that
  cannot be reached through the UI/API is a backend gap to fix - the
  suite never papers over product holes with direct data access.

## 2. Business Scope (What the Service Provides)

| Area | Capabilities |
|---|---|
| Auth journeys | Sign-up, sign-in, MFA, password flows - exactly the customer's path |
| Tenancy journeys | Org creation, environment setup, role assignment through real UI flows |
| App journeys | App store listing, app instance setup, first-run |
| Admin surfaces | Dashboard navigation of admin capabilities |
| Release gate | `pnpm run test:ui` against a booted release fleet - the pre-merge/pre-release signal |

### What the suite does NOT own (business boundary)

| Out of scope | Owner |
|---|---|
| Backend unit/integration coverage | each service repo's Rust suites |
| Load/performance measurements | Sentin8:Stat + dedicated bench targets |
| Fleet provisioning proof (docker E2E) | the captain's module kit (design) |
| Test-state databases | none exist by rule - the UI/API is the only state builder |

## 3. Business Capabilities

| Capability | Business rule |
|---|---|
| True-user simulation | The suite holds the same powers as a human: browser UI + same-origin BFF proxy - nothing more |
| Real-flow setup | Every prerequisite (orgs, envs, roles, features) is constructed through the product's own flows |
| Fail-as-a-gap | Missing UI/API capability = filed backend story, never SQL workarounds |
| Environment credentials | Test credentials come from configuration; no secrets in the repo |
| Same-config-as-fleet targeting | The suite always tests the deployment the operator actually booted - its target domain is read from the same `.env` the fleet uses, never a built-in second opinion |

## 4. Business Events (Outbound)

None. Output surface: Playwright reports (HTML) + CI exit codes - the
release gate's signal.

## 5. Business Rules & Invariants

1. **UI + BFF proxy only** - no `psql`, no direct SQL, no direct
   backend HTTP outside the proxy.
2. **No authorization bypass** - permissions through real flows.
3. **No secrets committed** - fixtures read the environment.
4. **A red suite blocks a release** - the gate is the gate.
5. **Point-at-booted target** - the suite's target domain comes from
   the fleet's own `.env`; a missing domain fails the run before any
   test starts (a suite pointed at nothing tests nothing).

## 6. Target-User Roles & Use Cases

| Persona | What they do with sentin8-e2e |
|---|---|
| Release manager | Reads the suite result as the go/no-go signal |
| QA engineers | Extend journeys; keep the suite honest (a gap is a gap) |
| Backend engineers | Treat a suite failure at a real flow as a product defect to fix |
| Product owners | Watch journey coverage as the definition of "works" |

## 7. KPIs / Success Criteria

- **Journey coverage**: every business-critical journey (sign-up → org →
  env → app) has a green path in the suite.
- **Honesty rate**: zero SQL/direct-access workarounds (rule-checked);
  every skipped setup is a filed product gap.
- **Flake control**: retries bounded; persistent flakes are fixed as
  product or test defects, never suppressed.

## 8. Dependencies & Reliance on Other Services

| The business relies on… | For |
|---|---|
| A booted release fleet (captain + services + PG + Valkey) | The system under test |
| Sentin8:BFF | The sanctioned API surface (`/proxy/...`) |
| Playwright | The runner, browser matrix, reporting |

## 9. Acceptance Criteria

1. The full suite passes against a freshly booted release fleet.
2. No test reaches for `psql`/SQL/direct backend calls (reviewed rule).
3. Authorization-sensitive journeys assert BOTH the admit and the deny
   paths where the product defines them.
4. Reports are generated and readable per run.

## 10. Open Business Questions

- Fleet-plane UI journeys (multi-host status views) land with's
  status polish.
- Cross-browser matrix breadth (beyond the default) follows deployment
  browser telemetry.

---

**Architecture & Design:** sentin8:e2e and its underlying concepts were designed by [Hamid Jahanzad](https://www.linkedin.com/in/hamidjahanzad/).
