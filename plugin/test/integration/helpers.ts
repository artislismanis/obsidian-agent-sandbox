import { execSync, type ExecSyncOptions } from "child_process";
import { resolve } from "path";
import * as http from "http";

export const COMPOSE_DIR = resolve(__dirname, "../../../container");
export const VAULT_DIR = resolve(__dirname, "../fixtures/vault");
export const TTYD_PORT = 7681;
export const MCP_PORT = 28080;
export const MCP_TOKEN = "integration-test-token";

const execOpts: ExecSyncOptions = {
	cwd: COMPOSE_DIR,
	stdio: "pipe",
	env: {
		...process.env,
		PKM_VAULT_PATH: VAULT_DIR,
		PKM_WRITE_DIR: "agent-workspace",
		TTYD_PORT: String(TTYD_PORT),
		TTYD_BIND: "127.0.0.1",
		CONTAINER_MEMORY: "4G",
		CONTAINER_CPUS: "2",
		OAS_MCP_TOKEN: MCP_TOKEN,
		OAS_MCP_PORT: String(MCP_PORT),
	},
};

export function isDockerAvailable(): boolean {
	try {
		execSync("docker info", { stdio: "pipe", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

export function isImageBuilt(): boolean {
	try {
		const output = execSync("docker images oas-sandbox:latest --format '{{.ID}}'", {
			stdio: "pipe",
		});
		return output.toString().trim().length > 0;
	} catch {
		return false;
	}
}

export function containerUp(): void {
	execSync("docker compose up -d", execOpts);
}

export function containerDown(): void {
	execSync("docker compose down", execOpts);
}

export function containerExec(cmd: string): string {
	return execSync(`docker compose exec -T sandbox ${cmd}`, execOpts).toString().trim();
}

export function containerLogs(): string {
	return execSync("docker compose logs sandbox --tail=50", execOpts).toString();
}

export async function waitForHealth(
	url: string,
	timeoutMs = 30000,
	intervalMs = 500,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const status = await httpGet(url);
			if (status >= 200 && status < 400) return;
		} catch {
			// not ready yet
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`Health check timeout for ${url} after ${timeoutMs}ms`);
}

export function httpGet(url: string): Promise<number> {
	return new Promise((resolve, reject) => {
		http.get(url, (res) => resolve(res.statusCode ?? 0)).on("error", reject);
	});
}

export function httpPost(
	url: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
	const data = JSON.stringify(body);
	const parsed = new URL(url);
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname,
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
			},
			(res: http.IncomingMessage) => {
				let buf = "";
				res.on("data", (chunk: Buffer) => (buf += chunk.toString()));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
			},
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}
