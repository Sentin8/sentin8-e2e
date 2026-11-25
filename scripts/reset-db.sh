#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
# SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
# SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
# SPDX-License-Identifier: Apache-2.0
# ── sentin8 platform e2e DB reset helper ────────────────────────────────
#
# Returns the platform database to a VIRGIN state and re-enrolls every
# service fragment, so the next run starts from a fleet nobody has
# bootstrapped yet.
#
# There is no `sentin8-cli db reset` - by design: the platform CLI has no
# destructive path at all (CLI DESIGN §4.9a). Local destruction is an
# INFRA reset, owned by `sentin8-cli/scripts/dev-destroy.sh`, and the
# reconstruction is the ordinary operator flow whose bootstrap step is a
# gate, not a command:
#
#   dev-destroy.sh      # stop fleet -> down -v -> infra TLS -> infra up
#   vertical enroll ... # bootstrap-if-needed, then converge fragments
#
# Usage:
#   SENTIN8_DEV=1 ./scripts/reset-db.sh
#
# The SENTIN8_DEV=1 guard is the platform's own: it makes accidental
# use against anything but a local dev tree impossible.

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Tree root: explicit override, else sentin8-e2e/ -> sentin8/ group -> tree.
TREE_ROOT="${SENTIN8_REPO_ROOT:-$(cd "$SUITE_ROOT/../.." && pwd)}"
GROUP_ROOT="$TREE_ROOT/sentin8"

if [[ "${SENTIN8_DEV:-}" != "1" ]]; then
  echo "ERROR: this WIPES the platform database - set SENTIN8_DEV=1 to confirm." >&2
  echo "       (local development only; see sentin8-cli DESIGN §4.9a)" >&2
  exit 1
fi

OPERATOR_ENV="$TREE_ROOT/.env"
if [[ ! -f "$OPERATOR_ENV" ]]; then
  echo "ERROR: $OPERATOR_ENV not found - it carries the SENTIN8_* paths the reset needs." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$OPERATOR_ENV"
set +a

# ── CLI binary: explicit override -> release -> debug, tree-relative ─────
CLI_BIN="${SENTIN8_CLI_BIN:-}"
if [[ -z "$CLI_BIN" ]]; then
  for prof in release debug; do
    candidate="$GROUP_ROOT/sentin8-cli/target/$prof/sentin8-cli"
    if [[ -x "$candidate" ]]; then CLI_BIN="$candidate"; break; fi
  done
fi
if [[ -z "$CLI_BIN" || ! -x "$CLI_BIN" ]]; then
  echo "ERROR: sentin8-cli not found (set SENTIN8_CLI_BIN or build the CLI)." >&2
  exit 1
fi

# ── Step 1: infra reset (the only destructive path in the tree) ─────────
DESTROY="$GROUP_ROOT/sentin8-cli/scripts/dev-destroy.sh"
if [[ ! -x "$DESTROY" ]]; then
  echo "ERROR: $DESTROY not found - the infra reset is owned by the CLI repo." >&2
  exit 1
fi
SENTIN8_DEV=1 "$DESTROY"

# ── Step 2: re-enroll every service fragment ────────────────────────────
# Mirrors the group Makefile's ENROLL_PATHS: every repo in the GROUP that
# declares service-registration.json. Enrollment bootstraps the virgin
# database first (bootstrap-if-needed gate), so no separate step is needed.
ENROLL_PATHS=()
for d in "$GROUP_ROOT"/sentin8-*/; do
  [[ -f "$d/service-registration.json" ]] && ENROLL_PATHS+=("${d%/}")
done
if [[ ${#ENROLL_PATHS[@]} -eq 0 ]]; then
  echo "ERROR: no service-registration.json fragments under $GROUP_ROOT - nothing to enroll." >&2
  exit 1
fi

# Enrollment runs each service binary with --print-registration, so the
# build output dirs must be discoverable (the group Makefile exports the
# same colon-separated chain as SENTIN8_CAPTAIN_BINARY_PREFIX).
BINARY_PREFIX=""
for d in "$GROUP_ROOT"/sentin8-*/; do
  for prof in debug release; do
    [[ -d "$d/target/$prof" ]] || continue
    BINARY_PREFIX="${BINARY_PREFIX:+$BINARY_PREFIX:}${d%/}/target/$prof"
  done
done

echo "[reset-db] enrolling ${#ENROLL_PATHS[@]} service fragment(s) ..."
SENTIN8_CAPTAIN_BINARY_PREFIX="$BINARY_PREFIX" \
  "$CLI_BIN" vertical enroll "${ENROLL_PATHS[@]}"

echo "[reset-db] database reset and every platform fragment enrolled."