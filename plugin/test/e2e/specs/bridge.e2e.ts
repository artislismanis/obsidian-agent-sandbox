import { browser, expect, $, $$ } from "@wdio/globals";
import { describe, it, before } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import { mcpInitialize, mcpCallTool, mcpRequest, type McpSession } from "../mcp-client";

// Bridge layer — drives the REAL plugin's MCP server (running inside the
// wdio-launched Obsidian) over loopback HTTP and asserts the resulting UI via
// executeObsidian. No container needed for these: the MCP tools act on the
// Obsidian-open vault, and the wdio worker can reach the host-bound server.
//
// Settings don't persist in this harness (the service loads the plugin
// out-of-tree), so each run configures the MCP server at runtime via
// executeObsidian + restartMcpIfRunning, which re-reads settings on start.

const BRIDGE_MCP_PORT = 39080; // distinct from the 28080 default to avoid clashes
const BRIDGE_MCP_TOKEN = "bridge-e2e-token";

interface BridgeOpts {
	navigate?: boolean;
	manage?: boolean;
	vaultWrites?: "scoped" | "reviewed" | "full";
	/** Override the auth token (defaults to BRIDGE_MCP_TOKEN). Used by 3.6. */
	token?: string;
}

/** Configure and (re)start the plugin's MCP server in the running Obsidian. */
async function startBridgeMcp(opts: BridgeOpts = {}): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, { port, token, navigate, manage, vaultWrites }) => {
			const plugin = (
				app as unknown as {
					plugins: {
						plugins: Record<
							string,
							{
								settings: Record<string, unknown>;
								restartMcpIfRunning: () => Promise<void>;
							}
						>;
					};
				}
			).plugins.plugins["agent-sandbox"];
			const s = plugin.settings;
			s.mcpEnabled = true;
			s.mcpPort = port;
			s.mcpToken = token;
			s.mcpBindAddress = "127.0.0.1";
			if (navigate !== undefined) s.mcpTierNavigate = navigate;
			if (manage !== undefined) s.mcpTierManage = manage;
			if (vaultWrites !== undefined) s.mcpVaultWrites = vaultWrites;
			await plugin.restartMcpIfRunning();
		},
		{
			port: BRIDGE_MCP_PORT,
			token: opts.token ?? BRIDGE_MCP_TOKEN,
			navigate: opts.navigate,
			manage: opts.manage,
			vaultWrites: opts.vaultWrites,
		},
	);
}

/** Flip the MCP server on/off via the plugin's lifecycle (not a restart). 3.7/5.4. */
async function setMcpEnabled(enabled: boolean): Promise<void> {
	await browser.executeObsidian(async ({ app }, on) => {
		const plugin = (
			app as unknown as {
				plugins: {
					plugins: Record<
						string,
						{
							settings: Record<string, unknown>;
							applyMcpEnabled: (e: boolean) => Promise<void>;
						}
					>;
				};
			}
		).plugins.plugins["agent-sandbox"];
		plugin.settings.mcpEnabled = on;
		await plugin.applyMcpEnabled(on);
	}, enabled);
}

interface Capabilities {
	enabledTiers: string[];
	alwaysOn: string[];
	escalations: string[];
	toolsByTier: Record<string, string[]>;
}

/** Call mcp_capabilities and parse its JSON body. */
async function mcpCapabilities(session: McpSession): Promise<Capabilities> {
	const res = await mcpCallTool(session, "mcp_capabilities", {});
	expect(res.isError).toBe(false);
	return JSON.parse(res.text) as Capabilities;
}

/** Flatten capabilities.toolsByTier into a flat set of registered tool names. */
function toolNames(caps: Capabilities): Set<string> {
	return new Set(Object.values(caps.toolsByTier).flat());
}

function mcpServerRunning(): Promise<boolean> {
	return browser.executeObsidian(({ app }) => {
		const plugin = (
			app as unknown as {
				plugins: { plugins: Record<string, { mcpLifecycle?: { isRunning(): boolean } }> };
			}
		).plugins.plugins["agent-sandbox"];
		return plugin.mcpLifecycle?.isRunning() ?? false;
	});
}

function activeFilePath(): Promise<string | null> {
	return browser.executeObsidian(({ app }) => app.workspace.getActiveFile()?.path ?? null);
}

describe("Bridge C0: MCP server runs inside wdio-Obsidian", function () {
	let session: McpSession;

	before(async function () {
		await obsidianPage.resetVault();
		await startBridgeMcp({ navigate: true });
	});

	// The gate for the whole bridge layer: if the plugin's MCP server can't
	// listen inside Electron, none of C1/C2 is reachable here.
	it("starts the plugin's MCP HTTP server", async function () {
		await browser.waitUntil(async () => await mcpServerRunning(), {
			timeout: 5000,
			timeoutMsg: "plugin MCP server did not start in wdio-Obsidian",
		});
	});

	it("accepts an authenticated initialize over loopback", async function () {
		session = await mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN);
		expect(session.sessionId).not.toBe("");
	});

	// QA plan 3.5: a navigate-tier tool call changes the active tab in Obsidian.
	it("drives a real UI effect: vault_open changes the active file", async function () {
		const result = await mcpCallTool(session, "vault_open", { path: "Notes.md" });
		expect(result.text).toContain("Opened Notes.md");

		await browser.waitUntil(async () => (await activeFilePath()) === "Notes.md", {
			timeout: 5000,
			timeoutMsg: "active file did not become Notes.md after vault_open",
		});
	});
});

// ── C1: review modals driven end-to-end (no container) ──────────────────────
// A reviewed-tier write blocks on the diff modal. We fire the tool call WITHOUT
// awaiting, drive the modal via wdio, then await the call to assert the outcome.

async function readFile(path: string): Promise<string | null> {
	return browser.executeObsidian(async ({ app }, p) => {
		const f = app.vault.getFileByPath(p);
		return f ? await app.vault.read(f) : null;
	}, path);
}

/** Wait until Obsidian's metadata cache has resolved >= `count` backlinks to `target`. */
async function waitForBacklinks(target: string, count: number): Promise<void> {
	await browser.waitUntil(
		async () => {
			const n = await browser.executeObsidian(({ app }, t) => {
				const resolved = (
					app.metadataCache as unknown as {
						resolvedLinks: Record<string, Record<string, number>>;
					}
				).resolvedLinks;
				return Object.keys(resolved).filter((src) => resolved[src]?.[t]).length;
			}, target);
			return n >= count;
		},
		{ timeout: 10000, timeoutMsg: `backlinks to ${target} did not resolve` },
	);
}

describe("Bridge C1: review modals (reviewed tier, no container)", function () {
	let session: McpSession;
	const FILE = "Notes.md";
	const BASE = "line1\nline2\nline3\nline4\nline5\n";

	before(async function () {
		await obsidianPage.resetVault({ [FILE]: BASE });
		await startBridgeMcp({ vaultWrites: "reviewed", manage: true });
		session = await mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN);
	});

	// QA plan 4.1: content diff modal renders +/- lines; Approve applies the change.
	it("4.1 content diff — Approve applies the edit", async function () {
		await obsidianPage.resetVault({ [FILE]: BASE });
		const next = "line1\nline2\nEDITED\nline4\nline5\n";
		const call = mcpCallTool(session, "vault_modify_reviewed", { path: FILE, content: next });

		const approve = $("button=Approve");
		await approve.waitForExist({ timeout: 10000 });
		await expect($("pre.sandbox-diff-pre")).toBeDisplayed();
		expect((await $$(".sandbox-diff-line-added").getElements()).length).toBeGreaterThan(0);
		expect((await $$(".sandbox-diff-line-removed").getElements()).length).toBeGreaterThan(0);
		await approve.click();

		const res = await call;
		expect(res.isError).toBe(false);
		expect(res.text).toContain("Modified Notes.md");
		expect(await readFile(FILE)).toBe(next);
	});

	// QA plan 4.1 + 4.5: Reject leaves the file untouched and tells the agent.
	it("4.5 content diff — Reject leaves the file untouched", async function () {
		await obsidianPage.resetVault({ [FILE]: BASE });
		const before = await readFile(FILE);
		const call = mcpCallTool(session, "vault_modify_reviewed", {
			path: FILE,
			content: "SHOULD NOT APPLY\n",
		});

		const reject = $("button=Reject");
		await reject.waitForExist({ timeout: 10000 });
		await reject.click();

		const res = await call;
		expect(res.isError).toBe(true);
		expect(res.text).toContain("rejected by user");
		expect(await readFile(FILE)).toBe(before);
	});

	// QA plan 4.6: a large diff still renders and stays operable. This is a
	// render-without-error guard (modal appears, both sides of a ~500-line diff
	// are present, Approve applies) - NOT a latency assertion. CI timing is too
	// noisy to assert "<1s / scrolls smoothly", which stays a manual check.
	it("4.6 large (~500-line) diff renders without error and approves", async function () {
		const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n") + "\n";
		const bigEdited =
			Array.from({ length: 500 }, (_, i) => `line ${i} edited`).join("\n") + "\n";
		await obsidianPage.resetVault({ [FILE]: big });
		const call = mcpCallTool(session, "vault_modify_reviewed", {
			path: FILE,
			content: bigEdited,
		});

		const approve = $("button=Approve");
		await approve.waitForExist({ timeout: 15000 });
		await expect($("pre.sandbox-diff-pre")).toBeDisplayed();
		expect((await $$(".sandbox-diff-line-added").getElements()).length).toBeGreaterThan(100);
		expect((await $$(".sandbox-diff-line-removed").getElements()).length).toBeGreaterThan(100);
		await approve.click();

		const res = await call;
		expect(res.isError).toBe(false);
		expect(await readFile(FILE)).toBe(bigEdited);
	});

	// QA plan 4.2: frontmatter set shows a JSON diff modal; Approve writes the FM.
	it("4.2 frontmatter diff — Approve sets the property", async function () {
		await obsidianPage.resetVault({ [FILE]: BASE });
		const call = mcpCallTool(session, "vault_frontmatter_set_reviewed", {
			path: FILE,
			property: "tags",
			value: ["a", "b"],
		});

		const approve = $("button=Approve");
		await approve.waitForExist({ timeout: 10000 });
		await expect($(".modal-title")).toHaveText(expect.stringContaining("Set frontmatter"));
		await approve.click();

		const res = await call;
		expect(res.isError).toBe(false);
		const content = await readFile(FILE);
		expect(content).toContain("tags:");
		expect(content).toContain("- a");
		expect(content).toContain("- b");
	});

	// QA plan 4.3: rename modal lists the affected backlinks; Approve renames the
	// file and rewrites the links.
	// QA plan 4.3: the rename modal lists the backlinks that will be rewritten.
	// We assert the modal renders "Review: Rename file" with the exact affected
	// set, then Reject (leaving files untouched). The unique value of 4.3 is the
	// affected-links rendering — the actual apply, app.fileManager.renameFile,
	// does not settle under the headless wdio harness (vault.modify / frontmatter
	// applies return fine; only renameFile hangs here), so approving it would
	// stall. The apply path itself is exercised by the unit suite.
	it("4.3 rename — affected-links list lists the backlinks", async function () {
		await obsidianPage.resetVault({
			"old.md": "# Old\n",
			"linker1.md": "See [[old]]\n",
			"linker2.md": "Also [[old]]\n",
		});
		await waitForBacklinks("old.md", 2);

		const call = mcpCallTool(session, "vault_rename", { path: "old.md", name: "new" });
		const reject = $("button=Reject");
		await reject.waitForExist({ timeout: 10000 });
		await expect($(".modal-title")).toHaveText(expect.stringContaining("Rename file"));
		const affected = (await $$(".diff-review-affected-list li").getElements()).length;
		expect(affected).toBe(2);
		await reject.click();

		const res = await call;
		expect(res.isError).toBe(true);
		expect(res.text).toContain("rejected by user");
		expect(await readFile("old.md")).not.toBeNull();
		expect(await readFile("new.md")).toBeNull();
	});

	// QA plan 4.4: batch modal lists each match with a checkbox; unchecking one
	// excludes it from "Approve selected".
	it("4.4 batch review — uncheck one, approve the rest", async function () {
		await obsidianPage.resetVault({
			"batch/a.md": "# A\n",
			"batch/b.md": "# B\n",
			"batch/c.md": "# C\n",
		});
		const call = mcpCallTool(session, "vault_batch_frontmatter", {
			folder: "batch",
			property: "status",
			value: "review",
			dryRun: false,
		});

		await browser.waitUntil(
			async () => (await $$(".batch-review-row").getElements()).length === 3,
			{ timeout: 10000, timeoutMsg: "batch review modal did not list 3 rows" },
		);
		const rows = await $$(".batch-review-row").getElements();
		const skipped = await rows[0].$("span").getText();
		await rows[0].$("input[type='checkbox']").click(); // uncheck the first
		await $("button=Approve selected").click();

		const res = await call;
		expect(res.isError).toBe(false);
		for (const p of ["batch/a.md", "batch/b.md", "batch/c.md"]) {
			const content = (await readFile(p)) ?? "";
			if (p === skipped) expect(content).not.toContain("status: review");
			else expect(content).toContain("status: review");
		}
	});
});

function sandboxPillText(): Promise<string> {
	return browser.executeObsidian(() => {
		const items = Array.from(document.querySelectorAll(".status-bar-item"));
		return items.find((e) => e.textContent?.includes("Sandbox"))?.textContent ?? "";
	});
}

describe("Bridge C1: agent activity badge (agent tier, no container)", function () {
	let session: McpSession;

	before(async function () {
		await obsidianPage.resetVault();
		await startBridgeMcp({});
		session = await mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN);
	});

	// QA plan 3.11: an awaiting-input agent status adds the 🔔 badge to the
	// sandbox status-bar pill, and it clears when the session goes idle.
	it("3.11 agent_status_set awaiting_input toggles the status-bar bell", async function () {
		const BELL = "🔔";

		const res = await mcpCallTool(session, "agent_status_set", {
			status: "awaiting_input",
			sessionName: "work",
		});
		expect(res.isError).toBe(false);

		await browser.waitUntil(async () => (await sandboxPillText()).includes(BELL), {
			timeout: 5000,
			timeoutMsg: "status-bar bell did not appear after awaiting_input",
		});

		await mcpCallTool(session, "agent_status_set", { status: "idle", sessionName: "work" });
		await browser.waitUntil(async () => !(await sandboxPillText()).includes(BELL), {
			timeout: 5000,
			timeoutMsg: "status-bar bell did not clear after idle",
		});
	});

	// QA plan 5.2: an idle session never raises the attention badge; only an
	// awaiting-input session does, and clearing it drops the badge even while
	// another idle session remains. (The running-state tooltip that names the
	// waiting sessions only composes when the container is running, so the
	// bell — count > 0 — is the observable surface here.)
	it("5.2 idle sessions don't raise the badge; awaiting ones do", async function () {
		const BELL = "🔔";

		// An idle session alone: no bell.
		await mcpCallTool(session, "agent_status_set", { status: "idle", sessionName: "research" });
		await browser.waitUntil(async () => !(await sandboxPillText()).includes(BELL), {
			timeout: 5000,
			timeoutMsg: "bell should not appear for an idle-only session",
		});

		// A second session goes awaiting: bell appears (research stays idle).
		await mcpCallTool(session, "agent_status_set", {
			status: "awaiting_input",
			sessionName: "work",
		});
		await browser.waitUntil(async () => (await sandboxPillText()).includes(BELL), {
			timeout: 5000,
			timeoutMsg: "bell did not appear when one session became awaiting_input",
		});

		// The awaiting session goes idle: bell clears even though research is
		// still present (and idle) — proving only awaiting sessions count.
		await mcpCallTool(session, "agent_status_set", { status: "idle", sessionName: "work" });
		await browser.waitUntil(async () => !(await sandboxPillText()).includes(BELL), {
			timeout: 5000,
			timeoutMsg: "bell did not clear when the only awaiting session went idle",
		});
	});

	// QA plan 5.4: toggling the MCP server off clears any awaiting-input state
	// (clearActivity → setAttention(0)), so the badge disappears.
	it("5.4 toggling MCP off clears the awaiting-input badge", async function () {
		const BELL = "🔔";

		await mcpCallTool(session, "agent_status_set", {
			status: "awaiting_input",
			sessionName: "work",
		});
		await browser.waitUntil(async () => (await sandboxPillText()).includes(BELL), {
			timeout: 5000,
			timeoutMsg: "bell did not appear before MCP toggle-off",
		});

		await setMcpEnabled(false);
		await browser.waitUntil(async () => !(await sandboxPillText()).includes(BELL), {
			timeout: 5000,
			timeoutMsg: "bell did not clear after MCP was toggled off",
		});

		// Restore for any later specs sharing this Obsidian instance.
		await startBridgeMcp({});
		session = await mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN);
	});
});

// ── Permission-tier matrix (QA 3.1 / 3.2) ───────────────────────────────────
// Tier filtering is list-time: buildTools(...).filter(t => enabledTiers.has).
// So a cell's permission config is fully observable in the registered tool set,
// which mcp_capabilities reports. This replaces the Claude-led capability sweep
// (docs/mcp-capability-test.md) with a deterministic gate; that doc remains only
// as the LLM-behaviour sanity check.

interface MatrixCell {
	name: string;
	navigate: boolean;
	manage: boolean;
	vaultWrites: "scoped" | "reviewed" | "full";
}

const MATRIX_CELLS: MatrixCell[] = [
	{ name: "A: read-only (all gated off)", navigate: false, manage: false, vaultWrites: "scoped" },
	{ name: "B: navigate only", navigate: true, manage: false, vaultWrites: "scoped" },
	{ name: "C: manage only", navigate: false, manage: true, vaultWrites: "scoped" },
	{ name: "D: navigate + manage", navigate: true, manage: true, vaultWrites: "scoped" },
	{ name: "E: reviewed writes", navigate: true, manage: true, vaultWrites: "reviewed" },
	{ name: "F: full writes", navigate: true, manage: true, vaultWrites: "full" },
];

describe("Bridge C1: permission-tier matrix (3.1/3.2)", function () {
	for (const cell of MATRIX_CELLS) {
		it(`gates tiers + tools for cell ${cell.name}`, async function () {
			await startBridgeMcp({
				navigate: cell.navigate,
				manage: cell.manage,
				vaultWrites: cell.vaultWrites,
			});
			const session = await mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN);
			const caps = await mcpCapabilities(session);
			const tiers = new Set(caps.enabledTiers);
			const tools = toolNames(caps);

			// Always-on tiers + a representative always-on tool from each.
			for (const t of ["read", "writeScoped", "agent"]) expect(tiers.has(t)).toBe(true);
			expect(tools.has("vault_read")).toBe(true); // read
			expect(tools.has("vault_modify")).toBe(true); // writeScoped (suffix "")
			expect(tools.has("agent_status_set")).toBe(true); // agent

			// Gated tiers present iff toggled, with a representative gated tool.
			expect(tiers.has("navigate")).toBe(cell.navigate);
			expect(tools.has("vault_open")).toBe(cell.navigate);
			expect(tiers.has("manage")).toBe(cell.manage);
			expect(tools.has("vault_rename")).toBe(cell.manage);

			// Write mode selects mutually-exclusive reviewed / full tool variants.
			const reviewed = cell.vaultWrites === "reviewed";
			const full = cell.vaultWrites === "full";
			expect(tiers.has("writeReviewed")).toBe(reviewed);
			expect(tools.has("vault_modify_reviewed")).toBe(reviewed);
			expect(tiers.has("writeVault")).toBe(full);
			expect(tools.has("vault_modify_anywhere")).toBe(full);

			// Cross-check the capability report against the raw tools/list: the
			// flattened registered set must match what tools/list advertises.
			const { envelope } = await mcpRequest(session, "tools/list", {});
			const listed = new Set(
				(
					(envelope as { result?: { tools?: Array<{ name: string }> } }).result?.tools ??
					[]
				).map((t) => t.name),
			);
			expect(tools.has("vault_open")).toBe(listed.has("vault_open"));
			expect(tools.has("vault_rename")).toBe(listed.has("vault_rename"));
			expect(tools.has("vault_modify_reviewed")).toBe(listed.has("vault_modify_reviewed"));
		});
	}
});

// ── MCP auth lifecycle (QA 3.6 / 3.7) ───────────────────────────────────────
// Mirrors the integration suite's auth tests, but against the REAL plugin
// server. The bridge client disables keep-alive precisely so a server restarted
// on the same port never reuses a dead socket.

describe("Bridge C1: MCP auth lifecycle (3.6/3.7)", function () {
	const OLD = "bridge-token-old";
	const NEW = "bridge-token-new";

	before(async function () {
		await obsidianPage.resetVault();
	});

	// QA plan 3.6: rotating the token rejects connections using the old token;
	// the new token works.
	it("3.6 token rotation rejects the old token, accepts the new", async function () {
		await startBridgeMcp({ token: OLD });
		const session = await mcpInitialize(BRIDGE_MCP_PORT, OLD);
		expect((await mcpCallTool(session, "vault_list", {})).isError).toBe(false);

		await startBridgeMcp({ token: NEW });
		await expect(mcpInitialize(BRIDGE_MCP_PORT, OLD)).rejects.toThrow(/HTTP 40[13]/);
		const fresh = await mcpInitialize(BRIDGE_MCP_PORT, NEW);
		expect(fresh.sessionId).not.toBe("");
	});

	// QA plan 3.7: turning the MCP server off mid-session drops the listener, so
	// a reconnect fails; re-enabling restores access.
	it("3.7 turning MCP off drops connections; re-enabling restores them", async function () {
		await startBridgeMcp({ token: BRIDGE_MCP_TOKEN });
		await mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN);

		await setMcpEnabled(false);
		// Listener gone → connection refused (or rejected before any HTTP status).
		await expect(mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN)).rejects.toThrow();

		await setMcpEnabled(true);
		const restored = await mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN);
		expect(restored.sessionId).not.toBe("");
	});
});

// ── Cache invalidation on live edit (QA 3.8) ────────────────────────────────
// VaultCache caches the link graph (and tag/property counts), not file content,
// and clears wholesale on metadataCache's "resolved" event. vault_backlinks
// routes through that cached graph, so a live link edit must surface on the
// next call once the cache has resolved the new backlink.

describe("Bridge C1: cache invalidation (3.8)", function () {
	let session: McpSession;

	before(async function () {
		await obsidianPage.resetVault({
			"target.md": "# Target\n",
			"linker1.md": "See [[target]]\n",
		});
		await startBridgeMcp({});
		session = await mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN);
	});

	it("3.8 vault_backlinks reflects a live link added after the first read", async function () {
		await waitForBacklinks("target.md", 1);
		const first = await mcpCallTool(session, "vault_backlinks", { path: "target.md" });
		expect(first.isError).toBe(false);
		expect(first.text).toContain("linker1.md");
		expect(first.text).not.toContain("linker2.md");

		// Add a second backlink live in Obsidian → fires "resolved" → cache clears.
		await browser.executeObsidian(async ({ app }) => {
			await app.vault.create("linker2.md", "Also [[target]]\n");
		});
		await waitForBacklinks("target.md", 2);

		const second = await mcpCallTool(session, "vault_backlinks", { path: "target.md" });
		expect(second.isError).toBe(false);
		expect(second.text).toContain("linker1.md");
		expect(second.text).toContain("linker2.md");
	});

	// QA plan 3.8 (content freshness): vault_read is a non-cached path, so an
	// edit made live in Obsidian must surface on the very next read. The
	// backlinks test above covers the cached graph; this covers raw content.
	it("3.8 vault_read returns content edited live in Obsidian (version A → version B)", async function () {
		await browser.executeObsidian(async ({ app }) => {
			await app.vault.create("freshness.md", "version A\n");
		});

		const first = await mcpCallTool(session, "vault_read", { path: "freshness.md" });
		expect(first.isError).toBe(false);
		expect(first.text).toContain("version A");

		await browser.executeObsidian(async ({ app }) => {
			const f = app.vault.getFileByPath("freshness.md");
			if (f) await app.vault.modify(f, "version B\n");
		});

		await browser.waitUntil(
			async () => {
				const r = await mcpCallTool(session, "vault_read", { path: "freshness.md" });
				return !r.isError && r.text.includes("version B");
			},
			{ timeout: 5000, timeoutMsg: "vault_read never reflected the live edit (version B)" },
		);
	});
});

// ── Concurrent tool calls (QA 3.9) ──────────────────────────────────────────
// Fire a burst of read-tier calls in parallel and assert they all resolve
// cleanly. The burst stays well under the read rate limit (60/min per tool) so
// the limiter never trips it into flakiness.

describe("Bridge C1: concurrent tool calls (3.9)", function () {
	let session: McpSession;

	before(async function () {
		await obsidianPage.resetVault({
			"a.md": "alpha\n",
			"b.md": "alpha beta\n",
			"c.md": "beta\n",
		});
		await startBridgeMcp({});
		session = await mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN);
	});

	it("3.9 resolves a parallel burst of tool calls without error", async function () {
		const calls = [
			mcpCallTool(session, "vault_search", { query: "alpha" }),
			mcpCallTool(session, "vault_search", { query: "beta" }),
			mcpCallTool(session, "vault_list", {}),
			mcpCallTool(session, "vault_read", { path: "a.md" }),
			mcpCallTool(session, "vault_read", { path: "b.md" }),
			mcpCallTool(session, "vault_read", { path: "c.md" }),
		];
		const results = await Promise.all(calls);
		for (const r of results) expect(r.isError).toBe(false);
	});
});

// ── Read-tier fidelity: real scorer + metadata graph (Tranche 3) ────────────
// Unit tests stub prepareSimpleSearch / prepareFuzzySearch and hand-populate
// resolvedLinks, so the real Obsidian search ranking and live graph resolution
// are exercised only here. This is fidelity coverage, not manual-QA conversion.

describe("Bridge C1: read-tier fidelity (search + graph)", function () {
	let session: McpSession;

	before(async function () {
		await obsidianPage.resetVault({
			"alpha.md": "alpha alpha alpha\n",
			"mixed.md": "alpha beta\n",
			"hub.md": "[[alpha]] and [[mixed]]\n",
		});
		await startBridgeMcp({});
		session = await mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN);
	});

	it("vault_search matches real content and excludes non-matching files", async function () {
		const res = await mcpCallTool(session, "vault_search", { query: "beta" });
		expect(res.isError).toBe(false);
		// The real simple-search scorer matches both files whose body has "beta"
		// and excludes the one that doesn't (alpha.md), proving real content
		// matching rather than the canned scorer used in unit tests.
		expect(res.text).toContain("mixed.md");
		expect(res.text).not.toContain("alpha.md");
	});

	it("vault_search_fuzzy ranks with the real fuzzy scorer", async function () {
		const res = await mcpCallTool(session, "vault_search_fuzzy", { query: "alpha" });
		expect(res.isError).toBe(false);
		expect(res.text).toContain("alpha.md");
	});

	it("vault_backlinks resolves against the real metadata graph", async function () {
		await waitForBacklinks("alpha.md", 1);
		const res = await mcpCallTool(session, "vault_backlinks", { path: "alpha.md" });
		expect(res.isError).toBe(false);
		expect(res.text).toContain("hub.md");
	});

	it("vault_graph_neighborhood traverses the real link graph", async function () {
		await waitForBacklinks("alpha.md", 1);
		const res = await mcpCallTool(session, "vault_graph_neighborhood", {
			path: "hub.md",
			depth: 1,
		});
		expect(res.isError).toBe(false);
		// hub links out to both alpha and mixed.
		expect(res.text).toContain("alpha.md");
		expect(res.text).toContain("mixed.md");
	});
});

// ── Live terminal tab activity prefix (QA 5.1) ──────────────────────────────
// composeTabTitle is unit-tested; the residual is the LIVE repaint of an open
// terminal leaf's tab title when a Claude session changes state. agent_status_set
// routes to ActivityUi → live leaf.view.setActivityPrefix → getDisplayText()
// recomposes "⚙/✓/❓ Session: <name>". We open a real terminal leaf (no container
// needed — the WebSocket attach fails harmlessly), drive the status over MCP,
// and read getDisplayText() off the leaf's view.

async function openTerminal(name: string): Promise<void> {
	await browser.executeObsidian(async ({ app }, sessionName: string) => {
		const plugin = (
			app as unknown as {
				plugins: {
					plugins: Record<
						string,
						{ activateTerminalView: (n?: string) => Promise<unknown> }
					>;
				};
			}
		).plugins.plugins["agent-sandbox"];
		await plugin.activateTerminalView(sessionName);
	}, name);
	await browser.pause(300);
}

async function terminalTitle(sessionName: string): Promise<string | null> {
	return browser.executeObsidian(({ app }, name: string) => {
		const leaves = (
			app as unknown as {
				workspace: {
					getLeavesOfType: (t: string) => Array<{
						view: {
							getSessionName?: () => string | null;
							getDisplayText?: () => string;
						};
					}>;
				};
			}
		).workspace.getLeavesOfType("agent-sandbox-terminal-view");
		const leaf = leaves.find((l) => l.view.getSessionName?.() === name);
		return leaf?.view.getDisplayText?.() ?? null;
	}, sessionName);
}

describe("Bridge C1: live terminal tab activity prefix (5.1)", function () {
	let session: McpSession;

	before(async function () {
		await obsidianPage.resetVault();
		await startBridgeMcp({});
		session = await mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN);
		await openTerminal("work");
	});

	after(async function () {
		await browser.executeObsidian(({ app }) => {
			(
				app as unknown as {
					workspace: { getLeavesOfType: (t: string) => Array<{ detach: () => void }> };
				}
			).workspace
				.getLeavesOfType("agent-sandbox-terminal-view")
				.forEach((l) => l.detach());
		});
	});

	async function expectPrefix(status: string, symbol: string): Promise<void> {
		await mcpCallTool(session, "agent_status_set", { status, sessionName: "work" });
		await browser.waitUntil(
			async () => {
				const title = await terminalTitle("work");
				return (
					title !== null && title.startsWith(symbol) && title.includes("Session: work")
				);
			},
			{
				timeout: 5000,
				timeoutMsg: `tab title never showed the ${status} prefix (${symbol})`,
			},
		);
	}

	it("5.1 working → ⚙, awaiting_input → ❓, idle → ✓ on the live terminal tab", async function () {
		await expectPrefix("working", "⚙");
		await expectPrefix("awaiting_input", "❓");
		await expectPrefix("idle", "✓");
	});
});
