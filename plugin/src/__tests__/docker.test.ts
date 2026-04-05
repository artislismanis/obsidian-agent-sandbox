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

	describe("parseIsRunning", () => {
		it("returns true when output contains running state", () => {
			const output = '{"Name":"pkm-1","State":"running","Status":"Up 2 minutes"}';
			expect(DockerManager.parseIsRunning(output)).toBe(true);
		});

		it("returns false for empty output", () => {
			expect(DockerManager.parseIsRunning("")).toBe(false);
		});

		it("returns false when container is exited", () => {
			const output = '{"Name":"pkm-1","State":"exited","Status":"Exited (0) 2 minutes ago"}';
			expect(DockerManager.parseIsRunning(output)).toBe(false);
		});

		it("returns true when any service is running in multi-line output", () => {
			const output = [
				'{"Name":"db-1","State":"exited","Status":"Exited"}',
				'{"Name":"pkm-1","State":"running","Status":"Up"}',
			].join("\n");
			expect(DockerManager.parseIsRunning(output)).toBe(true);
		});
	});
});
