import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["test/integration/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 120_000,
		// Integration tests share a Docker container keyed by compose project
		// name (oas-test). Running files in parallel causes one file's
		// afterAll (containerDown) to tear down the container the other
		// file is still using. Force single-threaded execution.
		//
		// fileParallelism alone wasn't enough in vitest 4 — poolOptions
		// with singleThread is what actually serializes.
		fileParallelism: false,
		pool: "threads",
		poolOptions: {
			threads: {
				singleThread: true,
			},
		},
		sequence: {
			concurrent: false,
		},
	},
});
