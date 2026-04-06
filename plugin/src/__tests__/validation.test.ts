import { describe, it, expect } from "vitest";
import { isValidWriteDir, DockerManager } from "../docker";

describe("isValidWriteDir", () => {
	it("rejects '..'", () => expect(isValidWriteDir("..")).toBe(false));
	it("rejects '../escape'", () => expect(isValidWriteDir("../escape")).toBe(false));
	it("rejects '/absolute'", () => expect(isValidWriteDir("/absolute")).toBe(false));
	it("rejects '.'", () => expect(isValidWriteDir(".")).toBe(false));
	it("rejects 'foo/../bar'", () => expect(isValidWriteDir("foo/../bar")).toBe(false));
	it("accepts 'claude-workspace'", () => expect(isValidWriteDir("claude-workspace")).toBe(true));
	it("accepts 'subfolder'", () => expect(isValidWriteDir("subfolder")).toBe(true));
	it("accepts 'my-dir'", () => expect(isValidWriteDir("my-dir")).toBe(true));
});

describe("writeDir validation in DockerManager", () => {
	function createDocker(writeDir: string) {
		return new DockerManager(() => ({
			dockerMode: "local" as const,
			composePath: "/opt/project",
			wslDistro: "Ubuntu",
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
