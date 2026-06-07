export function formatUptime(startedAt: string): string {
	const elapsed = Date.now() - new Date(startedAt).getTime();
	if (isNaN(elapsed) || elapsed < 0) return "unknown";
	const totalSecs = Math.floor(elapsed / 1000);
	const days = Math.floor(totalSecs / 86400);
	const hours = Math.floor((totalSecs % 86400) / 3600);
	const mins = Math.floor((totalSecs % 3600) / 60);
	if (days > 0) return `${days}d ${hours}h ${mins}m`;
	if (hours > 0) return `${hours}h ${mins}m`;
	return `${mins}m`;
}

/** Compose the multi-line body for the "Sandbox: Container Status" notice. */
export function buildContainerStatusLines(
	info: { id?: string; image?: string; startedAt?: string } | null,
	opts: { mcpRunning: boolean; mcpPort: number; firewall: "on" | "off" | "unknown" },
): string[] {
	const lines = ["Sandbox: Running"];
	if (info?.id) lines.push(`ID: ${info.id.slice(0, 12)}`);
	if (info?.image) lines.push(`Image: ${info.image}`);
	if (info?.startedAt) lines.push(`Up: ${formatUptime(info.startedAt)}`);
	lines.push(`MCP: ${opts.mcpRunning ? `on (port ${opts.mcpPort})` : "off"}`);
	lines.push(`Firewall: ${opts.firewall}`);
	return lines;
}
