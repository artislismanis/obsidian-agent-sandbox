import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock obsidian before any imports that transitively require it.
// settings.ts (imported via mcp-lifecycle) needs PluginSettingTab and Setting.
vi.mock("obsidian", () => ({
	Notice: class {
		constructor(_msg: string) {}
	},
	Modal: class {},
	PluginSettingTab: class {},
	Setting: class {
		setName() {
			return this;
		}
		setDesc() {
			return this;
		}
		addText() {
			return this;
		}
		addToggle() {
			return this;
		}
		addDropdown() {
			return this;
		}
		addButton() {
			return this;
		}
	},
}));

// Capture constructor args so we can inspect pathFilter without the server running.
let capturedConfig: unknown;
const mockStart = vi.fn(async () => {});
const mockStop = vi.fn(async () => {});
const mockIsRunning = vi.fn(() => true);
const mockGetActivity = vi.fn(() => new Map());
const mockGetToolCount = vi.fn(() => 0);

vi.mock("../mcp-server", () => ({
	ObsidianMcpServer: class {
		constructor(_app: unknown, config: unknown) {
			capturedConfig = config;
		}
		start = mockStart;
		stop = mockStop;
		isRunning = mockIsRunning;
		getActivity = mockGetActivity;
		getToolCount = mockGetToolCount;
	},
}));

// diff-review-modal uses Obsidian Modal — stub it.
vi.mock("../diff-review-modal", () => ({
	DiffReviewModal: class {},
	BatchReviewModal: class {},
}));

import { McpLifecycle } from "../mcp-lifecycle";
import { DEFAULT_SETTINGS } from "../settings";
import type { AgentSandboxSettings } from "../settings";

interface CapturedMcpConfig {
	pathFilter?: {
		allowlist: string[];
		blocklist: string[];
		getWriteDir?: () => string;
	};
	port?: number;
}

function makeLifecycle(overrides: Partial<AgentSandboxSettings> = {}) {
	const settings: AgentSandboxSettings = { ...DEFAULT_SETTINGS, ...overrides };
	const app = {
		vault: { configDir: ".obsidian" },
		workspace: {},
	} as never;
	const lifecycle = new McpLifecycle(app, () => settings, {
		saveSettings: vi.fn(),
		updateTooltip: vi.fn(),
		onActivity: vi.fn(),
		clearActivity: vi.fn(),
		onMcpWrite: vi.fn(),
	});
	return { lifecycle, settings };
}

describe("McpLifecycle.startServer — pathFilter wiring", () => {
	beforeEach(() => {
		capturedConfig = undefined;
		mockStart.mockClear();
		mockStop.mockClear();
		mockIsRunning.mockReturnValue(false);
	});

	it("prepends configDir (.obsidian) to blocklist when mcpPathBlocklist is empty", async () => {
		const { lifecycle } = makeLifecycle({ mcpPathBlocklist: "" });
		await lifecycle.applyEnabled(true);
		const config = capturedConfig as CapturedMcpConfig;
		expect(config.pathFilter?.blocklist[0]).toBe(".obsidian");
		expect(config.pathFilter?.blocklist).toHaveLength(1);
	});

	it("configDir is first, then user-supplied blocklist entries", async () => {
		const { lifecycle } = makeLifecycle({ mcpPathBlocklist: "custom/, private/" });
		await lifecycle.applyEnabled(true);
		const config = capturedConfig as CapturedMcpConfig;
		expect(config.pathFilter?.blocklist).toEqual([".obsidian", "custom/", "private/"]);
	});

	it("allowlist is empty when mcpPathAllowlist is empty string", async () => {
		const { lifecycle } = makeLifecycle({ mcpPathAllowlist: "" });
		await lifecycle.applyEnabled(true);
		const config = capturedConfig as CapturedMcpConfig;
		expect(config.pathFilter?.allowlist).toEqual([]);
	});

	it("allowlist flows through when mcpPathAllowlist is set", async () => {
		const { lifecycle } = makeLifecycle({ mcpPathAllowlist: "notes/, archive/" });
		await lifecycle.applyEnabled(true);
		const config = capturedConfig as CapturedMcpConfig;
		expect(config.pathFilter?.allowlist).toEqual(["notes/", "archive/"]);
	});

	it("pathFilter.getWriteDir returns the current vaultWriteDir setting", async () => {
		const { lifecycle } = makeLifecycle({ vaultWriteDir: "my-workspace" });
		await lifecycle.applyEnabled(true);
		const config = capturedConfig as CapturedMcpConfig;
		expect(config.pathFilter?.getWriteDir?.()).toBe("my-workspace");
	});

	it("invalid mcpPathBlocklist (backslash) disables MCP and does not start server", async () => {
		// backslash is rejected by isValidPathPrefixList
		const { lifecycle } = makeLifecycle({ mcpPathBlocklist: "bad\\path" });
		await lifecycle.applyEnabled(true);
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("invalid mcpPathAllowlist (leading slash) disables MCP and does not start server", async () => {
		// leading slash is rejected by isValidPathPrefixList
		const { lifecycle } = makeLifecycle({ mcpPathAllowlist: "/absolute/path" });
		await lifecycle.applyEnabled(true);
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("port flows through from settings", async () => {
		const { lifecycle } = makeLifecycle({ mcpPort: 29999 });
		await lifecycle.applyEnabled(true);
		const config = capturedConfig as CapturedMcpConfig;
		expect(config.port).toBe(29999);
	});
});

describe("McpLifecycle state delegation", () => {
	beforeEach(() => {
		mockIsRunning.mockReturnValue(false);
		mockGetActivity.mockReturnValue(new Map());
		mockGetToolCount.mockReturnValue(0);
	});

	it("isRunning() returns false before server starts", () => {
		const { lifecycle } = makeLifecycle();
		expect(lifecycle.isRunning()).toBe(false);
	});

	it("getActivity() returns empty map before server starts", () => {
		const { lifecycle } = makeLifecycle();
		expect(lifecycle.getActivity().size).toBe(0);
	});

	it("getToolCount() returns 0 before server starts", () => {
		const { lifecycle } = makeLifecycle();
		expect(lifecycle.getToolCount()).toBe(0);
	});
});

describe("McpLifecycle lifecycle operations", () => {
	beforeEach(() => {
		capturedConfig = undefined;
		mockStart.mockClear();
		mockStop.mockClear();
		mockIsRunning.mockReturnValue(false);
	});

	it("applyEnabled(false) is a no-op when server is not running", async () => {
		const { lifecycle } = makeLifecycle();
		// isRunning() returns false, so applyEnabled(false) should not call stop.
		await lifecycle.applyEnabled(false);
		expect(mockStop).not.toHaveBeenCalled();
	});

	it("restartIfRunning() is a no-op when server is not running", async () => {
		const { lifecycle } = makeLifecycle();
		mockIsRunning.mockReturnValue(false);
		await lifecycle.restartIfRunning();
		expect(mockStop).not.toHaveBeenCalled();
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("shutdown() resolves without error when no server is running", async () => {
		const { lifecycle } = makeLifecycle();
		await expect(lifecycle.shutdown()).resolves.toBeUndefined();
	});

	it("applyEnabled(true) then applyEnabled(true) skips second start (server already running)", async () => {
		const { lifecycle } = makeLifecycle();
		// First call starts the server.
		await lifecycle.applyEnabled(true);
		expect(mockStart).toHaveBeenCalledTimes(1);
		// Now pretend server is running.
		mockIsRunning.mockReturnValue(true);
		mockStart.mockClear();
		// Second applyEnabled(true) should not start again.
		await lifecycle.applyEnabled(true);
		expect(mockStart).not.toHaveBeenCalled();
	});
});
