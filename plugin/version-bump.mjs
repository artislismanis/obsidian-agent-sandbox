/**
 * Sync `manifest.json` and `versions.json` to the version just set in
 * `package.json`. Called automatically by `npm version` via the "version"
 * lifecycle script (see package.json).
 *
 * - manifest.json: update `version` to match package.json.
 * - versions.json: add `{ <new version>: <minAppVersion from manifest> }`.
 *
 * The repo-root `manifest.json` / `versions.json` are generated copies of the
 * `plugin/` originals: Obsidian's community store fetches both from the
 * default-branch repo root (not the GitHub Release), so the monorepo needs
 * them mirrored there. `plugin/` is the source of truth; the root copies are
 * rewritten here on every bump. A release-consistency unit test gates CI
 * against hand-edited drift.
 *
 * Stages the updated files so `npm version`'s commit step includes them.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
	console.error("version-bump: npm_package_version is unset");
	process.exit(1);
}

// Validate the version shape so we don't write garbage into the JSON files.
// npm version normally produces semver-clean strings, but if anything ever
// invokes this script directly with a malformed env var we want to fail
// loudly rather than silently corrupt manifest.json / versions.json.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(targetVersion)) {
	console.error(`version-bump: '${targetVersion}' is not a valid semver string`);
	process.exit(1);
}

// Resolve paths relative to this script's directory rather than CWD so
// invocations like `npm version --prefix plugin <ver>` (cwd = caller) work
// the same as the bare `npm version` (cwd = package.json's dir).
const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, "manifest.json");
const versionsPath = resolve(here, "versions.json");
// Repo root is the parent of plugin/. Obsidian reads these on the default branch.
const repoRoot = resolve(here, "..");
const rootManifestPath = resolve(repoRoot, "manifest.json");
const rootVersionsPath = resolve(repoRoot, "versions.json");

for (const p of [manifestPath, versionsPath]) {
	if (!existsSync(p)) {
		console.error(`version-bump: required file missing: ${p}`);
		process.exit(1);
	}
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
const manifestJson = JSON.stringify(manifest, null, "\t") + "\n";
writeFileSync(manifestPath, manifestJson);

const versions = JSON.parse(readFileSync(versionsPath, "utf-8"));
versions[targetVersion] = minAppVersion;
const versionsJson = JSON.stringify(versions, null, "\t") + "\n";
writeFileSync(versionsPath, versionsJson);

// Mirror the plugin/ files byte-for-byte into the repo root.
writeFileSync(rootManifestPath, manifestJson);
writeFileSync(rootVersionsPath, versionsJson);

// Use absolute paths so `git add` works regardless of cwd.
execSync(`git add "${manifestPath}" "${versionsPath}" "${rootManifestPath}" "${rootVersionsPath}"`);
console.log(
	`version-bump: synced manifest.json + versions.json (plugin/ and repo root) to ${targetVersion}`,
);
