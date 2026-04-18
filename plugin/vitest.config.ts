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
	},
});
