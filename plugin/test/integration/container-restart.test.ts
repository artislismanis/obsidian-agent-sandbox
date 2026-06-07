import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import {
	containerExec,
	waitForHealth,
	isDockerAvailable,
	isImageBuilt,
	TTYD_PORT,
} from "./helpers";

// QA plan 2.18 — data on a named volume survives a container restart. The
// container itself is ephemeral, but the named volumes (claude-config,
// shell-history, user-config) persist. This writes a marker into the
// shell-history volume, restarts the shared test container, waits for it to come
// back healthy, and asserts the marker is still there.
//
// Uses the shell-history named volume (not /workspace, which is a host bind mount
// that would persist trivially and pollute the repo tree).

const SKIP_NO_IMAGE = !isDockerAvailable() || !isImageBuilt();
const MARKER_PATH = "/home/claude/.shell-history/persist-2p18.txt";

describe.skipIf(SKIP_NO_IMAGE)("Container restart persistence (QA 2.18)", () => {
	it("a file on a named volume survives docker restart", async () => {
		const marker = "oas-persist-marker-2p18";
		containerExec(`sh -c 'echo ${marker} > ${MARKER_PATH}'`);

		// Restart the shared test container and wait for ttyd to answer again.
		execSync("docker restart oas-test-sandbox", { stdio: "pipe", timeout: 60000 });
		await waitForHealth(`http://127.0.0.1:${TTYD_PORT}`, 60000);

		const survived = containerExec(`cat ${MARKER_PATH}`);
		expect(survived).toContain(marker);

		// Cleanup so reruns start clean.
		containerExec(`rm -f ${MARKER_PATH}`);
	});
});
