import { describe, it, expect } from "vitest";
import { DockerManager } from "../docker";

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
