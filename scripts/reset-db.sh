#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
# SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
# SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
# SPDX-License-Identifier: Apache-2.0
# ── sentin8 platform e2e DB reset helper ────────────────────────────────
#
# Resets the database and re-enrolls the vertical registry.
# Usage: ./scripts/reset-db.sh

set -eu

cd "$(dirname "$0")/.."

# Reset the database
SENTIN8_REPO_ROOT="${SENTIN8_REPO_ROOT:-$(cd ../.. && pwd)}" \
  "${SENTIN8_REPO_ROOT}/sentin8/target/release/sentin8-cli" db reset \
  --sql-dirs="${SENTIN8_REPO_ROOT}/bank8/services/*/sql,${SENTIN8_REPO_ROOT}/hotel8/services/*/sql"

# Re-enroll the platform registry
"${SENTIN8_REPO_ROOT}/sentin8/target/release/sentin8-cli" vertical enroll \
  "${SENTIN8_REPO_ROOT}/sentin8/vertical-registry.json"

# Re-enroll vertical registries (bank8, hotel8)
for registry in "${SENTIN8_REPO_ROOT}/bank8/vertical-registry.json" \
                "${SENTIN8_REPO_ROOT}/hotel8/vertical-registry.json"; do
  if [[ -f "$registry" ]]; then
    "${SENTIN8_REPO_ROOT}/sentin8/target/release/sentin8-cli" vertical enroll "$registry"
  fi
done

echo "[reset-db] Database reset and registries enrolled."