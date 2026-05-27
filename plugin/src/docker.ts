import { exec as execCb, spawn } from "child_process";
import { createServer } from "net";
import { networkInterfaces } from "os";
import { promisify } from "util";
import { logger, errMsg } from "./logger";

const exec = promisify(execCb);

const VALID_DISTRO_NAME = /^[\w][\w.-]*$/;

function assertValidDistro(name: string): void {
	if (!VALID_DISTRO_NAME.test(name)) {
		throw new Error(
			`Invalid WSL distribution name '${name}'. Only alphanumeric characters, hyphens, underscores, and dots are allowed.`,
		);
	}
}

function assertSafeSessionName(name: string): void {
	if (!isValidSessionName(name)) {
		throw new Error(
			`Invalid tmux session name '${name}'. Only letters, digits, '_', '.', and '-' are allowed.`,
		);
	}
}
const EXEC_TIMEOUT = 30_000;
const PROBE_TIMEOUT = 5_000;
const SERVICE_NAME = "sandbox";

import type { DockerMode } from "./settings";
import {
	isValidWriteDir,
	isWriteDirInsideVault,
	isValidPrivateHosts,
	isValidDomainList,
	isValidMemory,
	isValidCpus,
	isValidSessionName,
	isValidMemoryFileName,
	isValidBindAddress,
	isValidPort,
} from "./validation";

export interface DockerManagerSettings {
	dockerMode: DockerMode;
	composePath: string;
	wslDistro: string;
	vaultPath?: string;
	writeDir?: string;
	memoryFileName?: string;
	ttydPort?: number;
	ttydBindAddress?: string;
	allowedPrivateHosts?: string;
	additionalFirewallDomains?: string;
	containerMemory?: string;
	containerCpus?: string;
	sudoPassword?: string;
	mcpToken?: string;
	mcpPort?: number;
}

export function windowsToWslPath(windowsPath: string): string {
	const match = windowsPath.match(/^([A-Za-z]):[/\\]/);
	if (!match) return windowsPath;
	const driveLetter = match[1].toLowerCase();
	// Strip leading slashes from the rest to avoid `/mnt/c//path` outputs.
	// `C:\\folder` (string-literal double-backslash) → after slice(3): `\folder`
	// → after backslash→slash: `/folder` → would yield `/mnt/c//folder`.
	const rest = windowsPath.slice(3).replace(/\\/g, "/").replace(/^\/+/, "");
	return `/mnt/${driveLetter}/${rest}`;
}

/**
 * Builds the inner shell command string with env vars and cd.
 * `dockerCmd` must be a trusted literal — it is NOT escaped.
 */
/** Reject control characters in any env-var value. Every value flows through
 *  the same `bash -c export KEY='value' && ...` envelope (or the cmd.exe
 *  `set "KEY=value" && ...` envelope on Windows). CR/LF can terminate the
 *  export/set statement so the rest runs as a fresh command:
 *   - bash: single-quotes preserve newlines literally, but the outer
 *           double-quoted bash -c "..." reparses LF as a statement separator.
 *   - cmd.exe: `set "KEY=foo\nbar"` ends at the LF and `bar` runs after &&.
 *   - NUL: bash silently truncates at \0, producing "wrong password" with no
 *          clear cause when present in OAS_SUDO_PASSWORD.
 *  Defense in depth on top of per-setting validators in the envSpec, which
 *  are field-shape checks and don't all reject control bytes. */
function assertNoControlBytes(key: string, value: string): void {
	if (value.includes("\n") || value.includes("\r")) {
		throw new Error(`Invalid value for ${key}: must not contain newlines or carriage returns.`);
	}
	if (value.includes("\0")) {
		throw new Error(`Invalid value for ${key}: must not contain NUL bytes.`);
	}
}

function buildInnerCommand(
	composePath: string,
	dockerCmd: string,
	envVars: Record<string, string>,
): string {
	const escapedPath = composePath.replace(/'/g, "'\\''");

	const envPrefix = Object.entries(envVars)
		.map(([key, value]) => {
			assertNoControlBytes(key, value);
			const escapedValue = value.replace(/'/g, "'\\''");
			return `${key}='${escapedValue}'`;
		})
		.join(" ");
	const envPart = envPrefix ? `export ${envPrefix} && ` : "";

	return `${envPart}cd '${escapedPath}' && ${dockerCmd}`;
}

// Escape a string so it round-trips unchanged through `bash -c "..."`. The
// single-quoted inner command does NOT shield `$` or backtick from the outer
// double-quoted context — bash still expands them. Order matters: backslash
// first, otherwise later passes would re-escape the escapes.
function escapeForOuterDoubleQuote(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$").replace(/"/g, '\\"');
}

function buildBashCommand(
	composePath: string,
	dockerCmd: string,
	envVars: Record<string, string>,
	prefix: string,
): string {
	const cmdSafe = escapeForOuterDoubleQuote(buildInnerCommand(composePath, dockerCmd, envVars));
	return `${prefix}bash -c "${cmdSafe}"`;
}

export function buildWslCommand(
	composePath: string,
	wslDistro: string,
	dockerCmd: string,
	envVars: Record<string, string> = {},
): string {
	assertValidDistro(wslDistro);
	return buildBashCommand(composePath, dockerCmd, envVars, `wsl -d ${wslDistro} -- `);
}

export function buildLocalCommand(
	composePath: string,
	dockerCmd: string,
	envVars: Record<string, string> = {},
): string {
	return buildBashCommand(composePath, dockerCmd, envVars, "");
}

/**
 * Builds a command string for Windows cmd.exe when using Local Docker mode.
 * Uses `set` for env vars and `cd /d` for Windows drive paths.
 * No explicit shell wrapper — exec() uses cmd.exe on Windows by default.
 */
export function buildLocalWindowsCommand(
	composePath: string,
	dockerCmd: string,
	envVars: Record<string, string> = {},
): string {
	const escapedPath = composePath.replace(/"/g, '""');

	const envParts = Object.entries(envVars).map(([key, value]) => {
		// Symmetric with buildInnerCommand (bash path): CR/LF or NUL in any
		// value can terminate the `set "KEY=..."` statement and let the rest
		// run as a fresh cmd.exe command after the &&. Apply to all keys —
		// hand-edited data.json can carry an injected newline in any of them.
		assertNoControlBytes(key, value);
		const escapedValue = value.replace(/"/g, '""');
		return `set "${key}=${escapedValue}"`;
	});

	const envPart = envParts.length > 0 ? envParts.join(" && ") + " && " : "";

	return `${envPart}cd /d "${escapedPath}" && ${dockerCmd}`;
}

// Returns "mirrored", "nat", or undefined when wslinfo is unavailable
// (older WSL, non-Windows, or distro not running).
export async function getWslNetworkingMode(wslDistro: string): Promise<string | undefined> {
	if (process.platform !== "win32") return undefined;
	if (!VALID_DISTRO_NAME.test(wslDistro)) return undefined;
	// spawn rather than exec: args as an array means the distro name cannot
	// be reinterpreted by a shell. No shell, no quoting surface.
	return new Promise<string | undefined>((resolve) => {
		const child = spawn("wsl.exe", ["-d", wslDistro, "--", "wslinfo", "--networking-mode"], {
			windowsHide: true,
		});
		let stdout = "";
		const timer = setTimeout(() => {
			child.kill();
			resolve(undefined);
		}, PROBE_TIMEOUT);
		child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.on("error", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0 ? stdout.trim().toLowerCase() : undefined);
		});
	});
}

// Returns the Windows host IP the container should use to reach services on
// the host, or undefined when not on Windows / no suitable adapter is found.
// In WSL mirrored mode, eth0 inside WSL carries the Windows LAN IP, so the
// plugin picks the primary LAN adapter. In NAT mode (and when the mode can't
// be detected), picks the vEthernet(WSL) adapter — the NAT default.
export function getWslHostIp(mode: string | undefined): string | undefined {
	if (process.platform !== "win32") return undefined;
	const nets = networkInterfaces();

	const pick = (predicate: (name: string) => boolean): string | undefined => {
		for (const [name, addrs] of Object.entries(nets)) {
			if (!predicate(name)) continue;
			const addr = addrs?.find((a) => a.family === "IPv4" && !a.internal);
			if (addr) return addr.address;
		}
		return undefined;
	};

	if (mode === "mirrored") {
		return pick((n) => !/wsl|vethernet|loopback/i.test(n));
	}
	return pick((n) => n.toLowerCase().includes("wsl"));
}

/**
 * Parse `ss -tlnH` stdout and return which of `requestedPorts` are listening.
 * Each non-header line has local address as column 4 (0-based 3): `ip:port`.
 * IPv6 addresses look like `[::]:port`; wildcard is `*:port`.
 * Port is everything after the last colon.
 */
export function parseSsListeningPorts(stdout: string, requestedPorts: number[]): number[] {
	const portSet = new Set(requestedPorts);
	const found = new Set<number>();
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/\r/g, "").trim();
		if (!line) continue;
		const cols = line.split(/\s+/);
		const localAddr = cols[3]; // "ip:port" or "[::]:port" or "*:port"
		if (!localAddr) continue;
		const portStr = localAddr.slice(localAddr.lastIndexOf(":") + 1);
		const portNum = parseInt(portStr, 10);
		if (!isNaN(portNum) && portSet.has(portNum)) found.add(portNum);
	}
	return Array.from(found).sort((a, b) => a - b);
}

export class DockerManager {
	private getSettings: () => DockerManagerSettings;
	private busy = false;
	// WSL networking mode and host IP rarely change, but VPN connect,
	// suspend/resume, or `wsl --shutdown` can shift the host IP. Cache per
	// (wslDistro) and expire after WSL_PROBE_TTL_MS so stale entries don't
	// pin a wrong IP for hours. Also cleared on restart() and firewall toggles.
	private wslProbeCache: {
		distro: string;
		mode: string | undefined;
		hostIp: string | undefined;
		at: number;
	} | null = null;
	private static readonly WSL_PROBE_TTL_MS = 5 * 60_000;

	/** Clear the WSL probe cache so the next docker call re-detects host IP / mode.
	 *  Useful after a network change (VPN, suspend/resume). */
	invalidateWslProbe(): void {
		this.wslProbeCache = null;
	}

	constructor(getSettings: () => DockerManagerSettings) {
		this.getSettings = getSettings;
	}

	isBusy(): boolean {
		return this.busy;
	}

	private async getWslProbe(
		wslDistro: string,
	): Promise<{ mode: string | undefined; hostIp: string | undefined }> {
		const now = Date.now();
		if (
			this.wslProbeCache &&
			this.wslProbeCache.distro === wslDistro &&
			now - this.wslProbeCache.at < DockerManager.WSL_PROBE_TTL_MS
		) {
			return { mode: this.wslProbeCache.mode, hostIp: this.wslProbeCache.hostIp };
		}
		const mode = await getWslNetworkingMode(wslDistro);
		const hostIp = getWslHostIp(mode);
		this.wslProbeCache = { distro: wslDistro, mode, hostIp, at: now };
		return { mode, hostIp };
	}

	private async run(dockerCmd: string, timeout = EXEC_TIMEOUT, quiet = false): Promise<string> {
		const {
			dockerMode,
			composePath,
			wslDistro,
			vaultPath,
			writeDir,
			memoryFileName,
			ttydPort,
			ttydBindAddress,
			allowedPrivateHosts,
			additionalFirewallDomains,
			containerMemory,
			containerCpus,
			sudoPassword,
		} = this.getSettings();

		if (!composePath) {
			throw new Error(
				"Docker Compose path not configured. Set it in Settings > Agent Sandbox.",
			);
		}

		// Convert Windows paths for WSL mode (e.g. Z:\path → /mnt/z/path)
		const effectiveComposePath =
			dockerMode === "wsl" ? windowsToWslPath(composePath) : composePath;

		const { mcpToken, mcpPort } = this.getSettings();

		const envSpec: {
			key: string;
			value: string | number | undefined;
			validate?: (v: string) => boolean;
			invalidMsg?: string;
		}[] = [
			{
				key: "OAS_VAULT_HOST_PATH",
				value: vaultPath
					? dockerMode === "wsl"
						? windowsToWslPath(vaultPath)
						: vaultPath
					: "",
				// Vault paths come from Obsidian's getBasePath and can contain
				// spaces (`C:\Users\Foo\My Vault`); dangerous bytes are caught
				// by assertNoControlBytes. The validator only enforces
				// non-empty to make the contract explicit.
				validate: (v) => v.length > 0,
				invalidMsg: "Invalid vault path: must not be empty.",
			},
			{
				key: "OAS_VAULT_WRITE_DIR",
				value: writeDir,
				validate: isValidWriteDir,
				invalidMsg:
					"Invalid vault write directory. Use a relative path (nested paths like @Inbox/notes are allowed, but no '..', backslashes, or leading dot).",
			},
			{
				key: "OAS_TTYD_PORT",
				value: ttydPort ? String(ttydPort) : "",
				validate: isValidPort,
				invalidMsg: "Invalid ttyd port. Use a number between 1 and 65535.",
			},
			{
				key: "OAS_TTYD_BIND",
				value: ttydBindAddress,
				validate: isValidBindAddress,
				invalidMsg:
					"Invalid ttyd bind address. Use an IPv4 address (e.g. 127.0.0.1 or 0.0.0.0).",
			},
			{
				key: "OAS_MEMORY_FILE_NAME",
				value: memoryFileName,
				validate: isValidMemoryFileName,
				invalidMsg:
					"Invalid memory file name. Use a bare filename (letters/digits/./_/-, no slashes, no '..', no leading dot).",
			},
			{
				key: "OAS_ALLOWED_PRIVATE_HOSTS",
				value: allowedPrivateHosts,
				validate: isValidPrivateHosts,
				invalidMsg:
					"Invalid allowed private hosts. Use comma-separated IPs or CIDRs (e.g. 192.168.1.100, 10.0.0.0/8).",
			},
			{
				key: "OAS_ALLOWED_DOMAINS",
				value: additionalFirewallDomains,
				validate: isValidDomainList,
				invalidMsg:
					"Invalid additional firewall domains. Use comma-separated domain names (e.g. api.atlassian.com, slack.com).",
			},
			{
				key: "OAS_CONTAINER_MEMORY",
				value: containerMemory,
				validate: isValidMemory,
				invalidMsg:
					"Invalid memory limit. Use a number with unit suffix (e.g. 4G, 512M, 1T).",
			},
			{
				key: "OAS_CONTAINER_CPUS",
				value: containerCpus,
				validate: isValidCpus,
				invalidMsg: "Invalid CPU limit. Use a number (e.g. 4, 2.5).",
			},
			// Caveat: these values appear on the bash command line as
			// `export OAS_SUDO_PASSWORD='…'`, briefly visible to other host
			// users via `ps -ef` while docker compose runs. Mitigations:
			// MCP token rotation via settings; sudoPassword is the user's
			// own password on their own machine; validators prevent shell
			// injection.
			{ key: "OAS_SUDO_PASSWORD", value: sudoPassword },
			{ key: "OAS_MCP_TOKEN", value: mcpToken },
			{
				key: "OAS_MCP_PORT",
				value: mcpPort ? String(mcpPort) : "",
				validate: isValidPort,
				invalidMsg: "Invalid MCP port. Use a number between 1 and 65535.",
			},
		];

		const envVars: Record<string, string> = {};
		for (const { key, value, validate, invalidMsg } of envSpec) {
			const v = value === undefined ? "" : String(value);
			// Validate before the empty-skip — a validator that rejects empty
			// (e.g. OAS_VAULT_HOST_PATH) must surface as an error instead of
			// silently falling through to compose's `${VAR:-fallback}`.
			if (validate && !validate(v)) throw new Error(invalidMsg!);
			if (v === "") continue;
			envVars[key] = v;
		}

		// Host-side bind-mount containment check. The compose YAML source is
		// `${OAS_VAULT_HOST_PATH}/${OAS_VAULT_WRITE_DIR}` — Docker resolves it on the
		// host before the container starts, so the entrypoint's guard runs too
		// late to prevent escape. Verify here while vaultPath is the raw native
		// path (before WSL conversion) so path.resolve uses the right separator.
		if (vaultPath && writeDir && !isWriteDirInsideVault(vaultPath, writeDir)) {
			throw new Error(
				"Vault write directory resolves outside the vault root. " +
					"Adjust the Write Directory setting (no '..' components allowed).",
			);
		}
		logger.info(
			"Docker",
			`envVars assembled for "${dockerCmd}": ${JSON.stringify(
				Object.fromEntries(
					Object.entries(envVars).map(([k, v]) => [
						k,
						k === "OAS_SUDO_PASSWORD" || k === "OAS_MCP_TOKEN" ? "<redacted>" : v,
					]),
				),
			)}`,
		);
		// On Windows, inject the actual Windows host IP so containers can reach
		// the host: the docker-bridge / Rancher DNS that host-gateway resolves
		// to inside WSL2 is not reachable from the container. In mirrored mode
		// disable Docker's bridge MASQUERADE — it rewrites to the LAN IP, which
		// Windows' Hyper-V firewall (allowlist: 172.16.0.0/12) then drops.
		const { mode: wslMode, hostIp: wslHostIp } = await this.getWslProbe(wslDistro);
		if (wslHostIp) {
			envVars.OAS_HOST_IP = wslHostIp;
		}
		if (wslMode === "mirrored") {
			envVars.OAS_IP_MASQ = "false";
		}

		const resolvedCmd = dockerCmd.startsWith("docker compose ")
			? `docker compose ${this.composeFiles()} ${dockerCmd.slice("docker compose ".length)}`
			: dockerCmd;

		const command =
			dockerMode === "wsl"
				? buildWslCommand(effectiveComposePath, wslDistro, resolvedCmd, envVars)
				: process.platform === "win32"
					? buildLocalWindowsCommand(composePath, resolvedCmd, envVars)
					: buildLocalCommand(composePath, resolvedCmd, envVars);
		try {
			const { stdout } = await exec(command, { timeout, windowsHide: true });
			return stdout.trim();
		} catch (error: unknown) {
			const err = error as { stderr?: string; message?: string; killed?: boolean };
			const detail = err.stderr || err.message || String(error);
			const combined = (err.stderr || "") + (err.message || "");

			if (!quiet) logger.error("Docker", `Command failed: ${detail}`);

			// suppressErrors=true callers decide based on stderr content
			// (e.g. listSessions distinguishing "no tmux server" from a real
			// Docker failure). Throw a structured error preserving stderr;
			// the wrapped "Unexpected Docker error" below would hide it.
			if (quiet) {
				throw Object.assign(new Error(err.message || detail), {
					stderr: err.stderr ?? "",
					combined,
				});
			}

			const dockerNotRunningPatterns = [
				"Cannot connect to the Docker daemon",
				"//./pipe/docker_engine",
				"The system cannot find the file specified",
			];
			const errorPatterns: Array<[boolean, string]> = [
				[
					combined.includes("is not recognized"),
					"WSL is not available. Please ensure WSL is installed and configured.",
				],
				[
					dockerNotRunningPatterns.some((p) => combined.includes(p)),
					"Docker is not running. Please start your Docker engine.",
				],
				[
					combined.includes("No such distribution"),
					`WSL distribution '${wslDistro}' not found. Check Settings > Docker.`,
				],
				[
					combined.includes("no configuration file provided"),
					"docker-compose.yml not found. Check Settings > Docker Compose path.",
				],
				// Only rewrite ENOENT at the Node spawn level (cwd missing →
				// phrase in err.message, empty stderr). A downstream tool like
				// tmux reporting "No such file or directory" via stderr keeps
				// its original error so callers can recognise it.
				[
					!err.stderr && (err.message?.includes("No such file or directory") ?? false),
					"Docker Compose directory not found. Check Settings > Docker Compose path.",
				],
				[
					!!err.killed ||
						combined.includes("ETIMEDOUT") ||
						combined.includes("timed out"),
					"Docker is not responding. It may still be starting — try again in a moment.",
				],
			];
			for (const [match, message] of errorPatterns) {
				if (match) throw new Error(message);
			}
			throw new Error(
				"Unexpected Docker error. Open the developer console (Ctrl+Shift+I) for details.",
			);
		}
	}

	/** Wraps an async operation with a busy guard to prevent concurrent docker operations. */
	private async withGuard<T>(fn: () => Promise<T>): Promise<T> {
		if (this.busy) {
			throw new Error("Another container operation is in progress. Please wait.");
		}
		this.busy = true;
		try {
			return await fn();
		} finally {
			this.busy = false;
		}
	}

	/** `up -d` only — compose reconciles config matches. For a forced clean recreate, use `restart()`. */
	async start(): Promise<string> {
		return this.withGuard(() => this.run("docker compose up -d"));
	}

	async stop(): Promise<string> {
		return this.withGuard(() => this.run("docker compose down"));
	}

	/** Fire-and-forget stop for plugin unload (parent stays alive). */
	stopDetached(): void {
		const settings = this.getSettings();
		const { dockerMode, composePath, wslDistro } = settings;
		if (!composePath) return;

		// `docker compose down` doesn't need OAS_VAULT_HOST_PATH/OAS_VAULT_WRITE_DIR
		// to find the project (the `name: oas` field pins it), but compose
		// still substitutes ${VAR} in the YAML and warns to stderr when unset.
		// Providing the values keeps behaviour symmetric with run().
		const downEnv: Record<string, string> = {};
		if (settings.vaultPath) {
			downEnv.OAS_VAULT_HOST_PATH =
				dockerMode === "wsl" ? windowsToWslPath(settings.vaultPath) : settings.vaultPath;
		}
		if (settings.writeDir) downEnv.OAS_VAULT_WRITE_DIR = settings.writeDir;

		let shell: string;
		let args: string[];
		// Symmetric with run(): reject control bytes in every env value before
		// any shell envelope so a hand-edited data.json with CR/LF/NUL in
		// vaultPath/writeDir can't terminate the export/set statement. Mirrors
		// buildInnerCommand/buildLocalWindowsCommand on the interactive path.
		try {
			for (const [k, v] of Object.entries(downEnv)) assertNoControlBytes(k, v);
		} catch {
			return;
		}

		const downCmd = `docker compose ${this.composeFiles()} down`;

		if (dockerMode === "wsl") {
			// On Windows, spawn wsl.exe directly (no bash on host). Validate
			// the distro name even on this detached path — args go as an array
			// (no shell injection), but a malformed name lets wsl.exe error in
			// unhelpful ways.
			if (!VALID_DISTRO_NAME.test(wslDistro)) return;
			const wslPath = windowsToWslPath(composePath);
			const innerCmd = buildInnerCommand(wslPath, downCmd, downEnv);
			shell = "wsl";
			args = ["-d", wslDistro, "--", "bash", "-c", innerCmd];
		} else if (process.platform === "win32") {
			// Native Docker on Windows — use cmd.exe (doubles internal quotes).
			shell = "cmd.exe";
			args = ["/c", buildLocalWindowsCommand(composePath, downCmd, downEnv)];
		} else {
			// Linux / Mac — pass the inner command directly to bash -c. Calling
			// buildLocalCommand here would yield `bash -c "..."` and we'd then
			// wrap that in another `bash -c`, double-shelling for no reason.
			shell = "bash";
			args = ["-c", buildInnerCommand(composePath, downCmd, downEnv)];
		}

		// detached:true on Linux/Mac puts the child into its own process group
		// so it survives Obsidian's exit (otherwise SIGTERM-on-parent-exit
		// propagates). On Windows, children survive parent exit naturally and
		// detached:true would pop a visible console window — leave it false
		// there. stdio:"ignore" + unref() complete the detachment.
		const child = spawn(shell, args, {
			detached: process.platform !== "win32",
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
	}

	/**
	 * Run `docker compose ps --format json` and return the raw stdout.
	 * `timeoutMs` defaults to PROBE_TIMEOUT (fast-fail for startup checks /
	 * health polls); pass EXEC_TIMEOUT explicitly for user-initiated status
	 * checks where waiting longer beats failing fast on a slow daemon.
	 */
	async probeStatus(timeoutMs: number = PROBE_TIMEOUT): Promise<string> {
		return this.run("docker compose ps --format json", timeoutMs);
	}

	/** Convenience: probeStatus + parseIsRunning, returning the running flag directly. */
	async probeIsRunning(): Promise<boolean> {
		return DockerManager.parseIsRunning(await this.probeStatus());
	}

	/** Long-timeout status probe for user-initiated "Check Status" commands. */
	async status(): Promise<string> {
		return this.probeStatus(EXEC_TIMEOUT);
	}

	/**
	 * Ensure WSL is awake before running Docker commands.
	 * No-op in local mode. In WSL mode, runs a quick `echo ok` to wake
	 * the distro (or fail fast if WSL/distro is unavailable).
	 */
	async ensureWslReady(): Promise<void> {
		const { dockerMode, wslDistro } = this.getSettings();
		if (dockerMode !== "wsl") return;

		assertValidDistro(wslDistro);

		const command = `wsl -d ${wslDistro} -- echo ok`;
		try {
			await exec(command, { timeout: PROBE_TIMEOUT, windowsHide: true });
		} catch (error: unknown) {
			const err = error as { stderr?: string; message?: string };
			const combined = (err.stderr || "") + (err.message || "");

			if (combined.includes("is not recognized")) {
				throw new Error(
					"WSL is not available. Please ensure WSL is installed and configured.",
				);
			}
			if (combined.includes("No such distribution")) {
				throw new Error(
					`WSL distribution '${wslDistro}' not found. Please check your settings.`,
				);
			}
			throw new Error(`WSL is not responding: ${err.stderr || err.message}`);
		}
	}

	/** Force a clean recreate (`down` then `up -d`); discards in-container runtime state. */
	async restart(): Promise<string> {
		this.wslProbeCache = null;
		return this.withGuard(async () => {
			try {
				await this.run("docker compose down");
			} catch (err) {
				// No prior container running is the common case for the
				// "force recreate" flow — debug-level only, not a warning.
				logger.debug(
					"Docker",
					"compose down failed during restart (may not be running)",
					err,
				);
			}
			return this.run("docker compose up -d");
		});
	}

	private composeFiles(): string {
		const { sudoPassword } = this.getSettings();
		if (!sudoPassword) return "-f docker-compose.yml";
		return "-f docker-compose.yml -f docker-compose.no-new-privileges-off.override.yml";
	}

	private firewallExec(args: string, timeout?: number): Promise<string> {
		const argSuffix = args ? ` ${args}` : "";
		return this.run(
			`docker compose exec --user root ${SERVICE_NAME} /usr/local/bin/init-firewall.sh${argSuffix}`,
			timeout,
		);
	}

	async enableFirewall(): Promise<string> {
		return this.withGuard(() => this.firewallExec(""));
	}

	async disableFirewall(): Promise<string> {
		return this.withGuard(() => this.firewallExec("--disable"));
	}

	/**
	 * Probe host-local ports for availability. Returns ports already bound
	 * by a non-compose process; pre-flight before `docker compose up -d`.
	 *
	 * Every non-`listening` outcome counts as a conflict so a clean
	 * port-in-use message surfaces instead of compose's opaque "address in
	 * use" later. EADDRINUSE → conflict (typical); EACCES (privileged port),
	 * EADDRNOTAVAIL (invalid bind host) → also conflict, logged with errno.
	 * A 2s per-probe timeout guards against the rare kernel quirk where
	 * neither event fires and the Promise would hang.
	 */
	async checkPortConflicts(ports: number[], host = "127.0.0.1"): Promise<number[]> {
		const conflicts: number[] = [];
		await Promise.all(
			ports.map(
				(port) =>
					new Promise<void>((resolve) => {
						const tester = createServer();
						const timer = setTimeout(() => {
							logger.warn("Docker", `Port probe ${host}:${port} timed out`);
							try {
								tester.close();
							} catch {
								/* ignore */
							}
							conflicts.push(port);
							resolve();
						}, 2000);
						tester.once("error", (err: NodeJS.ErrnoException) => {
							clearTimeout(timer);
							if (err.code !== "EADDRINUSE") {
								logger.warn(
									"Docker",
									`Port probe ${host}:${port} error ${err.code}: ${err.message}`,
								);
							}
							// Any error means the port can't be listened on; compose
							// would also fail. Reporting as a conflict gives the user
							// a clean pre-flight message.
							conflicts.push(port);
							resolve();
						});
						tester.once("listening", () => {
							clearTimeout(timer);
							tester.close(() => resolve());
						});
						tester.listen(port, host);
					}),
			),
		);
		return conflicts.sort((a, b) => a - b);
	}

	/**
	 * Dispatch port-conflict check based on docker mode and WSL networking mode.
	 * In WSL NAT mode the plugin (Windows host) and Docker (WSL2 namespace) are
	 * on different network stacks, so a host-side `net.createServer` probe can't
	 * see ports bound inside WSL. Probe via `wsl.exe … ss -tlnH` instead.
	 * Falls back to host-side probe for local mode, WSL mirrored mode, and when
	 * the networking mode can't be detected.
	 */
	async checkStartupConflicts(ports: number[], host: string): Promise<number[]> {
		const { dockerMode, wslDistro } = this.getSettings();
		if (dockerMode === "wsl") {
			const { mode } = await this.getWslProbe(wslDistro);
			if (mode === "nat") {
				return this.checkPortConflictsWsl(ports, wslDistro);
			}
		}
		return this.checkPortConflicts(ports, host);
	}

	private async checkPortConflictsWsl(ports: number[], wslDistro: string): Promise<number[]> {
		return new Promise<number[]>((resolve) => {
			const child = spawn("wsl.exe", ["-d", wslDistro, "--", "ss", "-tlnH"], {
				windowsHide: true,
			});
			let stdout = "";
			const timer = setTimeout(() => {
				child.kill();
				logger.warn("Docker", "WSL port probe (ss) timed out; skipping WSL conflict check");
				resolve([]);
			}, PROBE_TIMEOUT);
			child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
			child.on("error", (err) => {
				clearTimeout(timer);
				logger.warn("Docker", `WSL port probe (ss) failed: ${errMsg(err)}`);
				resolve([]);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code !== 0) {
					logger.warn(
						"Docker",
						`WSL ss exited with code ${code}; skipping WSL conflict check`,
					);
					resolve([]);
					return;
				}
				resolve(parseSsListeningPorts(stdout, ports));
			});
		});
	}

	/**
	 * Returns the current container ID, or empty string if not running.
	 * Throws on probe failure so callers can distinguish "no container" from
	 * "couldn't ask docker" — collapsing both to "" lets a flaky probe mask
	 * container-recreation notices in checkContainerIdDrift.
	 */
	async getContainerId(): Promise<string> {
		const output = await this.run(`docker compose ps -q ${SERVICE_NAME}`, PROBE_TIMEOUT);
		return output.trim();
	}

	/**
	 * Returns image tag and start time for the running container.
	 * Called only from the "Check Status" command — kept off the hot probe path.
	 * Returns null if the container is not running or inspect fails.
	 */
	async getContainerInfo(): Promise<{ id: string; image: string; startedAt: string } | null> {
		try {
			const id = await this.getContainerId();
			if (!id) return null;
			// Two calls to avoid shell-quoting the Go template separator across
			// bash and cmd.exe; Go template braces are safe unquoted in both.
			const [image, startedAt] = await Promise.all([
				this.run(`docker inspect ${id} --format {{.Config.Image}}`, EXEC_TIMEOUT),
				this.run(`docker inspect ${id} --format {{.State.StartedAt}}`, EXEC_TIMEOUT),
			]);
			if (!image.trim() || !startedAt.trim()) return null;
			return { id, image: image.trim(), startedAt: startedAt.trim() };
		} catch {
			return null;
		}
	}

	/**
	 * True if compose has any container for this project, regardless of state.
	 * Detects a half-stopped container still holding host port mappings.
	 *
	 * On probe failure, return `true` (and log) so the port-conflict recovery
	 * path still attempts `docker compose down` — collapsing to `false` would
	 * make transient probe errors silently skip recovery.
	 */
	async hasAnyContainer(): Promise<boolean> {
		try {
			const output = await this.run(`docker compose ps -a -q ${SERVICE_NAME}`, PROBE_TIMEOUT);
			return output.trim().length > 0;
		} catch (err) {
			logger.warn(
				"Docker",
				`hasAnyContainer probe failed — assuming a container exists so cleanup can proceed: ${errMsg(err)}`,
			);
			return true;
		}
	}

	/**
	 * Resolve the firewall state with three outcomes:
	 *  - "enabled" / "disabled": container responded with the exact word
	 *  - "unavailable": container missing, exec failed, or the script printed
	 *    something unexpected. Caller should hide UI, not display as
	 *    "disabled" — collapsing "broken script" into "disabled" misleads
	 *    the user into thinking they just need to enable it.
	 */
	async firewallStatus(): Promise<"enabled" | "disabled" | "unavailable"> {
		try {
			const output = (await this.firewallExec("--status")).trim();
			if (output === "enabled") return "enabled";
			if (output === "disabled") return "disabled";
			logger.warn("Docker", `Unexpected firewall --status output: ${output.slice(0, 200)}`);
			return "unavailable";
		} catch (err) {
			// Log the cause — otherwise the firewall badge silently flips to
			// "hidden" on transient exec failures (docker hang, WSL blip).
			logger.warn("Docker", `firewallStatus probe failed: ${errMsg(err)}`);
			return "unavailable";
		}
	}

	async firewallSources(): Promise<string> {
		return this.firewallExec("--list-sources", PROBE_TIMEOUT);
	}

	private tmuxExec(subcmd: string, suppressErrors = false): Promise<string> {
		return this.run(
			`docker compose exec --user claude ${SERVICE_NAME} tmux ${subcmd}`,
			PROBE_TIMEOUT,
			suppressErrors,
		);
	}

	async listSessions(): Promise<string[]> {
		try {
			const output = await this.tmuxExec(`list-sessions -F "#{session_name}"`, true);
			return output
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean);
		} catch (err) {
			// run() with suppressErrors=true preserves the original stderr on
			// the thrown Error so tmux's "no sessions" valid-empty state can
			// be distinguished from a real Docker failure. errMsg() would only
			// see the wrapped message and miss the match.
			const stderr = (err as { stderr?: string }).stderr ?? "";
			const haystack = stderr + " " + errMsg(err);
			if (
				!haystack.includes("No such file or directory") &&
				!haystack.includes("no server running") &&
				!haystack.includes("error connecting to")
			) {
				logger.warn("Docker", `listSessions failed: ${errMsg(err)}`);
			}
			return [];
		}
	}

	/** List sessions with no attached clients — candidates for cleanup. */
	async listDetachedSessions(): Promise<string[]> {
		try {
			const output = await this.tmuxExec(
				`list-sessions -F "#{session_name}:#{session_attached}"`,
				true,
			);
			return output
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.endsWith(":0"))
				.map((line) => line.slice(0, -2));
		} catch (err) {
			// Mirror listSessions's stderr-pattern detection: tmux's
			// "no sessions" / "no server running" stderr fragments map to a
			// legitimate empty list; anything else is a real failure that the
			// session-cleanup picker must not see as "no sessions to clean up"
			// (a bare `catch → []` would make a docker daemon outage look
			// identical to "all clean").
			const stderr = (err as { stderr?: string }).stderr ?? "";
			const haystack = stderr + " " + errMsg(err);
			const tmuxLegitEmpty =
				haystack.includes("No such file or directory") ||
				haystack.includes("no server running") ||
				haystack.includes("error connecting to");
			if (tmuxLegitEmpty) return [];
			logger.warn("Docker", `listDetachedSessions failed: ${errMsg(err)}`);
			throw err;
		}
	}

	async killSession(name: string): Promise<void> {
		assertSafeSessionName(name);
		await this.tmuxExec(`kill-session -t "${name}"`);
	}

	async renameSession(oldName: string, newName: string): Promise<void> {
		assertSafeSessionName(oldName);
		assertSafeSessionName(newName);
		await this.tmuxExec(`rename-session -t "${oldName}" "${newName}"`);
	}

	static parseIsRunning(statusOutput: string): boolean {
		// `docker compose ps --format json` emits either a JSON array (newer
		// compose) or one JSON object per line (older). Parse properly so a
		// container whose Name/Image happens to contain the literal "running"
		// doesn't trigger a false positive on a substring match.
		const trimmed = statusOutput.trim();
		if (!trimmed) return false;
		const records: unknown[] = [];
		if (trimmed.startsWith("[")) {
			try {
				const arr = JSON.parse(trimmed);
				if (Array.isArray(arr)) records.push(...arr);
			} catch (err) {
				// Log the parse failure so a malformed status envelope is
				// debuggable instead of silently looking like "no container
				// running". Still return false conservatively so the caller's
				// stopped-state UI fires — better than crashing on a docker
				// version drift.
				logger.warn(
					"Docker",
					`parseIsRunning: malformed JSON-array status output: ${errMsg(err)}`,
				);
				return false;
			}
		} else {
			for (const line of trimmed.split("\n")) {
				const l = line.trim();
				if (!l) continue;
				try {
					records.push(JSON.parse(l));
				} catch {
					/* skip malformed line */
				}
			}
		}
		return records.some((r) => {
			if (typeof r !== "object" || r === null) return false;
			const obj = r as { State?: unknown; Status?: unknown };
			const state = typeof obj.State === "string" ? obj.State.toLowerCase() : "";
			if (state === "running") return true;
			// Older compose 2.x versions report `State` as a human string like
			// "Up 2 hours (healthy)" instead of "running". Fall back to the
			// `Status` field, which has the same shape across versions, and
			// accept any "Up …" prefix as running.
			if (state.startsWith("up ")) return true;
			const status = typeof obj.Status === "string" ? obj.Status.toLowerCase() : "";
			return status.startsWith("up ");
		});
	}
}
