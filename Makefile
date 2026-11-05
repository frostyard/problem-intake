# The verify, check and ci triad (core ADR-0044). CI job `ci` runs `make ci`.
NODE_MAJOR := $(shell node -p "process.versions.node.split('.')[0]" 2>/dev/null)

.PHONY: verify check ci

verify:
	@if ! command -v node >/dev/null 2>&1; then echo "FAIL: make verify requires Node.js 24 (mise install) and make"; exit 1; fi
	@if [ "$(NODE_MAJOR)" = "" ] || [ "$(NODE_MAJOR)" -lt 24 ]; then echo "FAIL: make verify requires Node.js 24 or later (found: $$(node --version 2>/dev/null || echo missing)); run mise install"; exit 1; fi
	@if ! command -v npm >/dev/null 2>&1; then echo "FAIL: make verify requires npm"; exit 1; fi
	@if [ ! -f package-lock.json ]; then echo "FAIL: package-lock.json is missing"; exit 1; fi
	@if [ ! -x node_modules/.bin/wrangler ] || [ ! -x node_modules/.bin/vitest ] || [ ! -x node_modules/.bin/tsc ]; then echo "FAIL: dependencies are not installed; run npm ci"; exit 1; fi
	node scripts/check-corrections.mjs

check: verify
	npm run check

ci: check
	@if [ -n "$(BASE)" ]; then node scripts/check-corrections.mjs --base "$(BASE)"; fi
