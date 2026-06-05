import { describe, it, expect } from "vitest";
import { DockerManager, parseDockerNetworkMasq, parseSsListeningPorts } from "../docker";

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
		// Malformed JSON-array envelopes must return false (callers treat
		// drift as "stopped") while logging the parse failure.

		it("returns false for malformed JSON array (and now logs internally)", () => {
			const output = '[{"Name":"oas-sandbox-1","State":"running"';
			expect(DockerManager.parseIsRunning(output)).toBe(false);
		});

		it("still returns true for valid array form", () => {
			const output = '[{"Name":"oas-sandbox-1","State":"running","Status":"Up"}]';
			expect(DockerManager.parseIsRunning(output)).toBe(true);
		});
	});

	describe("envSpec validators (hand-edited data.json defence)", () => {
		// Settings UI validates each field at save time, but hand-edited
		// data.json can carry invalid values through. The envSpec validators
		// in docker.ts are the second line of defence - `start()`'s run()
		// pipeline throws before any subprocess is spawned.

		it("start() throws on invalid memoryFileName (path-traversal)", async () => {
			const docker = new DockerManager(() => ({
				dockerMode: "local",
				composePath: "/opt/project",
				wslDistro: "Ubuntu",
				vaultPath: "/home/test/vault",
				writeDir: "agent-workspace",
				memoryFileName: "../../etc/passwd",
			}));
			await expect(docker.start()).rejects.toThrow(/memory file name|Invalid memory/i);
		});

		it("start() throws on invalid memoryFileName (slash)", async () => {
			const docker = new DockerManager(() => ({
				dockerMode: "local",
				composePath: "/opt/project",
				wslDistro: "Ubuntu",
				vaultPath: "/home/test/vault",
				writeDir: "agent-workspace",
				memoryFileName: "sub/memory.json",
			}));
			await expect(docker.start()).rejects.toThrow(/memory file name|Invalid memory/i);
		});

		it("start() throws on invalid ttydBindAddress (non-IPv4)", async () => {
			const docker = new DockerManager(() => ({
				dockerMode: "local",
				composePath: "/opt/project",
				wslDistro: "Ubuntu",
				vaultPath: "/home/test/vault",
				writeDir: "agent-workspace",
				ttydBindAddress: "0.0.0.0:80:80",
			}));
			await expect(docker.start()).rejects.toThrow(/bind address|Invalid ttyd/i);
		});
	});
});

describe("parseSsListeningPorts", () => {
	it("returns matching port from typical ss -tlnH output", () => {
		const stdout = [
			"LISTEN 0 128 127.0.0.1:7681 0.0.0.0:*",
			"LISTEN 0 128 0.0.0.0:22    0.0.0.0:*",
		].join("\n");
		expect(parseSsListeningPorts(stdout, [7681])).toEqual([7681]);
	});

	it("returns empty when requested port is not listening", () => {
		const stdout = "LISTEN 0 128 127.0.0.1:22 0.0.0.0:*\n";
		expect(parseSsListeningPorts(stdout, [7681])).toEqual([]);
	});

	it("returns multiple matching ports, sorted", () => {
		const stdout = [
			"LISTEN 0 128 0.0.0.0:7681 0.0.0.0:*",
			"LISTEN 0 128 0.0.0.0:8080 0.0.0.0:*",
			"LISTEN 0 128 0.0.0.0:22   0.0.0.0:*",
		].join("\n");
		expect(parseSsListeningPorts(stdout, [8080, 7681])).toEqual([7681, 8080]);
	});

	it("handles IPv6 addresses ([::]:port)", () => {
		const stdout = "LISTEN 0 128 [::]:7681 [::]:*\n";
		expect(parseSsListeningPorts(stdout, [7681])).toEqual([7681]);
	});

	it("handles wildcard addresses (*:port)", () => {
		const stdout = "LISTEN 0 128 *:7681 *:*\n";
		expect(parseSsListeningPorts(stdout, [7681])).toEqual([7681]);
	});

	it("handles CRLF line endings from Windows piping", () => {
		const stdout = "LISTEN 0 128 127.0.0.1:7681 0.0.0.0:*\r\n";
		expect(parseSsListeningPorts(stdout, [7681])).toEqual([7681]);
	});

	it("returns empty on empty stdout", () => {
		expect(parseSsListeningPorts("", [7681])).toEqual([]);
	});
});

describe("parseDockerNetworkMasq", () => {
	const KEY = "com.docker.network.bridge.enable_ip_masquerade";

	it("returns true when value is the string 'true'", () => {
		expect(parseDockerNetworkMasq(`{"${KEY}":"true"}`)).toBe(true);
	});

	it("returns false when value is the string 'false'", () => {
		expect(parseDockerNetworkMasq(`{"${KEY}":"false"}`)).toBe(false);
	});

	it("returns true when options object is empty (Docker default)", () => {
		expect(parseDockerNetworkMasq("{}")).toBe(true);
	});

	it("returns true when the MASQ key is absent (Docker default)", () => {
		expect(parseDockerNetworkMasq('{"com.docker.network.bridge.name":"docker0"}')).toBe(true);
	});

	it("returns true on malformed JSON (defensive: caller stays on no-recreate path)", () => {
		expect(parseDockerNetworkMasq("not json at all")).toBe(true);
		expect(parseDockerNetworkMasq('{"unterminated":')).toBe(true);
	});

	it("returns true when JSON parses to null (no options)", () => {
		expect(parseDockerNetworkMasq("null")).toBe(true);
	});

	it("returns true when JSON parses to a non-object (array/number)", () => {
		expect(parseDockerNetworkMasq("[]")).toBe(true);
		expect(parseDockerNetworkMasq("42")).toBe(true);
	});

	it("is case-insensitive on the value string", () => {
		expect(parseDockerNetworkMasq(`{"${KEY}":"TRUE"}`)).toBe(true);
		expect(parseDockerNetworkMasq(`{"${KEY}":"False"}`)).toBe(false);
	});

	it("treats unrecognised values as false (only literal 'true' enables MASQ)", () => {
		// Docker only emits 'true'/'false' strings here; any other shape is
		// abnormal: default to "MASQ disabled" so we recreate the network and
		// let compose write the right opt.
		expect(parseDockerNetworkMasq(`{"${KEY}":""}`)).toBe(false);
		expect(parseDockerNetworkMasq(`{"${KEY}":"1"}`)).toBe(false);
	});
});
