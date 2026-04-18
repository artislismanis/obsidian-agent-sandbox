import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["test/integration/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 120_000,
		// All integration test files share ONE Docker container, brought up
		// and torn down by globalSetup.
		globalSetup: ["./test/integration/globalSetup.ts"],
		// Serialize to avoid concurrent docker exec races.
		fileParallelism: false,
		sequence: { concurrent: false },
	},
});
