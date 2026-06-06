// Minimal MCP Streamable-HTTP client for the bridge e2e specs.
//
// The bridge specs run in the wdio worker (host Node) and POST tool calls to
// the REAL plugin's MCP server running inside the wdio-launched Obsidian, then
// assert the resulting UI via browser.executeObsidian. This mirrors the proven
// http approach in test/integration/helpers.ts (keep-alive disabled so a server
// restarted on the same port never reuses a dead socket).

import * as http from "http";

export interface McpSession {
	url: string;
	token: string;
	sessionId: string;
}

/** MCP Streamable HTTP may return JSON or an SSE `data:` line; handle both. */
export function parseJsonOrSse(body: string): unknown {
	const trimmed = body.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
	const match = trimmed.match(/^data:\s*(.+)$/m);
	if (match) return JSON.parse(match[1]);
	throw new Error(`Cannot parse MCP response body: ${body.slice(0, 200)}`);
}

function post(
	url: string,
	body: unknown,
	headers: Record<string, string>,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
	const data = JSON.stringify(body);
	const parsed = new URL(url);
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname,
				method: "POST",
				// No keep-alive: token-rotation / restart tests reuse the same port.
				agent: false,
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					...headers,
				},
			},
			(res) => {
				let buf = "";
				const resHeaders: Record<string, string> = {};
				for (const [k, v] of Object.entries(res.headers)) {
					if (v !== undefined) resHeaders[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
				}
				res.on("data", (chunk: Buffer) => (buf += chunk.toString()));
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body: buf, headers: resHeaders }),
				);
			},
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

/** Send the MCP initialize handshake; returns a session ready for tool calls. */
export async function mcpInitialize(port: number, token: string): Promise<McpSession> {
	const url = `http://127.0.0.1:${port}/mcp`;
	const res = await post(
		url,
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "bridge-e2e", version: "1.0" },
			},
		},
		{ Authorization: `Bearer ${token}` },
	);
	if (res.status !== 200) {
		throw new Error(`MCP initialize failed: HTTP ${res.status} ${res.body.slice(0, 200)}`);
	}
	return { url, token, sessionId: res.headers["mcp-session-id"] ?? "" };
}

/** Send a JSON-RPC request on an established session. Returns the parsed envelope. */
export async function mcpRequest(
	session: McpSession,
	method: string,
	params?: unknown,
): Promise<{ status: number; envelope: unknown }> {
	const headers: Record<string, string> = { Authorization: `Bearer ${session.token}` };
	if (session.sessionId) headers["Mcp-Session-Id"] = session.sessionId;
	const res = await post(
		session.url,
		{ jsonrpc: "2.0", id: Date.now(), method, params },
		headers,
	);
	return { status: res.status, envelope: res.body ? parseJsonOrSse(res.body) : null };
}

export interface ToolResult {
	text: string;
	isError: boolean;
}

/**
 * Call a tool and return its text content + isError flag. Throws only on a
 * JSON-RPC transport/protocol error; tool-level failures (isError) are returned
 * so callers can assert rejection paths (e.g. "Change rejected by user.").
 */
export async function mcpCallTool(
	session: McpSession,
	name: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const { envelope } = await mcpRequest(session, "tools/call", { name, arguments: args });
	const env = envelope as {
		error?: { message?: string };
		result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
	};
	if (env.error) throw new Error(`tools/call ${name} JSON-RPC error: ${env.error.message}`);
	const text = (env.result?.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
	return { text, isError: env.result?.isError === true };
}
