import { describe, it, expect, vi } from "vitest";
import { FirewallStatusBar, StatusBarManager } from "../status-bar";

function createMockElement(): HTMLElement {
	const el = {
		setText: vi.fn(),
		addClass: vi.fn(),
		toggleClass: vi.fn(),
		setAttribute: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		style: { display: "" },
	};
	return el as unknown as HTMLElement;
}

/** Find the last aria-label value from setAttribute mock calls. */
function lastTooltip(el: HTMLElement): string {
	const calls = (el.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
	return [...calls].reverse().find((c) => c[0] === "aria-label")?.[1] as string;
}

describe("StatusBarManager", () => {
	it("renders stopped state on construction", () => {
		const el = createMockElement();
		new StatusBarManager(el);
		expect(el.setText).toHaveBeenCalledWith("Sandbox: ⏹ Stopped");
	});

	it("updates display on setState", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setState("running");
		expect(el.setText).toHaveBeenCalledWith("Sandbox: ▶ Running");
	});

	it("shows starting state", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setState("starting");
		expect(el.setText).toHaveBeenCalledWith("Sandbox: ⏳ Starting");
	});

	it("shows error state", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setState("error");
		expect(el.setText).toHaveBeenCalledWith("Sandbox: ⚠ Error");
	});

	it("shows checking state", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setState("checking");
		expect(el.setText).toHaveBeenCalledWith("Sandbox: 🔍 Checking");
	});

	it("shows bell badge when sessions await input", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setState("running");
		mgr.setAttention(2, ["work", "research"]);
		expect(el.setText).toHaveBeenLastCalledWith("Sandbox: ▶ Running 🔔");
	});

	it("shows no badge without attention", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setState("running");
		expect(el.setText).toHaveBeenLastCalledWith("Sandbox: ▶ Running");
	});

	it("skips render when state unchanged", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		(el.setText as ReturnType<typeof vi.fn>).mockClear();
		mgr.setState("stopped"); // already stopped
		expect(el.setText).not.toHaveBeenCalled();
	});

	it("sets tooltip via setDetails", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setDetails("Container: running\nPort: 7681");
		expect(el.setAttribute).toHaveBeenCalledWith(
			"aria-label",
			"Container: running\nPort: 7681",
		);
	});

	const baseCtx = {
		port: 7681,
		firewall: "enabled" as const,
		mcp: { running: false, port: 3000, toolCount: 0 },
	};

	it("running tooltip includes pending-restart line when pendingRestart is true", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setState("running");
		mgr.setRunningTooltipContext({ ...baseCtx, pendingRestart: true });
		expect(lastTooltip(el)).toContain("↺ Settings restart pending");
	});

	it("running tooltip omits pending-restart line when pendingRestart is false", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setState("running");
		mgr.setRunningTooltipContext({ ...baseCtx, pendingRestart: false });
		expect(lastTooltip(el)).not.toContain("↺ Settings restart pending");
	});

	it("running tooltip omits pending-restart line when pendingRestart is absent", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setState("running");
		mgr.setRunningTooltipContext({ ...baseCtx });
		expect(lastTooltip(el)).not.toContain("↺ Settings restart pending");
	});

	it("pending-restart line is suppressed by attention override", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setState("running");
		mgr.setRunningTooltipContext({ ...baseCtx, pendingRestart: true });
		mgr.setAttention(1, ["work"]);
		const tooltip = lastTooltip(el);
		expect(tooltip).not.toContain("↺ Settings restart pending");
		expect(tooltip).toContain("1 session(s) awaiting input");
	});
});

describe("FirewallStatusBar", () => {
	it("starts hidden", () => {
		const el = createMockElement();
		new FirewallStatusBar(el, vi.fn());
		expect(el.toggleClass).toHaveBeenCalledWith("sandbox-statusbar-hidden", true);
	});

	it("shows enabled state with success class", () => {
		const el = createMockElement();
		const bar = new FirewallStatusBar(el, vi.fn());
		bar.setState("enabled");
		// Visibility is driven by the `sandbox-statusbar-hidden` class, not
		// style.display: enabled state means the class is toggled off.
		expect(el.toggleClass).toHaveBeenCalledWith("sandbox-statusbar-hidden", false);
		expect(el.setText).toHaveBeenCalledWith("🛡 FW");
		expect(el.toggleClass).toHaveBeenCalledWith("firewall-enabled", true);
		expect(el.toggleClass).toHaveBeenCalledWith("firewall-disabled", false);
	});

	it("shows disabled state with muted class", () => {
		const el = createMockElement();
		const bar = new FirewallStatusBar(el, vi.fn());
		bar.setState("disabled");
		expect(el.toggleClass).toHaveBeenCalledWith("firewall-enabled", false);
		expect(el.toggleClass).toHaveBeenCalledWith("firewall-disabled", true);
	});

	it("hides when set to hidden", () => {
		const el = createMockElement();
		const bar = new FirewallStatusBar(el, vi.fn());
		bar.setState("enabled");
		bar.setState("hidden");
		expect(el.toggleClass).toHaveBeenCalledWith("sandbox-statusbar-hidden", true);
	});

	it("skips render on duplicate state", () => {
		const el = createMockElement();
		const bar = new FirewallStatusBar(el, vi.fn());
		bar.setState("enabled");
		(el.setText as ReturnType<typeof vi.fn>).mockClear();
		bar.setState("enabled");
		expect(el.setText).not.toHaveBeenCalled();
	});

	it("returns current state via getState", () => {
		const el = createMockElement();
		const bar = new FirewallStatusBar(el, vi.fn());
		expect(bar.getState()).toBe("hidden");
		bar.setState("enabled");
		expect(bar.getState()).toBe("enabled");
	});

	it("registers click handler", () => {
		const el = createMockElement();
		const handler = vi.fn();
		new FirewallStatusBar(el, handler);
		expect(el.addEventListener).toHaveBeenCalledWith("click", handler);
	});

	it("removes click handler on destroy", () => {
		const el = createMockElement();
		const handler = vi.fn();
		const bar = new FirewallStatusBar(el, handler);
		bar.destroy();
		expect(el.removeEventListener).toHaveBeenCalledWith("click", handler);
	});
});
