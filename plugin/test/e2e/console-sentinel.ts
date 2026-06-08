// Console-error sentinel (QA plan 12.7, and the "no red console errors" residual
// on 1.1 / 2.5a). Fetches the browser console log after each e2e test, keeps only
// SEVERE (console.error / uncaught) entries, drops known-benign lines, and fails
// the test on anything left. Wired as an `afterTest` hook in wdio.conf.mts.
//
// `getLogs("browser")` is a Chromedriver capability that returns AND clears the
// buffer, so each afterTest sees only that test's entries (the first test also
// absorbs session-startup noise — allowlist accordingly).
//
// Set OAS_SENTINEL_REPORT=1 to print offenders instead of failing — use this to
// regenerate the allowlist after a deliberate new failure path is added.

// Known-benign SEVERE entries to ignore. Intentionally EMPTY: a full RAW recon
// (OAS_SENTINEL_RAW=1 over every spec) found zero SEVERE console entries — the
// suite's deliberate failure paths (terminals with no ttyd, MCP on an occupied
// port) are handled via the plugin's levelled logger, not console.error, so they
// never reach SEVERE. Do NOT pre-populate this with speculative patterns: a
// broad pattern silently defeats the sentinel and could mask a real regression.
// Add a tight, specific pattern only when a genuinely benign SEVERE is observed
// (regenerate the candidate list with OAS_SENTINEL_REPORT=1).
export const CONSOLE_ALLOWLIST: RegExp[] = [];

interface RawLog {
	level?: string;
	message?: string;
}

/** SEVERE console messages for the just-finished test, minus allowlisted lines. */
export async function collectSevere(browser: WebdriverIO.Browser): Promise<string[]> {
	let logs: RawLog[];
	try {
		logs = (await browser.getLogs("browser")) as RawLog[];
	} catch {
		// Driver without the log endpoint → sentinel is a no-op rather than a
		// spurious failure. (On wdio-obsidian-service/Chromedriver it is present.)
		return [];
	}
	const severe = logs
		.filter((l) => l.level === "SEVERE")
		.map((l) => (l.message ?? "").trim())
		.filter((m) => m.length > 0);
	// OAS_SENTINEL_RAW=1 bypasses the allowlist so a recon run shows every SEVERE
	// entry (used to confirm getLogs is live and to see what the allowlist hides).
	if (process.env.OAS_SENTINEL_RAW) return severe;
	return severe.filter((m) => !CONSOLE_ALLOWLIST.some((re) => re.test(m)));
}
