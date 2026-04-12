import { describe, it, expect } from "vitest";
import {
	buildWslCommand,
	buildLocalCommand,
	buildLocalWindowsCommand,
	windowsToWslPath,
} from "../docker";

describe("buildWslCommand", () => {
	it("builds a basic command", () => {
		const cmd = buildWslCommand("/home/user/project", "Ubuntu", "docker compose up -d");
		expect(cmd).toBe(
			"wsl -d Ubuntu -- bash -c \"cd '/home/user/project' && docker compose up -d\"",
		);
	});

	it("escapes single quotes in path for bash", () => {
		const cmd = buildWslCommand("/home/user/it's a test", "Ubuntu", "docker compose up -d");
		expect(cmd).toContain("'\\''");
		expect(cmd).toContain("cd '/home/user/it'\\''s a test'");
	});

	it("escapes double quotes in path for cmd.exe", () => {
		const cmd = buildWslCommand('/home/user/"quoted"', "Ubuntu", "docker compose up -d");
		expect(cmd).toContain('\\"quoted\\"');
		expect(cmd).not.toContain('/"quoted"/');
	});

	it("handles paths with spaces", () => {
		const cmd = buildWslCommand("/home/user/my project", "Ubuntu", "docker compose up -d");
		expect(cmd).toContain("cd '/home/user/my project'");
	});

	it("rejects distro names with spaces", () => {
		expect(() => buildWslCommand("/home/user", "Ubuntu Bad", "docker compose up -d")).toThrow(
			"Invalid WSL distribution name",
		);
	});

	it("rejects distro names with shell metacharacters", () => {
		expect(() => buildWslCommand("/home/user", "Ubuntu&&calc", "docker compose up -d")).toThrow(
			"Invalid WSL distribution name",
		);
	});

	it("rejects empty distro name", () => {
		expect(() => buildWslCommand("/home/user", "", "docker compose up -d")).toThrow(
			"Invalid WSL distribution name",
		);
	});

	it("allows distro names with dots and hyphens", () => {
		const cmd = buildWslCommand("/home/user", "Ubuntu-22.04", "docker compose up -d");
		expect(cmd).toContain("wsl -d Ubuntu-22.04");
	});

	it("allows distro names with underscores", () => {
		const cmd = buildWslCommand("/home/user", "my_distro", "docker compose up -d");
		expect(cmd).toContain("wsl -d my_distro");
	});

	it("includes env vars in the command", () => {
		const cmd = buildWslCommand("/home/user/project", "Ubuntu", "docker compose up -d", {
			PKM_VAULT_PATH: "/mnt/c/Users/foo/vault",
		});
		expect(cmd).toContain("export PKM_VAULT_PATH='/mnt/c/Users/foo/vault'");
		expect(cmd).toContain("&& cd '/home/user/project'");
	});

	it("escapes single quotes in env var values", () => {
		const cmd = buildWslCommand("/home/user/project", "Ubuntu", "docker compose up -d", {
			PKM_VAULT_PATH: "/mnt/c/Users/it's me/vault",
		});
		expect(cmd).toContain("PKM_VAULT_PATH='/mnt/c/Users/it'\\''s me/vault'");
	});

	it("handles env var values with spaces", () => {
		const cmd = buildWslCommand("/home/user/project", "Ubuntu", "docker compose up -d", {
			PKM_VAULT_PATH: "/mnt/c/Users/My User/vault",
		});
		expect(cmd).toContain("PKM_VAULT_PATH='/mnt/c/Users/My User/vault'");
	});

	it("omits env prefix when no env vars provided", () => {
		const cmd = buildWslCommand("/home/user/project", "Ubuntu", "docker compose up -d", {});
		expect(cmd).not.toContain("export");
	});

	it("includes multiple env vars in the command", () => {
		const cmd = buildWslCommand("/home/user/project", "Ubuntu", "docker compose up -d", {
			PKM_VAULT_PATH: "/mnt/c/Users/foo/vault",
			PKM_WRITE_DIR: "agent-workspace",
		});
		expect(cmd).toContain("PKM_VAULT_PATH=");
		expect(cmd).toContain("PKM_WRITE_DIR='agent-workspace'");
	});

	it("includes MEMORY_FILE_NAME env var", () => {
		const cmd = buildWslCommand("/home/user/project", "Ubuntu", "docker compose up -d", {
			MEMORY_FILE_NAME: "memory.json",
		});
		expect(cmd).toContain("MEMORY_FILE_NAME='memory.json'");
	});

	it("includes SUDO_PASSWORD env var when provided", () => {
		const cmd = buildWslCommand("/home/user/project", "Ubuntu", "docker compose up -d", {
			SUDO_PASSWORD: "sandbox",
		});
		expect(cmd).toContain("SUDO_PASSWORD='sandbox'");
	});

	it("escapes single quotes in SUDO_PASSWORD values", () => {
		const cmd = buildWslCommand("/home/user/project", "Ubuntu", "docker compose up -d", {
			SUDO_PASSWORD: "pa's'swd",
		});
		expect(cmd).toContain("SUDO_PASSWORD='pa'\\''s'\\''swd'");
	});
});

describe("buildLocalCommand", () => {
	it("builds a basic command without wsl wrapper", () => {
		const cmd = buildLocalCommand("/opt/project", "docker compose up -d");
		expect(cmd).toBe("bash -c \"cd '/opt/project' && docker compose up -d\"");
		expect(cmd).not.toContain("wsl");
	});

	it("includes env vars", () => {
		const cmd = buildLocalCommand("/opt/project", "docker compose up -d", {
			PKM_VAULT_PATH: "/home/user/vault",
		});
		expect(cmd).toContain("export PKM_VAULT_PATH='/home/user/vault'");
		expect(cmd).toContain("&& cd '/opt/project'");
	});

	it("escapes single quotes in path", () => {
		const cmd = buildLocalCommand("/opt/it's a test", "docker compose up -d");
		expect(cmd).toContain("cd '/opt/it'\\''s a test'");
	});

	it("omits env prefix when no env vars provided", () => {
		const cmd = buildLocalCommand("/opt/project", "docker compose up -d", {});
		expect(cmd).not.toContain("export");
	});

	it("escapes double quotes in path", () => {
		const cmd = buildLocalCommand('/opt/"quoted"', "docker compose up -d");
		expect(cmd).toContain('\\"quoted\\"');
	});

	it("escapes double quotes in env var values", () => {
		const cmd = buildLocalCommand("/opt/project", "docker compose up -d", {
			MY_VAR: 'value with "quotes"',
		});
		expect(cmd).toContain('\\"quotes\\"');
	});
});

describe("buildLocalWindowsCommand", () => {
	it("builds a basic command using cd /d for Windows paths", () => {
		const cmd = buildLocalWindowsCommand(
			"Z:\\GitHubRepos\\obsidian-agent-sandbox\\container",
			"docker compose up -d",
		);
		expect(cmd).toBe(
			'cd /d "Z:\\GitHubRepos\\obsidian-agent-sandbox\\container" && docker compose up -d',
		);
	});

	it("does not use bash wrapper", () => {
		const cmd = buildLocalWindowsCommand("C:\\project", "docker compose up -d");
		expect(cmd).not.toContain("bash");
		expect(cmd).not.toContain("export");
	});

	it("includes env vars using set command", () => {
		const cmd = buildLocalWindowsCommand("C:\\project", "docker compose up -d", {
			PKM_VAULT_PATH: "C:\\Users\\foo\\vault",
		});
		expect(cmd).toContain('set "PKM_VAULT_PATH=C:\\Users\\foo\\vault"');
		expect(cmd).toContain("&& cd /d");
	});

	it("handles multiple env vars", () => {
		const cmd = buildLocalWindowsCommand("C:\\project", "docker compose up -d", {
			PKM_VAULT_PATH: "C:\\Users\\foo\\vault",
			PKM_WRITE_DIR: "agent-workspace",
			TTYD_PORT: "7681",
		});
		expect(cmd).toContain('set "PKM_VAULT_PATH=C:\\Users\\foo\\vault"');
		expect(cmd).toContain('set "PKM_WRITE_DIR=agent-workspace"');
		expect(cmd).toContain('set "TTYD_PORT=7681"');
		expect(cmd).toContain(" && cd /d ");
	});

	it("omits env prefix when no env vars provided", () => {
		const cmd = buildLocalWindowsCommand("C:\\project", "docker compose up -d", {});
		expect(cmd).not.toContain("set");
		expect(cmd).toBe('cd /d "C:\\project" && docker compose up -d');
	});

	it("handles paths with spaces", () => {
		const cmd = buildLocalWindowsCommand(
			"C:\\Users\\My User\\My Project",
			"docker compose up -d",
		);
		expect(cmd).toContain('cd /d "C:\\Users\\My User\\My Project"');
	});

	it("escapes double quotes in path", () => {
		const cmd = buildLocalWindowsCommand('C:\\a "quoted" path', "docker compose up -d");
		expect(cmd).toContain('cd /d "C:\\a ""quoted"" path"');
	});

	it("escapes double quotes in env var values", () => {
		const cmd = buildLocalWindowsCommand("C:\\project", "docker compose up -d", {
			MY_VAR: 'value with "quotes"',
		});
		expect(cmd).toContain('set "MY_VAR=value with ""quotes"""');
	});
});

describe("windowsToWslPath", () => {
	it("converts a standard Windows path", () => {
		expect(windowsToWslPath("C:\\Users\\foo\\vault")).toBe("/mnt/c/Users/foo/vault");
	});

	it("lowercases the drive letter", () => {
		expect(windowsToWslPath("D:\\Data")).toBe("/mnt/d/Data");
	});

	it("handles forward slashes in Windows path", () => {
		expect(windowsToWslPath("C:/Users/foo")).toBe("/mnt/c/Users/foo");
	});

	it("passes through a Unix path unchanged", () => {
		expect(windowsToWslPath("/home/user/vault")).toBe("/home/user/vault");
	});

	it("handles paths with spaces", () => {
		expect(windowsToWslPath("C:\\Users\\My User\\My Vault")).toBe(
			"/mnt/c/Users/My User/My Vault",
		);
	});
});
