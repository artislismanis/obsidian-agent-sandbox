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
