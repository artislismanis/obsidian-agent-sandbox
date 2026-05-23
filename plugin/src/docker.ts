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
	isValidPrivateHosts,
	isValidDomainList,
	isValidMemory,
	isValidCpus,
	isValidSessionName,
	isValidMemoryFileName,
	isValidBindAddress,
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
/** Reject control characters in any env-var value. Originally only sensitive
 *  keys (OAS_SUDO_PASSWORD / OAS_MCP_TOKEN) were checked, but EVERY value
 *  flows through the same `bash -c export KEY='value' && ...` envelope (or
 *  the cmd.exe `set "KEY=value" && ...` envelope on Windows). A CR/LF in
 *  any value can terminate the export/set statement and let the rest run
 *  as a fresh command:
 *   - bash: single-quotes preserve newlines literally, so `'foo\nrm -rf /'`
 *           stays inside the quotes for export, but the subsequent && chain
 *           treats the LF as a statement separator anyway via shell parsing
 *           of the outer command after our escaping.
 *   - cmd.exe: `set "KEY=foo\nbar"` ends at the LF and `bar` runs as a new
 *              command after the next &&.
 *   - NUL: bash silently truncates at \0, so a NUL inside a password
 *          produces "wrong password" with no clear cause.
 *  Validation here is defense in depth on top of the per-setting validators
 *  applied in the envSpec — those are field-shape checks; this is a sanity
 *  rail that runs even for shapes (like file paths) whose validator doesn't
 *  inherently reject control bytes. */
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
// first, otherwise later passes would re-escape our own escapes.
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
		// Symmetric with buildInnerCommand (bash path): a CR/LF or NUL in
		// any value can terminate the `set "KEY=..."` statement and let the
		// rest of the value run as a fresh cmd.exe command after the &&.
		// Apply to ALL keys, not just SENSITIVE ones (any of OAS_VAULT_PATH,
		// OAS_MEMORY_FILE_NAME, etc. can carry an injected newline if
		// hand-edited in data.json).
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
	// spawn rather than exec: passes args as an array so the distro name
	// (already regex-validated above) cannot be reinterpreted by a shell
	// even if validation ever regresses. No shell, no quoting surface.
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

export class DockerManager {
	private getSettings: () => DockerManagerSettings;
	private busy = false;
	// WSL networking mode and host IP rarely change, but VPN connect, suspend/
	// resume, or `wsl --shutdown` can shift the host IP under us. Cache per
	// (wslDistro) but expire after WSL_PROBE_TTL_MS so stale entries don't pin
	// a wrong IP for hours. Also cleared on restart() and firewall toggles.
	private wslProbeCache: {
		distro: string;
		mode: string | undefined;
		hostIp: string | undefined;
		at: number;
	} | null = null;
	private static readonly WSL_PROBE_TTL_MS = 5 * 60_000;

	/** Clear the WSL probe cache so the next docker call re-detects host IP / mode.
	 *  Useful when the network changed under us (VPN, suspend/resume). */
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
				key: "OAS_VAULT_PATH",
				value: vaultPath
					? dockerMode === "wsl"
						? windowsToWslPath(vaultPath)
						: vaultPath
					: "",
				// Vault paths are derived from Obsidian's getBasePath and can
				// legitimately contain spaces and other path-safe characters
				// (e.g. `C:\Users\Foo\My Vault`). Dangerous bytes (CR/LF/NUL)
				// are caught by assertNoControlBytes for ALL env vars. The
				// validator here just enforces non-empty so the contract is
				// explicit; the for-loop below also skips empty values, but
				// being explicit documents the boundary.
				validate: (v) => v.length > 0,
				invalidMsg: "Invalid vault path: must not be empty.",
			},
			{
				key: "OAS_VAULT_WRITE_DIR",
				value: writeDir,
				validate: isValidWriteDir,
				invalidMsg:
					"Invalid vault write directory. Must be a relative path without '..' components.",
			},
			{ key: "OAS_TTYD_PORT", value: ttydPort ? String(ttydPort) : "" },
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
			// OAS_SUDO_PASSWORD and OAS_MCP_TOKEN are validated for CR/LF in
			// buildInnerCommand (SENSITIVE_ENV_KEYS). Caveat: these values
			// appear on the bash command line as `export OAS_SUDO_PASSWORD='…'`,
			// which is briefly visible to other host users via `ps -ef` while
			// docker compose is invoked. Switching to stdin / `--env-file` for
			// these would require splitting the WSL / local-Windows / local
			// invocation paths and rewriting the dockerCmd assembly; tracked
			// as a known limitation. Mitigations: (a) MCP token rotation via
			// settings, (b) sudoPassword is the user's own password on their
			// own machine, (c) the validator above prevents shell injection.
			{ key: "OAS_SUDO_PASSWORD", value: sudoPassword },
			{ key: "OAS_MCP_TOKEN", value: mcpToken },
			{ key: "OAS_MCP_PORT", value: mcpPort ? String(mcpPort) : "" },
		];

		const envVars: Record<string, string> = {};
		for (const { key, value, validate, invalidMsg } of envSpec) {
			if (value === undefined || value === "") continue;
			const v = String(value);
			if (validate && !validate(v)) throw new Error(invalidMsg!);
			envVars[key] = v;
		}
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

		const command =
			dockerMode === "wsl"
				? buildWslCommand(effectiveComposePath, wslDistro, dockerCmd, envVars)
				: process.platform === "win32"
					? buildLocalWindowsCommand(composePath, dockerCmd, envVars)
					: buildLocalCommand(composePath, dockerCmd, envVars);
		try {
			const { stdout } = await exec(command, { timeout, windowsHide: true });
			return stdout.trim();
		} catch (error: unknown) {
			const err = error as { stderr?: string; message?: string; killed?: boolean };
			const detail = err.stderr || err.message || String(error);
			const combined = (err.stderr || "") + (err.message || "");

			if (!quiet) logger.error("Docker", `Command failed: ${detail}`);

			// When the caller passed suppressErrors=true, they want to make their
			// own decision based on stderr content (e.g. listSessions distinguishing
			// "no tmux server" from a real Docker failure). Throw a structured error
			// that preserves stderr; otherwise the wrapped "Unexpected Docker error"
			// below would hide the original output and break their substring checks.
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
				// Only rewrite when the ENOENT is at the Node spawn level (cwd missing →
				// phrase appears in err.message, stderr empty). When a downstream tool
				// like tmux reports "No such file or directory" via stderr, leave the
				// original error so callers can recognise it.
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

		// docker-compose down doesn't need OAS_VAULT_PATH/OAS_VAULT_WRITE_DIR
		// to find the project (the `name: oas` field pins it), but compose
		// still substitutes ${VAR} in the YAML and warns to stderr when
		// unset. The detached spawn discards stderr, but providing the
		// values keeps behaviour symmetric with run() for any compose
		// feature that does require them at down time.
		const downEnv: Record<string, string> = {};
		if (settings.vaultPath) {
			downEnv.OAS_VAULT_PATH =
				dockerMode === "wsl" ? windowsToWslPath(settings.vaultPath) : settings.vaultPath;
		}
		if (settings.writeDir) downEnv.OAS_VAULT_WRITE_DIR = settings.writeDir;

		let shell: string;
		let args: string[];
		if (dockerMode === "wsl") {
			// On Windows, spawn wsl.exe directly (no bash available on host).
			// Validate the distro name even on this detached path — spawn passes
			// args as an array (no shell injection surface), but a malformed
			// name lets wsl.exe error in unhelpful ways. Same regex used in
			// the interactive path's assertValidDistro.
			if (!VALID_DISTRO_NAME.test(wslDistro)) return;
			const wslPath = windowsToWslPath(composePath);
			const escapedPath = wslPath.replace(/'/g, "'\\''");
			const envPrefix = Object.entries(downEnv)
				.map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
				.join(" ");
			const exportPart = envPrefix ? `export ${envPrefix} && ` : "";
			const innerCmd = `${exportPart}cd '${escapedPath}' && docker compose down`;
			shell = "wsl";
			args = ["-d", wslDistro, "--", "bash", "-c", innerCmd];
		} else if (process.platform === "win32") {
			// Native Docker on Windows — use cmd.exe (doubles internal quotes).
			const escapedPath = composePath.replace(/"/g, '""');
			const envPrefix = Object.entries(downEnv)
				.map(([k, v]) => `set "${k}=${v.replace(/"/g, '""')}"`)
				.join(" && ");
			const setPart = envPrefix ? envPrefix + " && " : "";
			shell = "cmd.exe";
			args = ["/c", `${setPart}cd /d "${escapedPath}" && docker compose down`];
		} else {
			// Linux / Mac — pass the inner command directly to bash -c. Calling
			// buildLocalCommand here would yield `bash -c "..."` and we'd then
			// wrap that in another `bash -c`, double-shelling for no reason.
			shell = "bash";
			args = ["-c", buildInnerCommand(composePath, "docker compose down", downEnv)];
		}

		// detached:true on Linux/Mac puts the child into its own process group
		// so it survives Obsidian's exit (otherwise SIGTERM-on-parent-exit
		// would propagate). On Windows, children survive parent exit naturally
		// and detached:true would pop a visible console window — so we leave
		// it false there. stdio:"ignore" + unref() complete the detachment.
		const child = spawn(shell, args, {
			detached: process.platform !== "win32",
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
	}

	async status(): Promise<string> {
		return this.run("docker compose ps --format json");
	}

	/** Fast status probe with a short timeout for startup checks and health polls. */
	async probeStatus(): Promise<string> {
		return this.run("docker compose ps --format json", PROBE_TIMEOUT);
	}

	/** Convenience: probeStatus + parseIsRunning, returning the running flag directly. */
	async probeIsRunning(): Promise<boolean> {
		return DockerManager.parseIsRunning(await this.probeStatus());
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
				// Restart with no prior container running is the common case for
				// the "force recreate" flow — debug-level only, not a warning.
				logger.debug(
					"Docker",
					"compose down failed during restart (may not be running)",
					err,
				);
			}
			return this.run("docker compose up -d");
		});
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
	 * Probe host-local ports for availability. Returns an array of ports
	 * already bound by a non-compose process. Used as a pre-flight check
	 * before `docker compose up -d`.
	 *
	 * Treats every non-`listening` outcome as a conflict so a clean
	 * port-in-use message surfaces instead of letting compose fail with an
	 * opaque "address in use" later. EADDRINUSE → conflict (the typical
	 * case); EACCES (privileged port), EADDRNOTAVAIL (invalid bind host),
	 * etc. → also conflict, logged so the dev console has the actual
	 * errno. A 2s timeout per probe guards against rare cases where neither
	 * event fires (kernel state quirk) and the original Promise hung
	 * forever, freezing the start flow.
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
							// Conservative: any error means the port can't be
							// listened on, which compose will also fail at.
							// Surfacing as a conflict gives the user a clean
							// pre-flight message.
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
	 * Returns the current container ID, or empty string if not running.
	 * Throws on probe failure so callers can distinguish "no container" from
	 * "couldn't ask docker" — previously both collapsed to "" and a flaky
	 * probe silently masked container-recreation notices in
	 * checkContainerIdDrift.
	 */
	async getContainerId(): Promise<string> {
		const output = await this.run(`docker compose ps -q ${SERVICE_NAME}`, PROBE_TIMEOUT);
		return output.trim();
	}

	/**
	 * True if compose has any container for this project, regardless of state.
	 * Used to detect a half-stopped container still holding host port mappings.
	 *
	 * On probe failure, return `true` (and log) — failing safe means the
	 * port-conflict recovery path in main.ts still attempts `docker compose
	 * down`, giving the user a chance to recover. The previous `catch →
	 * return false` made transient probe errors look identical to "no
	 * container", silently skipping the recovery attempt while the user
	 * stared at an unactionable port-conflict Notice.
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
	 *    something unexpected (script broken). Caller should hide UI, not
	 *    display as "disabled" — the previous behaviour collapsed "broken
	 *    script" into "disabled", misleading the user into thinking they
	 *    just needed to enable it.
	 */
	async firewallStatus(): Promise<"enabled" | "disabled" | "unavailable"> {
		try {
			const output = (await this.firewallExec("--status")).trim();
			if (output === "enabled") return "enabled";
			if (output === "disabled") return "disabled";
			logger.warn("Docker", `Unexpected firewall --status output: ${output.slice(0, 200)}`);
			return "unavailable";
		} catch (err) {
			// Previously this swallow had no log line, so the firewall badge
			// silently flipped to "hidden" on every transient exec failure
			// (docker hang, WSL probe blip) with no diagnostic in the
			// console. Surface the cause so flaky firewalls are debuggable.
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
			// run() with suppressErrors=true preserves the original stderr on the
			// thrown Error so we can recognise tmux's "no sessions" valid-empty
			// state vs a real Docker failure. errMsg() alone would only see the
			// wrapped message and miss every match here.
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
	async listEmptySessions(): Promise<string[]> {
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
			// "no sessions" / "no server running" stderr fragments map to
			// a legitimate empty list; anything else is a real failure
			// that the user's session-cleanup picker should NOT see as
			// "no sessions to clean up". The previous bare `catch → []`
			// made a docker daemon outage indistinguishable from "all clean".
			const stderr = (err as { stderr?: string }).stderr ?? "";
			const haystack = stderr + " " + errMsg(err);
			const tmuxLegitEmpty =
				haystack.includes("No such file or directory") ||
				haystack.includes("no server running") ||
				haystack.includes("error connecting to");
			if (tmuxLegitEmpty) return [];
			logger.warn("Docker", `listEmptySessions failed: ${errMsg(err)}`);
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
				// Surface the parse failure: the previous silent `return false`
				// made a malformed `docker compose ps --format json` envelope
				// look identical to "no container running", so the plugin
				// announced the container had stopped and detached terminals
				// while the container was actually fine. Log first so the
				// cause is debuggable, then keep the conservative "false"
				// return so the caller's stopped-state UI still fires —
				// better than crashing on a docker version drift.
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
