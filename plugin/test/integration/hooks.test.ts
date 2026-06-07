import { describe, it, expect } from "vitest";
import { isDockerAvailable, isImageBuilt, containerExec } from "./helpers";

const SKIP_NO_IMAGE = !isDockerAvailable() || !isImageBuilt();

const HOOK = "/workspace/.claude/hooks/notify-status.sh";

/**
 * QA 5.5: the status hook must no-op when MCP is off. "MCP off" in the
 * container is simply the absence of OAS_MCP_TOKEN (the plugin omits the env
 * var when mcpEnabled is false), so this needs no container restart - we just
 * run the hook with the token unset and assert it exits 0 silently. The
 * silent-failure contract (a missing token or offline server must never block
 * Claude Code) is what this guards.
 *
 * Each case appends `&& echo OK`, so a non-zero exit drops the marker and makes
 * `docker exec` fail, which makes containerExec throw and the test fail.
 */
describe.skipIf(SKIP_NO_IMAGE)("status hook (QA 5.5)", () => {
	it("is present and executable", () => {
		expect(containerExec(`test -x ${HOOK} && echo OK`)).toBe("OK");
	});

	it("no-ops with no output when the MCP token is absent", () => {
		const out = containerExec(
			`bash -lc 'env -u OAS_MCP_TOKEN bash ${HOOK} awaiting_input && echo OK'`,
		);
		// No token → the hook exits 0 before emitting anything, so stdout is
		// only our marker.
		expect(out).toBe("OK");
	});

	it("no-ops for every wired status when the MCP token is absent", () => {
		for (const status of ["idle", "working", "awaiting_input"]) {
			const out = containerExec(
				`bash -lc 'env -u OAS_MCP_TOKEN bash ${HOOK} ${status} && echo OK'`,
			);
			expect(out).toBe("OK");
		}
	});

	it("exits 0 on an invalid status so it never blocks Claude Code", () => {
		// Invalid status warns on stderr (captured separately by execSync) but
		// must still exit 0; the && marker proves the exit code.
		const out = containerExec(
			`bash -lc 'env -u OAS_MCP_TOKEN bash ${HOOK} bogus-status && echo OK'`,
		);
		expect(out).toBe("OK");
	});
});
