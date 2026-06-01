/** Shared input validators. Used by both settings.ts (UI) and docker.ts (runtime). */

import { posix as posixPath } from "path";
import { realpathSync } from "fs";
import { resolve as resolveNative, sep as nativeSep } from "path";

/** Split a comma-separated value into trimmed, non-empty entries. */
export function splitCsv(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** True when any `/`- or `\`-separated path segment is exactly `..` (i.e. an
 *  actual parent traversal). Plain substring `..` rejection is too broad -
 *  it blocks legitimate names like `foo..bar`. */
export function pathHasParentSegment(p: string): boolean {
	return p.split(/[/\\]/).some((seg) => seg === "..");
}

export function isValidWriteDir(dir: string): boolean {
	const trimmed = dir.trim();
	if (!trimmed) return false;
	// Reject trivial current-directory aliases - `isPathWithinDir`
	// normalises `./` to `.` and then rejects all paths as "outside the
	// empty-after-strip directory", so `./` would silently deny every
	// write. Fail closed at validation instead.
	if (trimmed === "." || trimmed === "./" || trimmed === "/") return false;
	// Reject leading dot (hidden root directories, parity with entrypoint).
	if (trimmed.startsWith(".")) return false;
	// Reject backslash - values flow into bash single-quoted env exports;
	// backslashes also indicate Windows absolute paths that Docker rejects.
	if (trimmed.includes("\\")) return false;
	// Reject absolute paths. Nested relative paths with forward slashes are
	// intentionally allowed (e.g. "@Inbox/agent-workspace").
	if (trimmed.startsWith("/")) return false;
	return !pathHasParentSegment(trimmed);
}

/**
 * Verify that `writeDir` resolves inside `vaultPath` on the host.
 * This is the load-bearing escape guard: the compose bind-mount source is
 * `${OAS_VAULT_HOST_PATH}/${OAS_VAULT_WRITE_DIR}` and Docker resolves it on the
 * host before the container starts. The entrypoint check runs after the
 * mount is established, so it cannot prevent escape - only this host-side
 * check can.
 */
export function isWriteDirInsideVault(vaultPath: string, writeDir: string): boolean {
	if (!vaultPath || !writeDir) return false;
	const resolved = resolveNative(vaultPath, writeDir);
	const base = vaultPath.endsWith(nativeSep) ? vaultPath : vaultPath + nativeSep;
	return resolved === vaultPath || resolved.startsWith(base);
}

/**
 * Build a per-tab routing key from the TerminalView instance id.
 * Stable for the lifetime of a tab; injected into the shell env as
 * OAS_TAB_ID so the notify-status hook can route status updates to the
 * correct individual tab rather than the shared DEFAULT_SESSION_KEY bucket.
 */
export function tabKey(instanceId: number): string {
	return `oas-tab-${instanceId}`;
}

/** Validate a tab-key value received from the shell environment. */
const VALID_TAB_ID = /^[A-Za-z0-9_-]+$/;
export function isValidTabId(id: string): boolean {
	return VALID_TAB_ID.test(id);
}

const VALID_SESSION_NAME = /^[\w.-]+$/;

/**
 * Validate a tmux session name: letters, digits, underscore, dot, hyphen
 * only. Used both for direct tmux exec (kill/rename) and for the initial
 * `session <name>` command injected over the ttyd WebSocket on attach -
 * rejecting shell metacharacters before injection is the only thing
 * preventing a hand-edited persisted view-state from re-executing a
 * malicious name on every Obsidian start.
 *
 * Also explicitly rejects `.` and `..` - those are dot-only names that
 * confuse `session .` / `session ..` invocations and serve no real
 * use case as session identifiers.
 */
export function isValidSessionName(name: string): boolean {
	if (name === "." || name === "..") return false;
	return VALID_SESSION_NAME.test(name);
}

/**
 * Validate a memory-file name: bare filename only (no slashes, no path
 * traversal, no leading dot to avoid hidden files). Empty rejected.
 */
export function isValidMemoryFileName(name: string): boolean {
	const t = name.trim();
	if (!t) return false;
	if (t.includes("/") || t.includes("\\") || t.includes("..")) return false;
	if (t.startsWith(".")) return false;
	return /^[A-Za-z0-9_.-]+$/.test(t);
}

/**
 * Validate a comma-separated list of vault-relative path prefixes used in
 * MCP allow/block lists. Each entry: non-empty, no `..`, no leading slash,
 * no backslashes. Empty list = valid (no restriction).
 */
export function isValidPathPrefixList(value: string): boolean {
	if (!value.trim()) return true;
	return splitCsv(value).every(
		(entry) =>
			entry.length > 0 &&
			!pathHasParentSegment(entry) &&
			!entry.includes("\\") &&
			!entry.startsWith("/"),
	);
}

/** Normalise a vault-relative path: collapse `.`/`..` segments, strip leading and trailing slashes. */
function normaliseVaultPath(p: string): string {
	return posixPath.normalize(p).replace(/^\/|\/$/g, "");
}

/**
 * Is `filePath` inside `dir`? Both args are vault-relative.
 *
 * **Empty `dir` returns `false` (fail-closed).** This is the load-bearing case:
 * `vaultWriteDir` is the only thing gating writeScoped tools from spilling into
 * the whole vault. If a hand-edited `data.json` (or a missing default) leaves
 * the setting blank, every "is this path inside the write dir" check would
 * otherwise return true and the writeScoped tier becomes vault-wide. Treat
 * empty as "no writes allowed" instead. Callers that genuinely want
 * "everywhere" must opt in explicitly (writeVault tier).
 */
export function isPathWithinDir(filePath: string, dir: string): boolean {
	const normalizedDir = normaliseVaultPath(dir);
	if (normalizedDir === "") return false;
	const normalized = normaliseVaultPath(filePath);
	return normalized === normalizedDir || normalized.startsWith(normalizedDir + "/");
}

function isValidOctet(s: string): boolean {
	const n = parseInt(s, 10);
	return n >= 0 && n <= 255 && String(n) === s;
}

function isValidIpAddress(ip: string): boolean {
	const parts = ip.split(".");
	return parts.length === 4 && parts.every(isValidOctet);
}

/** Validates a single IP or CIDR (e.g. "192.168.1.0/24"). */
function isValidIpOrCidr(entry: string): boolean {
	const slashIdx = entry.indexOf("/");
	if (slashIdx === -1) return isValidIpAddress(entry);
	const ip = entry.slice(0, slashIdx);
	const prefix = entry.slice(slashIdx + 1);
	const prefixNum = parseInt(prefix, 10);
	return (
		isValidIpAddress(ip) && String(prefixNum) === prefix && prefixNum >= 0 && prefixNum <= 32
	);
}

/** Validates comma-separated IPs/CIDRs. Empty string = valid (use defaults). */
export function isValidPrivateHosts(value: string): boolean {
	if (!value.trim()) return true;
	return splitCsv(value).every(isValidIpOrCidr);
}

const VALID_MEMORY = /^\d+[KkMmGgTt]$/;

/** Validates Docker memory format (e.g. "4G", "512M", "1T"). Empty = valid. */
export function isValidMemory(value: string): boolean {
	if (!value.trim()) return true;
	return VALID_MEMORY.test(value.trim());
}

const VALID_CPUS = /^\d+(\.\d+)?$/;

/** Validates Docker CPU limit (e.g. "4", "2.5"). Empty = valid. */
export function isValidCpus(value: string): boolean {
	if (!value.trim()) return true;
	return VALID_CPUS.test(value.trim());
}

/** Validates IPv4 bind address (e.g. "127.0.0.1", "0.0.0.0"). Empty = valid. */
export function isValidBindAddress(value: string): boolean {
	if (!value.trim()) return true;
	return isValidIpAddress(value.trim());
}

const VALID_DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Validates comma-separated list of domain names (e.g. "api.atlassian.com, slack.com"). Empty = valid. */
export function isValidDomainList(value: string): boolean {
	if (!value.trim()) return true;
	return splitCsv(value).every((entry) => VALID_DOMAIN.test(entry));
}

/** Validates a TCP port number (1-65535). Empty = valid (compose uses the default). */
export function isValidPort(value: string): boolean {
	if (!value.trim()) return true;
	const n = parseInt(value.trim(), 10);
	return String(n) === value.trim() && n >= 1 && n <= 65535;
}

/**
 * Checks whether a path is allowed under most-specific-prefix-wins rules.
 *
 * The longest matching allow-prefix and block-prefix are compared; the longer
 * wins. Ties go to block. When neither list matches, `defaultDeny` controls
 * the outcome.
 */
export function isPathAllowed(
	filePath: string,
	allowlist: string[],
	blocklist: string[],
	defaultDeny = false,
): boolean {
	const longestMatch = (prefixes: string[]): number => {
		let best = -1;
		for (const p of prefixes) {
			if (isPathWithinDir(filePath, p)) {
				best = Math.max(best, normaliseVaultPath(p).length);
			}
		}
		return best;
	};

	const aLen = longestMatch(allowlist);
	const bLen = longestMatch(blocklist);

	if (aLen >= 0 && bLen >= 0) return aLen > bLen; // tie → block
	if (aLen >= 0) return true;
	if (bLen >= 0) return false;
	return !defaultDeny;
}

/**
 * Resolve a vault-relative path to its real filesystem path and verify it
 * stays under the vault base. Blocks symlinks that escape the vault.
 *
 * - Desktop Obsidian supplies `basePath` + `getFullPath`. Mobile / test
 *   adapters that don't should pass `basePath: null` - this function becomes
 *   a no-op pass-through on those.
 * - If the target file doesn't yet exist (e.g. `vault_create` path), realpath
 *   the longest existing ancestor and verify containment there.
 * - A `realpathOverride` hook lets tests inject the realpath result without
 *   touching the filesystem.
 */
export function isRealPathWithinBase(
	basePath: string | null,
	fullPath: string,
	realpathOverride?: (p: string) => string,
): boolean {
	if (!basePath) return true;
	const realpath = realpathOverride ?? realpathSync;
	const baseReal = ((): string => {
		try {
			return realpath(basePath);
		} catch {
			return resolveNative(basePath);
		}
	})();
	let probe = fullPath;
	while (probe && probe !== resolveNative(probe, "..")) {
		try {
			const real = realpath(probe);
			const baseWithSep = baseReal.endsWith(nativeSep) ? baseReal : baseReal + nativeSep;
			return real === baseReal || real.startsWith(baseWithSep);
		} catch {
			probe = resolveNative(probe, "..");
		}
	}
	return false;
}
