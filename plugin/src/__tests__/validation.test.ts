import { describe, it, expect } from "vitest";
import {
	isValidWriteDir,
	isWriteDirInsideVault,
	isValidPrivateHosts,
	isValidMemory,
	isValidCpus,
	isValidPort,
	isValidBindAddress,
	isValidMemoryFileName,
	isValidPathPrefixList,
	isValidSessionName,
	isPathAllowed,
	isPathWithinDir,
} from "../validation";
import { DockerManager } from "../docker";

describe("isValidWriteDir", () => {
	it("rejects '..'", () => expect(isValidWriteDir("..")).toBe(false));
	it("rejects '../escape'", () => expect(isValidWriteDir("../escape")).toBe(false));
	it("rejects '/absolute'", () => expect(isValidWriteDir("/absolute")).toBe(false));
	it("rejects '.'", () => expect(isValidWriteDir(".")).toBe(false));
	it("rejects 'foo/../bar'", () => expect(isValidWriteDir("foo/../bar")).toBe(false));
	it("rejects empty string", () => expect(isValidWriteDir("")).toBe(false));
	it("rejects whitespace-only", () => expect(isValidWriteDir("   ")).toBe(false));
	it("rejects leading-dot hidden dirs", () => expect(isValidWriteDir(".hidden")).toBe(false));
	it("rejects backslash", () => expect(isValidWriteDir("foo\\bar")).toBe(false));
	it("rejects leading backslash", () => expect(isValidWriteDir("\\windows")).toBe(false));
	it("accepts 'agent-workspace'", () => expect(isValidWriteDir("agent-workspace")).toBe(true));
	it("accepts 'subfolder'", () => expect(isValidWriteDir("subfolder")).toBe(true));
	it("accepts 'my-dir'", () => expect(isValidWriteDir("my-dir")).toBe(true));
	it("accepts nested 'a/b/c'", () => expect(isValidWriteDir("a/b/c")).toBe(true));
	it("accepts '@Inbox/agent-workspace'", () =>
		expect(isValidWriteDir("@Inbox/agent-workspace")).toBe(true));
	it("accepts 'foo/bar'", () => expect(isValidWriteDir("foo/bar")).toBe(true));
});

describe("isWriteDirInsideVault", () => {
	const vault = "/vault";
	it("accepts a single segment", () => expect(isWriteDirInsideVault(vault, "agent")).toBe(true));
	it("accepts nested path", () =>
		expect(isWriteDirInsideVault(vault, "@Inbox/agent")).toBe(true));
	it("accepts deeply nested path", () =>
		expect(isWriteDirInsideVault(vault, "a/b/c")).toBe(true));
	it("rejects parent traversal", () =>
		expect(isWriteDirInsideVault(vault, "../escape")).toBe(false));
	it("rejects deep traversal", () =>
		expect(isWriteDirInsideVault(vault, "foo/../../etc")).toBe(false));
	it("rejects absolute path", () =>
		expect(isWriteDirInsideVault(vault, "/etc/passwd")).toBe(false));
	it("rejects empty writeDir", () => expect(isWriteDirInsideVault(vault, "")).toBe(false));
	it("rejects empty vaultPath", () => expect(isWriteDirInsideVault("", "notes")).toBe(false));
});

describe("isValidSessionName", () => {
	// Used in two places: direct tmux exec (kill/rename) and the `session <name>\n`
	// command injected over the ttyd WebSocket on attach. Both reach a bash shell,
	// so rejecting metacharacters here is load-bearing — a hand-edited persisted
	// view-state could otherwise inject arbitrary commands on every Obsidian start.
	it("accepts simple ASCII names", () => expect(isValidSessionName("work")).toBe(true));
	it("accepts digits", () => expect(isValidSessionName("session-1")).toBe(true));
	it("accepts dot", () => expect(isValidSessionName("work.foo")).toBe(true));
	it("accepts underscore", () => expect(isValidSessionName("my_session")).toBe(true));
	it("accepts hyphen", () => expect(isValidSessionName("my-session")).toBe(true));
	it("accepts mixed", () => expect(isValidSessionName("work_1.foo-bar")).toBe(true));
	it("rejects empty", () => expect(isValidSessionName("")).toBe(false));
	it("rejects whitespace", () => expect(isValidSessionName("work session")).toBe(false));
	it("rejects newline (terminal injection)", () =>
		expect(isValidSessionName("work\nrm -rf /")).toBe(false));
	it("rejects semicolon (command separator)", () =>
		expect(isValidSessionName("work; rm -rf $HOME")).toBe(false));
	it("rejects pipe", () => expect(isValidSessionName("work|cat")).toBe(false));
	it("rejects backtick (command substitution)", () =>
		expect(isValidSessionName("work`whoami`")).toBe(false));
	it("rejects dollar (variable expansion)", () =>
		expect(isValidSessionName("work$PATH")).toBe(false));
	it("rejects ampersand (backgrounding)", () =>
		expect(isValidSessionName("work && evil")).toBe(false));
	it("rejects redirect", () => expect(isValidSessionName("work>out")).toBe(false));
	it("rejects glob star", () => expect(isValidSessionName("work*")).toBe(false));
	it("rejects single quote", () => expect(isValidSessionName("work'")).toBe(false));
	it("rejects double quote", () => expect(isValidSessionName('work"')).toBe(false));
	it("rejects slash (path)", () => expect(isValidSessionName("work/foo")).toBe(false));
	it("rejects backslash", () => expect(isValidSessionName("work\\foo")).toBe(false));
});

describe("isValidPrivateHosts", () => {
	it("accepts empty string", () => expect(isValidPrivateHosts("")).toBe(true));
	it("accepts whitespace-only", () => expect(isValidPrivateHosts("  ")).toBe(true));
	it("accepts single IP", () => expect(isValidPrivateHosts("192.168.1.100")).toBe(true));
	it("accepts CIDR /24", () => expect(isValidPrivateHosts("10.0.0.0/24")).toBe(true));
	it("accepts CIDR /8", () => expect(isValidPrivateHosts("10.0.0.0/8")).toBe(true));
	it("accepts CIDR /32", () => expect(isValidPrivateHosts("10.0.0.1/32")).toBe(true));
	it("accepts CIDR /0", () => expect(isValidPrivateHosts("0.0.0.0/0")).toBe(true));
	it("accepts comma-separated IPs", () =>
		expect(isValidPrivateHosts("192.168.1.100, 10.0.0.5")).toBe(true));
	it("accepts mixed IPs and CIDRs", () =>
		expect(isValidPrivateHosts("192.168.1.0/24, 10.0.0.5")).toBe(true));
	it("rejects domain names", () => expect(isValidPrivateHosts("example.com")).toBe(false));
	it("rejects mixed valid/invalid", () =>
		expect(isValidPrivateHosts("192.168.1.1, example.com")).toBe(false));
	it("rejects shell metacharacters", () =>
		expect(isValidPrivateHosts("192.168.1.1; rm -rf /")).toBe(false));
	it("rejects octet > 255", () => expect(isValidPrivateHosts("999.999.999.999")).toBe(false));
	it("rejects 256 in octet", () => expect(isValidPrivateHosts("192.168.1.256")).toBe(false));
	it("rejects CIDR prefix > 32", () => expect(isValidPrivateHosts("10.0.0.0/33")).toBe(false));
	it("rejects leading zeros in octet", () =>
		expect(isValidPrivateHosts("192.168.01.1")).toBe(false));
	it("accepts trailing comma (treated as empty entry, ignored)", () =>
		expect(isValidPrivateHosts("192.168.1.1,")).toBe(true));
});

describe("isValidMemory", () => {
	it("accepts empty string", () => expect(isValidMemory("")).toBe(true));
	it("accepts '4G'", () => expect(isValidMemory("4G")).toBe(true));
	it("accepts '512M'", () => expect(isValidMemory("512M")).toBe(true));
	it("accepts '8g' lowercase", () => expect(isValidMemory("8g")).toBe(true));
	it("accepts '1024K'", () => expect(isValidMemory("1024K")).toBe(true));
	it("accepts '1T' terabytes", () => expect(isValidMemory("1T")).toBe(true));
	it("accepts '2t' lowercase", () => expect(isValidMemory("2t")).toBe(true));
	it("rejects plain number", () => expect(isValidMemory("4096")).toBe(false));
	it("rejects text", () => expect(isValidMemory("abc")).toBe(false));
	it("rejects injection", () => expect(isValidMemory("'; rm -rf /; '")).toBe(false));
	it("rejects decimal", () => expect(isValidMemory("1.5G")).toBe(false));
});

describe("isValidCpus", () => {
	it("accepts empty string", () => expect(isValidCpus("")).toBe(true));
	it("accepts '4'", () => expect(isValidCpus("4")).toBe(true));
	it("accepts '2.5'", () => expect(isValidCpus("2.5")).toBe(true));
	it("accepts '0.5'", () => expect(isValidCpus("0.5")).toBe(true));
	it("rejects text", () => expect(isValidCpus("abc")).toBe(false));
	it("rejects negative", () => expect(isValidCpus("-1")).toBe(false));
	it("rejects injection", () => expect(isValidCpus("4; rm")).toBe(false));
});

describe("isValidBindAddress", () => {
	it("accepts empty string", () => expect(isValidBindAddress("")).toBe(true));
	it("accepts '127.0.0.1'", () => expect(isValidBindAddress("127.0.0.1")).toBe(true));
	it("accepts '0.0.0.0'", () => expect(isValidBindAddress("0.0.0.0")).toBe(true));
	it("accepts '192.168.1.100'", () => expect(isValidBindAddress("192.168.1.100")).toBe(true));
	it("rejects hostname", () => expect(isValidBindAddress("localhost")).toBe(false));
	it("rejects CIDR", () => expect(isValidBindAddress("0.0.0.0/0")).toBe(false));
	it("rejects octet > 255", () => expect(isValidBindAddress("256.0.0.1")).toBe(false));
	it("rejects leading zeros", () => expect(isValidBindAddress("01.02.03.04")).toBe(false));
});

describe("writeDir validation in DockerManager", () => {
	function createDocker(writeDir: string) {
		return new DockerManager(() => ({
			dockerMode: "local" as const,
			composePath: "/opt/project",
			wslDistro: "Ubuntu",
			vaultPath: "/home/test/vault",
			writeDir,
		}));
	}

	it("rejects '..' as writeDir", async () => {
		const docker = createDocker("..");
		await expect(docker.start()).rejects.toThrow("Invalid vault write directory");
	});

	it("rejects '../escape' as writeDir", async () => {
		const docker = createDocker("../escape");
		await expect(docker.start()).rejects.toThrow("Invalid vault write directory");
	});

	it("rejects '/absolute' as writeDir", async () => {
		const docker = createDocker("/absolute");
		await expect(docker.start()).rejects.toThrow("Invalid vault write directory");
	});

	it("rejects '.' as writeDir", async () => {
		const docker = createDocker(".");
		await expect(docker.start()).rejects.toThrow("Invalid vault write directory");
	});

	it("rejects 'foo/../bar' as writeDir", async () => {
		const docker = createDocker("foo/../bar");
		await expect(docker.start()).rejects.toThrow("Invalid vault write directory");
	});
});

describe("DockerManager.isBusy()", () => {
	it("reports not busy initially", () => {
		const docker = new DockerManager(() => ({
			dockerMode: "local" as const,
			composePath: "/opt/project",
			wslDistro: "Ubuntu",
		}));
		expect(docker.isBusy()).toBe(false);
	});
});

describe("isPathWithinDir", () => {
	// isPathWithinDir is the sole gate keeping writeScoped MCP tools inside
	// the configured write directory — see the function comment for the
	// fail-closed rationale on empty dir.
	it("returns false for empty dir (fail-closed)", () => {
		expect(isPathWithinDir("anything", "")).toBe(false);
		expect(isPathWithinDir("foo/bar.md", "  ")).toBe(false);
	});
	it("matches path under dir", () => {
		expect(isPathWithinDir("notes/x.md", "notes")).toBe(true);
		expect(isPathWithinDir("notes/sub/x.md", "notes")).toBe(true);
		expect(isPathWithinDir("agent-workspace/file.md", "agent-workspace")).toBe(true);
		expect(isPathWithinDir("agent-workspace/sub/file.md", "agent-workspace")).toBe(true);
	});
	it("matches the dir itself", () => {
		expect(isPathWithinDir("notes", "notes")).toBe(true);
		expect(isPathWithinDir("agent-workspace", "agent-workspace")).toBe(true);
	});
	it("rejects paths outside the dir", () => {
		expect(isPathWithinDir("other-folder/file.md", "agent-workspace")).toBe(false);
		expect(isPathWithinDir("file.md", "agent-workspace")).toBe(false);
	});
	it("rejects sibling-prefix attack", () => {
		expect(isPathWithinDir("notes-evil/x.md", "notes")).toBe(false);
		expect(isPathWithinDir("agent-workspace-evil/file.md", "agent-workspace")).toBe(false);
		expect(isPathWithinDir("agent-workspacex/file.md", "agent-workspace")).toBe(false);
	});
	it("rejects path traversal with ..", () => {
		expect(isPathWithinDir("agent-workspace/../secret.md", "agent-workspace")).toBe(false);
		expect(isPathWithinDir("agent-workspace/sub/../../secret.md", "agent-workspace")).toBe(
			false,
		);
		expect(isPathWithinDir("agent-workspace/../../../etc/passwd", "agent-workspace")).toBe(
			false,
		);
	});
	it("rejects path traversal in nested paths", () => {
		expect(
			isPathWithinDir("agent-workspace/notes/../../../config.json", "agent-workspace"),
		).toBe(false);
	});
	it("handles leading slash", () => {
		expect(isPathWithinDir("/agent-workspace/file.md", "agent-workspace")).toBe(true);
		expect(isPathWithinDir("/agent-workspace/../secret.md", "agent-workspace")).toBe(false);
	});
	it("handles empty and edge-case paths", () => {
		expect(isPathWithinDir("", "agent-workspace")).toBe(false);
		expect(isPathWithinDir("/", "agent-workspace")).toBe(false);
		expect(isPathWithinDir(".", "agent-workspace")).toBe(false);
		expect(isPathWithinDir("..", "agent-workspace")).toBe(false);
	});
	it("normalises redundant separators and dots", () => {
		expect(isPathWithinDir("agent-workspace/./file.md", "agent-workspace")).toBe(true);
		expect(isPathWithinDir("agent-workspace//file.md", "agent-workspace")).toBe(true);
		expect(isPathWithinDir("./agent-workspace/file.md", "agent-workspace")).toBe(true);
	});
});

describe("isPathAllowed", () => {
	it("allows everything with empty lists", () => {
		expect(isPathAllowed("notes/secret.md", [], [])).toBe(true);
	});

	it("allowlist entry allows matching path", () => {
		expect(isPathAllowed("notes/file.md", ["notes/"], [])).toBe(true);
	});

	it("allowlist entry alone does not block non-matching paths (default-allow)", () => {
		expect(isPathAllowed("private/file.md", ["notes/"], [])).toBe(true);
	});

	it("allowlist restricts non-matching paths when defaultDeny=true", () => {
		expect(isPathAllowed("private/file.md", ["notes/"], [], true)).toBe(false);
	});

	it("blocklist denies matching paths", () => {
		expect(isPathAllowed("private/secret.md", [], ["private/"])).toBe(false);
		expect(isPathAllowed("notes/file.md", [], ["private/"])).toBe(true);
	});

	it("blocklist overrides allowlist when same prefix length (tie → block)", () => {
		// Same-length prefix: .obsidian is both blocked and allowed at the same depth → block wins.
		expect(isPathAllowed("notes/private/x.md", ["notes/"], ["notes/private/"])).toBe(false);
	});

	it("handles nested paths", () => {
		expect(isPathAllowed("notes/sub/deep/file.md", ["notes/"], [])).toBe(true);
	});

	it("allowlist does not match paths with a similar but distinct prefix", () => {
		expect(isPathAllowed("notes-evil/file.md", ["notes/"], [], true)).toBe(false);
	});

	// Most-specific-prefix-wins tests
	it("longer allow beats shorter block", () => {
		// block: .obsidian/ — allow: .obsidian/plugins/x/ — allow wins
		expect(
			isPathAllowed(".obsidian/plugins/x/data.json", [".obsidian/plugins/x/"], [".obsidian"]),
		).toBe(true);
	});

	it("longer block beats shorter allow", () => {
		// allow: notes/ — block: notes/secret/ — block wins
		expect(isPathAllowed("notes/secret/key.md", ["notes"], ["notes/secret"])).toBe(false);
	});

	it("exact tie goes to block", () => {
		// Same prefix length — block wins.
		expect(isPathAllowed("a/b.md", ["a"], ["a"])).toBe(false);
	});

	it("path matching neither list is allowed by default (defaultDeny=false)", () => {
		expect(isPathAllowed("other/file.md", ["notes/"], [])).toBe(true);
	});

	it("path matching neither list is blocked when defaultDeny=true", () => {
		expect(isPathAllowed("other/file.md", ["notes/"], [], true)).toBe(false);
	});

	it("path matching neither list is allowed when both lists are empty", () => {
		expect(isPathAllowed("anything/file.md", [], [])).toBe(true);
	});

	it("path matching neither list is blocked when both lists are empty and defaultDeny=true", () => {
		expect(isPathAllowed("anything/file.md", [], [], true)).toBe(false);
	});
});

describe("isValidPort", () => {
	it("accepts empty (uses compose default)", () => expect(isValidPort("")).toBe(true));
	it("accepts '7681'", () => expect(isValidPort("7681")).toBe(true));
	it("accepts '28080'", () => expect(isValidPort("28080")).toBe(true));
	it("accepts '1' (minimum)", () => expect(isValidPort("1")).toBe(true));
	it("accepts '65535' (maximum)", () => expect(isValidPort("65535")).toBe(true));
	it("rejects '0'", () => expect(isValidPort("0")).toBe(false));
	it("rejects '65536'", () => expect(isValidPort("65536")).toBe(false));
	it("rejects 'abc'", () => expect(isValidPort("abc")).toBe(false));
	it("rejects '-1'", () => expect(isValidPort("-1")).toBe(false));
	it("rejects '80.5'", () => expect(isValidPort("80.5")).toBe(false));
	it("rejects leading zeros", () => expect(isValidPort("0080")).toBe(false));
});

describe("isValidMemoryFileName", () => {
	it("rejects empty", () => expect(isValidMemoryFileName("")).toBe(false));
	it("rejects whitespace-only", () => expect(isValidMemoryFileName("   ")).toBe(false));
	it("rejects '..'", () => expect(isValidMemoryFileName("..")).toBe(false));
	it("rejects path traversal", () => expect(isValidMemoryFileName("../etc/passwd")).toBe(false));
	it("rejects forward slashes", () => expect(isValidMemoryFileName("a/b.json")).toBe(false));
	it("rejects backslashes", () => expect(isValidMemoryFileName("a\\b.json")).toBe(false));
	it("rejects hidden files", () => expect(isValidMemoryFileName(".secret")).toBe(false));
	it("accepts memory.json", () => expect(isValidMemoryFileName("memory.json")).toBe(true));
	it("accepts custom-name.json", () =>
		expect(isValidMemoryFileName("custom-name.json")).toBe(true));
});

describe("isValidPathPrefixList", () => {
	it("accepts empty", () => expect(isValidPathPrefixList("")).toBe(true));
	it("accepts a single prefix", () => expect(isValidPathPrefixList("notes/")).toBe(true));
	it("accepts comma-separated", () =>
		expect(isValidPathPrefixList("notes/, projects/")).toBe(true));
	it("rejects '..' anywhere", () =>
		expect(isValidPathPrefixList("notes/, ../escape")).toBe(false));
	it("rejects leading slash", () => expect(isValidPathPrefixList("/abs")).toBe(false));
	it("rejects backslashes", () => expect(isValidPathPrefixList("a\\b")).toBe(false));
});
