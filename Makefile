# SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
# SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
# SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
# SPDX-License-Identifier: Apache-2.0

# Makefile — sentin8-e2e (e2e repo, RS §4.5)
#
# Self-contained dev controls for THIS e2e. Sources the root .env for
# fleet env, guarantees the dev infra, and uses an ABSOLUTE
# SENTIN8_CAPTAIN_BINARY_PREFIX (cwd-independent — RS §4.5.1-1).
SHELL := /bin/bash

.PHONY: help install test test-ui test-cli report clean

help: ## Show this help
	@echo "sentin8-e2e (Playwright e2e)"
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## pnpm install (frozen lockfile)
	@pnpm install --frozen-lockfile

test: ## Headless e2e (max-failures=1)
	@pnpm run test

test-ui: ## UI suites, headed
	@pnpm run test:ui

test-cli: ## CLI suites
	@pnpm run test:cli

report: ## Open the Playwright HTML report
	@pnpm exec playwright show-report

clean: ## Remove node_modules + reports + run artifacts
	@rm -rf node_modules test-results playwright-report
	@rm -rf .run .run/logs .tmp
