import { describe, it, expect } from "vitest";
import { DockerManager } from "../docker";

describe("DockerManager", () => {
	describe("run rejects when composePath is empty", () => {
		it("throws when compose path is not configured", async () => {
			const docker = new DockerManager(() => ({
				dockerMode: "wsl",
				composePath: "",
				wslDistro: "Ubuntu",
			}));
			await expect(docker.start()).rejects.toThrow("Docker Compose path not configured");
		});
	});

	describe("probeStatus rejects when composePath is empty", () => {
		it("throws when compose path is not configured", async () => {
			const docker = new DockerManager(() => ({
				dockerMode: "wsl",
				composePath: "",
				wslDistro: "Ubuntu",
			}));
			await expect(docker.probeStatus()).rejects.toThrow(
				"Docker Compose path not configured",
			);
		});
	});

	describe("ensureWslReady", () => {
		it("is a no-op for local docker mode", async () => {
			const docker = new DockerManager(() => ({
				dockerMode: "local",
				composePath: "/opt/project",
				wslDistro: "Ubuntu",
			}));
			await expect(docker.ensureWslReady()).resolves.toBeUndefined();
		});

		it("throws on invalid distro name", async () => {
			const docker = new DockerManager(() => ({
				dockerMode: "wsl",
				composePath: "/opt/project",
				wslDistro: "Bad Name",
			}));
			await expect(docker.ensureWslReady()).rejects.toThrow("Invalid WSL distribution name");
		});
	});

	describe("parseIsRunning", () => {
		it("returns true when output contains running state", () => {
			const output = '{"Name":"oas-sandbox-1","State":"running","Status":"Up 2 minutes"}';
			expect(DockerManager.parseIsRunning(output)).toBe(true);
		});

		it("returns false for empty output", () => {
			expect(DockerManager.parseIsRunning("")).toBe(false);
		});

		it("returns false when container is exited", () => {
			const output =
				'{"Name":"oas-sandbox-1","State":"exited","Status":"Exited (0) 2 minutes ago"}';
			expect(DockerManager.parseIsRunning(output)).toBe(false);
		});

		it("returns true when any service is running in multi-line output", () => {
			const output = [
				'{"Name":"db-1","State":"exited","Status":"Exited"}',
				'{"Name":"oas-sandbox-1","State":"running","Status":"Up"}',
			].join("\n");
			expect(DockerManager.parseIsRunning(output)).toBe(true);
		});

		it("returns true for JSON-array form emitted by newer compose", () => {
			const output = '[{"Name":"oas-sandbox-1","State":"running","Status":"Up"}]';
			expect(DockerManager.parseIsRunning(output)).toBe(true);
		});

		it("does not false-positive when 'running' appears only inside another field", () => {
			const output = '{"Name":"my-running-task","State":"exited","Status":"Exited (0)"}';
			expect(DockerManager.parseIsRunning(output)).toBe(false);
		});
	});

	describe("parseIsRunning JSON error handling", () => {
		// Pre-fix, a malformed JSON-array envelope returned false silently.
		// Now it logs a warn and returns false — the test pins that the
		// return contract is unchanged so callers downstream still treat
		// drift as "stopped".

		it("returns false for malformed JSON array (and now logs internally)", () => {
			const output = '[{"Name":"oas-sandbox-1","State":"running"';
			expect(DockerManager.parseIsRunning(output)).toBe(false);
		});

		it("still returns true for valid array form", () => {
			const output = '[{"Name":"oas-sandbox-1","State":"running","Status":"Up"}]';
			expect(DockerManager.parseIsRunning(output)).toBe(true);
		});
	});

	describe("envSpec validators (hand-edited data.json defense)", () => {
		// Settings UI validates each field at save time, but hand-edited
		// data.json can carry invalid values through. The envSpec validators
		// in docker.ts are the second line of defense — `start()`'s run()
		// pipeline throws before any subprocess is spawned.

		it("start() throws on invalid memoryFileName (path-traversal)", async () => {
			const docker = new DockerManager(() => ({
				dockerMode: "local",
				composePath: "/opt/project",
				wslDistro: "Ubuntu",
				memoryFileName: "../../etc/passwd",
			}));
			await expect(docker.start()).rejects.toThrow(/memory file name|Invalid memory/i);
		});

		it("start() throws on invalid memoryFileName (slash)", async () => {
			const docker = new DockerManager(() => ({
				dockerMode: "local",
				composePath: "/opt/project",
				wslDistro: "Ubuntu",
				memoryFileName: "sub/memory.json",
			}));
			await expect(docker.start()).rejects.toThrow(/memory file name|Invalid memory/i);
		});

		it("start() throws on invalid ttydBindAddress (non-IPv4)", async () => {
			const docker = new DockerManager(() => ({
				dockerMode: "local",
				composePath: "/opt/project",
				wslDistro: "Ubuntu",
				ttydBindAddress: "0.0.0.0:80:80",
			}));
			await expect(docker.start()).rejects.toThrow(/bind address|Invalid ttyd/i);
		});
	});
});
