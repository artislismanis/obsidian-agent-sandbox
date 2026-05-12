import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// Unit tests live in src/__tests__/. Integration tests live in test/
		// and have their own vitest.integration.config.ts (Docker-dependent,
		// uses globalSetup). Keep them on separate configs so `npm run test`
		// is fast and doesn't need Docker.
		include: ["src/**/*.test.ts"],
		coverage: {
			// v8 provider — faster than istanbul, ships with Node, no babel.
			provider: "v8",
			reporter: ["text", "html", "json-summary"],
			// Exclude Obsidian-API-bound modules that are exercised by e2e
			// rather than unit tests (see plugin/CLAUDE.md "Testing" — these
			// would require mocking Plugin/ItemView/WorkspaceLeaf).
			exclude: [
				"src/__tests__/**",
				"src/main.ts",
				"src/settings.ts",
				"src/terminal-view.ts",
				"src/modals.ts",
				"src/session-ui.ts",
				"src/status-bar.ts",
				"src/diff-review-modal.ts",
				"src/obsidian-internals.ts",
				"src/view-types.ts",
			],
			// Thresholds: a floor that fails CI if coverage regresses below
			// today's measured level (with a ~1pp buffer for noise). Bump up
			// when the codebase improves; don't drop without justification.
			// Today: lines 75.03 / funcs 73.19 / branches 63.79 / stmts 73.17.
			// Round 9 added defensive error paths (audit-log debug log on
			// failure, clipboard try/catch, debouncedSave try/catch, multiple
			// pathFilter early-exits, info-leak guards in link-graph,
			// VaultCache LRU, response-truncation budget reservation, CSRF
			// guards, applyTemplater error reporting). Those are catch blocks
			// and edge cases that are hard to exercise from unit tests without
			// contorting the mocks. The structural improvements outweigh the
			// metric dip; add targeted coverage over time. See docs/testing.md.
			thresholds: {
				lines: 74,
				functions: 72,
				branches: 62,
				statements: 72,
			},
		},
	},
});
