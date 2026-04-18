/**
 * Global setup/teardown for the integration test suite.
 *
 * Runs ONCE before all test files, once after. Brings up the shared
 * test container so individual test files don't manage lifecycle.
 */

import {
	isDockerAvailable,
	isImageBuilt,
	containerUp,
	containerDown,
	seedClaudeAuth,
	waitForHealth,
	TTYD_PORT,
} from "./helpers";

export default async function globalSetup(): Promise<() => Promise<void>> {
	if (!isDockerAvailable()) {
		process.stderr.write("[integration] Docker unavailable — tests will skip\n");
		return async () => {};
	}
	if (!isImageBuilt()) {
		process.stderr.write("[integration] oas-sandbox image not built — tests will skip\n");
		return async () => {};
	}

	process.stderr.write("[integration] starting test container...\n");
	containerUp();

	const seeded = seedClaudeAuth();
	process.stderr.write(
		seeded
			? "[integration] Claude auth seeded from live oas-claude-config volume\n"
			: "[integration] no live Claude auth to seed (claude-code tests will skip)\n",
	);

	process.stderr.write(`[integration] waiting for ttyd health on port ${TTYD_PORT}...\n`);
	await waitForHealth(`http://127.0.0.1:${TTYD_PORT}`, 60000);
	process.stderr.write("[integration] container healthy, starting tests\n");

	return async () => {
		process.stderr.write("[integration] tearing down test container...\n");
		containerDown();
	};
}
