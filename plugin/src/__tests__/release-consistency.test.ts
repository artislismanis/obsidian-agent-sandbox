/**
 * QA plan 11.5 — manifest.json ↔ versions.json ↔ package.json consistency.
 *
 * BRAT installs the version named in manifest.json and looks up its
 * minAppVersion in versions.json; a drift between the three files makes BRAT
 * install a stale build or refuse to install. This was a manual release check;
 * it is a pure data comparison, so it lives here and gates every CI run.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, "../..");
const REPO_ROOT = resolve(PLUGIN_DIR, "..");

function readText(abs: string): string {
	return readFileSync(abs, "utf-8");
}

function readJson(rel: string): Record<string, unknown> {
	return JSON.parse(readText(resolve(PLUGIN_DIR, rel)));
}

describe("release artifact consistency (QA 11.5)", () => {
	const manifest = readJson("manifest.json") as {
		version: string;
		minAppVersion: string;
	};
	const versions = readJson("versions.json") as Record<string, string>;
	const pkg = readJson("package.json") as { version: string };

	it("package.json version matches manifest.json version", () => {
		expect(pkg.version).toBe(manifest.version);
	});

	it("versions.json has an entry for the current manifest version", () => {
		expect(Object.keys(versions)).toContain(manifest.version);
	});

	it("versions.json[manifest.version] matches manifest.minAppVersion", () => {
		expect(versions[manifest.version]).toBe(manifest.minAppVersion);
	});

	it("every versions.json key is a valid semver and every value a valid minAppVersion", () => {
		const semver = /^\d+\.\d+\.\d+$/;
		for (const [version, minApp] of Object.entries(versions)) {
			expect(version, `version key "${version}"`).toMatch(semver);
			expect(minApp, `minAppVersion for ${version}`).toMatch(semver);
		}
	});

	// Obsidian's community store fetches manifest.json + versions.json from the
	// repo root, not plugin/. version-bump.mjs mirrors them there; these guard
	// against a hand-edit to plugin/ that forgets to re-sync the root copies.
	it("repo-root manifest.json is byte-identical to plugin/manifest.json", () => {
		expect(readText(resolve(REPO_ROOT, "manifest.json"))).toBe(
			readText(resolve(PLUGIN_DIR, "manifest.json")),
		);
	});

	it("repo-root versions.json is byte-identical to plugin/versions.json", () => {
		expect(readText(resolve(REPO_ROOT, "versions.json"))).toBe(
			readText(resolve(PLUGIN_DIR, "versions.json")),
		);
	});
});
