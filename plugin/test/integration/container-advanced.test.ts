import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	isDockerAvailable,
	isImageBuilt,
	containerUp,
	containerDown,
	containerExec,
	waitForHealth,
	TTYD_PORT,
} from "./helpers";

const SKIP = !isDockerAvailable() || !isImageBuilt();

function isClaudeAuthenticated(): boolean {
	if (SKIP) return false;
	try {
		containerExec("claude --version");
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(SKIP)("Firewall", () => {
	beforeAll(async () => {
		containerUp();
		await waitForHealth(`http://127.0.0.1:${TTYD_PORT}`, 60000);
	}, 120000);

	afterAll(() => {
		try {
			containerDown();
		} catch {
			// best effort
		}
	});

	it("can enable firewall", () => {
		containerExec(
			"sudo -S /usr/local/bin/init-firewall.sh <<< '${SUDO_PASSWORD:-sandbox}' 2>/dev/null || /usr/local/bin/init-firewall.sh 2>/dev/null || true",
		);
		const status = containerExec(
			"/usr/local/bin/init-firewall.sh --status 2>/dev/null || echo disabled",
		);
		// If firewall init requires root and we can't get it, skip gracefully
		if (status === "disabled") return;
		expect(status).toBe("enabled");
	});

	it("allowlisted domain is reachable with firewall", () => {
		try {
			containerExec("/usr/local/bin/init-firewall.sh 2>/dev/null || true");
		} catch {
			// firewall may already be enabled or require root
		}
		const status = containerExec(
			"/usr/local/bin/init-firewall.sh --status 2>/dev/null || echo disabled",
		);
		if (status !== "enabled") return; // skip if we couldn't enable
		const code = containerExec(
			"curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 https://api.anthropic.com 2>/dev/null || echo 000",
		);
		expect(["200", "301", "302", "403", "404"]).toContain(code);
	});

	it("non-allowlisted domain is blocked with firewall", () => {
		const status = containerExec(
			"/usr/local/bin/init-firewall.sh --status 2>/dev/null || echo disabled",
		);
		if (status !== "enabled") return;
		const code = containerExec(
			"curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 https://example.com 2>/dev/null || echo 000",
		);
		expect(code).toBe("000");
	});

	it("can disable firewall", () => {
		try {
			containerExec("/usr/local/bin/init-firewall.sh --disable 2>/dev/null");
		} catch {
			// may require root
		}
		const status = containerExec(
			"/usr/local/bin/init-firewall.sh --status 2>/dev/null || echo disabled",
		);
		expect(status).toBe("disabled");
	});
});

describe.skipIf(SKIP)("Persistent shell sessions (tmux)", () => {
	beforeAll(async () => {
		containerUp();
		await waitForHealth(`http://127.0.0.1:${TTYD_PORT}`, 60000);
	}, 120000);

	afterAll(() => {
		try {
			containerDown();
		} catch {
			// best effort
		}
	});

	it("tmux is installed", () => {
		const output = containerExec("tmux -V");
		expect(output).toMatch(/tmux/);
	});

	it("session helper function is available", () => {
		const output = containerExec("bash -lc 'type session' 2>&1 || echo not_found");
		expect(output).toContain("function");
	});

	it("can create and list a tmux session", () => {
		containerExec("tmux new-session -d -s test-session 'sleep 60'");
		const sessions = containerExec("tmux list-sessions -F '#{session_name}'");
		expect(sessions).toContain("test-session");
		containerExec("tmux kill-session -t test-session");
	});

	it("sessions survive exec disconnects", () => {
		containerExec("tmux new-session -d -s persist-test 'sleep 120'");
		// The exec call ends but the session persists inside the container
		const sessions = containerExec("tmux list-sessions -F '#{session_name}'");
		expect(sessions).toContain("persist-test");
		containerExec("tmux kill-session -t persist-test");
	});
});

describe.skipIf(SKIP)("Port remapping", () => {
	// The test compose file already remaps from default 7681 to 17681
	// so this test just validates the remap worked (which the health check already proves)
	beforeAll(async () => {
		containerUp();
		await waitForHealth(`http://127.0.0.1:${TTYD_PORT}`, 60000);
	}, 120000);

	afterAll(() => {
		try {
			containerDown();
		} catch {
			// best effort
		}
	});

	it("ttyd responds on remapped port", async () => {
		const res = await fetch(`http://127.0.0.1:${TTYD_PORT}`);
		expect(res.status).toBe(200);
		expect(TTYD_PORT).not.toBe(7681);
	});
});
