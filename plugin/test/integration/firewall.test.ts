import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { isDockerAvailable, isImageBuilt, containerExec, containerExecRoot } from "./helpers";

const SKIP = !isDockerAvailable() || !isImageBuilt();

const FW = "/usr/local/bin/init-firewall.sh";
const CONTAINER = "oas-test-sandbox";
// A domain we feed via OAS_ALLOWED_DOMAINS (the plugin tier) and expect to reach;
// example.com is an IANA-reserved, always-resolvable host that returns 200.
const ALLOWED_DOMAIN = "example.com";
// A resolvable host that is NOT on the allowlist, so it is reachable only with
// the firewall off — the negative / control probe.
const BLOCKED_DOMAIN = "example.org";

/**
 * Apply the firewall as root with a plugin-tier domain injected into this exec's
 * environment. init-firewall.sh reads OAS_ALLOWED_DOMAINS from its own process
 * env, so `-e` injects a [plugin] entry without recreating the shared container.
 * Throws if the apply fails (e.g. baseline domains can't be resolved → no egress).
 */
function applyFirewall(domains: string): string {
	return execSync(`docker exec -i -e OAS_ALLOWED_DOMAINS=${domains} ${CONTAINER} ${FW}`, {
		stdio: "pipe",
		timeout: 30000,
	})
		.toString()
		.trim();
}

/** True if the container can curl `url` as the agent (subject to the firewall). */
function reachable(url: string): boolean {
	try {
		containerExec(`curl -fsS -m 8 -o /dev/null ${url}`);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(SKIP)("Container: firewall (Stage 8)", () => {
	// Whether a full firewall apply succeeded — i.e. baseline domains resolved,
	// which requires real outbound egress. Egress-dependent probes skip when false
	// so a no-egress environment doesn't produce false failures.
	let egressOk = false;

	beforeAll(() => {
		try {
			const out = applyFirewall(ALLOWED_DOMAIN);
			egressOk = /Firewall active/.test(out);
		} catch {
			egressOk = false;
		}
	});

	afterAll(() => {
		// Always restore an open network so later test files (and a developer's
		// next run against the shared container) aren't left firewalled.
		try {
			containerExecRoot(`${FW} --disable`);
		} catch {
			/* best effort */
		}
	});

	// ── 8.3: extras file is readable by the agent but not writable ──
	// These are pure container-side checks (no DNS / egress needed).
	it("8.3 firewall-extras.txt is world-readable by the agent", () => {
		const body = containerExec("cat /etc/oas/firewall-extras.txt");
		expect(body).toContain("firewall allowlist");
	});

	it("8.3 firewall-extras.txt is not writable by the agent (read-only mount)", () => {
		expect(() =>
			containerExec("sh -c 'echo evil.example >> /etc/oas/firewall-extras.txt'"),
		).toThrow();
	});

	// ── enable / disable / status transitions ──
	it("reports enabled after a successful apply, disabled after --disable", (ctx) => {
		if (!egressOk) return ctx.skip();
		expect(containerExecRoot(`${FW} --status`)).toBe("enabled");
		expect(containerExecRoot(`${FW} --disable`)).toContain("Firewall disabled");
		expect(containerExecRoot(`${FW} --status`)).toBe("disabled");
		// Re-apply so the egress probes below run against an enabled firewall.
		applyFirewall(ALLOWED_DOMAIN);
		expect(containerExecRoot(`${FW} --status`)).toBe("enabled");
	});

	// ── 8.4: --list-sources tags each entry by origin ──
	it("8.4 --list-sources tags baseline and plugin entries", (ctx) => {
		if (!egressOk) return ctx.skip();
		const sources = containerExecRoot(`${FW} --list-sources`);
		expect(sources).toContain("[baseline]");
		// example.com was injected via OAS_ALLOWED_DOMAINS → [plugin] tier.
		expect(sources).toMatch(/\[plugin\s*\].*example\.com/);
		// [file] tier shares the same add_entry path but needs a non-empty
		// firewall-extras.txt (a tracked, comments-only file); asserting it would
		// require polluting the repo, so it stays a manual check (8.3 reference).
	});

	// ── 8.2 / 8.6: egress is restricted to the allowlist, restored when off ──
	it("8.2 allows an allowlisted domain and blocks a non-allowlisted one", (ctx) => {
		if (!egressOk) return ctx.skip();
		expect(reachable(`https://${ALLOWED_DOMAIN}`)).toBe(true);
		expect(reachable(`https://${BLOCKED_DOMAIN}`)).toBe(false);
	});

	it("8.6 restores full egress when the firewall is disabled", (ctx) => {
		if (!egressOk) return ctx.skip();
		containerExecRoot(`${FW} --disable`);
		expect(reachable(`https://${BLOCKED_DOMAIN}`)).toBe(true);
	});
});
