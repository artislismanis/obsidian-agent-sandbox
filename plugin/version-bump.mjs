/**
 * Sync `manifest.json` and `versions.json` to the version just set in
 * `package.json`. Called automatically by `npm version` via the "version"
 * lifecycle script (see package.json).
 *
 * - manifest.json: update `version` to match package.json.
 * - versions.json: add `{ <new version>: <minAppVersion from manifest> }`.
 *
 * Stages the updated files so `npm version`'s commit step includes them.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
	console.error("version-bump: npm_package_version is unset");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf-8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf-8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

execSync("git add manifest.json versions.json");
console.log(`version-bump: synced manifest.json + versions.json to ${targetVersion}`);
