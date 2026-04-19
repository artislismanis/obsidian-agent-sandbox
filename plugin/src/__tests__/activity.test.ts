import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
	class NoticeStub {
		static lastMessage = "";
		static lastTimeout: number | undefined;
		constructor(message: string, timeout?: number) {
			NoticeStub.lastMessage = message;
			NoticeStub.lastTimeout = timeout;
		}
	}
	return { Notice: NoticeStub };
});

import { Notice } from "obsidian";
import { ActivityUi, AgentOutputNotifier } from "../activity";
import type { ActivityEntry } from "../mcp-server";

type NoticeMock = typeof Notice & { lastMessage: string; lastTimeout: number | undefined };

describe("AgentOutputNotifier", () => {
	let mode: "new" | "new_or_modified" | "off" = "new";
	let dir = "agent-workspace";

	beforeEach(() => {
		vi.useFakeTimers();
		mode = "new";
		dir = "agent-workspace";
		(Notice as NoticeMock).lastMessage = "";
		(Notice as NoticeMock).lastTimeout = undefined;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function notifier() {
		return new AgentOutputNotifier(
			() => mode,
			() => dir,
		);
	}

	it("fires a single notice for one create after debounce elapses", () => {
		const n = notifier();
		n.onCreate("agent-workspace/a.md");
		expect((Notice as NoticeMock).lastMessage).toBe("");
		vi.advanceTimersByTime(1999);
		expect((Notice as NoticeMock).lastMessage).toBe("");
		vi.advanceTimersByTime(1);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent created agent-workspace/a.md");
	});

	it("aggregates burst of creates into one notice", () => {
		const n = notifier();
		n.onCreate("agent-workspace/a.md");
		n.onCreate("agent-workspace/b.md");
		n.onCreate("agent-workspace/c.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent output: 3 created");
	});

	it("ignores modify events unless mode is new_or_modified", () => {
		const n = notifier();
		n.onModify("agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");

		mode = "new_or_modified";
		n.onModify("agent-workspace/b.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent modified agent-workspace/b.md");
	});

	it("ignores paths outside the write directory", () => {
		const n = notifier();
		n.onCreate("other/path.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
	});

	it("off mode suppresses everything", () => {
		mode = "off";
		const n = notifier();
		n.onCreate("agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
	});

	it("requeues buffered events under rate-limit instead of dropping them", () => {
		const n = notifier();
		n.onCreate("agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent created agent-workspace/a.md");

		// Second burst arrives during the 5s rate-limit window.
		(Notice as NoticeMock).lastMessage = "";
		n.onCreate("agent-workspace/b.md");
		n.onCreate("agent-workspace/c.md");
		// Debounce fires inside the rate-limit window — should NOT emit yet.
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
		// Rate-limit window elapses and the re-armed timer fires.
		vi.advanceTimersByTime(3000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent output: 2 created");
	});

	it("dispose() clears pending timer and buffer", () => {
		const n = notifier();
		n.onCreate("agent-workspace/a.md");
		n.dispose();
		vi.advanceTimersByTime(10000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
	});
});

describe("ActivityUi.refreshDefaultTooltip on transition to zero", () => {
	function fixture() {
		const refresh = vi.fn();
		let statusBarCount = 0;
		const statusBar = {
			setAttentionCount: (n: number) => {
				statusBarCount = n;
			},
			setDetails: vi.fn(),
			getState: () => "running",
		};
		const activity = new Map<string, ActivityEntry>();
		const app = {
			workspace: {
				getLeavesOfType: () => [] as unknown[],
			},
		};
		const ui = new ActivityUi(app as never, statusBar as never, () => activity, refresh);
		return { ui, activity, refresh, getCount: () => statusBarCount, statusBar };
	}

	it("calls refresh when transitioning from waiting>0 to zero", () => {
		const { ui, activity, refresh } = fixture();
		activity.set("work", { status: "awaiting_input", updatedAt: Date.now() });
		ui.route({ sessionName: "work", status: "awaiting_input" });
		expect(refresh).not.toHaveBeenCalled();

		activity.set("work", { status: "idle", updatedAt: Date.now() });
		ui.route({ sessionName: "work", status: "idle" });
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("does not call refresh while still >0", () => {
		const { ui, activity, refresh } = fixture();
		activity.set("a", { status: "awaiting_input", updatedAt: Date.now() });
		activity.set("b", { status: "awaiting_input", updatedAt: Date.now() });
		ui.route({ sessionName: "a", status: "awaiting_input" });
		ui.route({ sessionName: "b", status: "awaiting_input" });
		expect(refresh).not.toHaveBeenCalled();

		activity.set("a", { status: "idle", updatedAt: Date.now() });
		ui.route({ sessionName: "a", status: "idle" });
		// One still waiting — no refresh yet.
		expect(refresh).not.toHaveBeenCalled();
	});

	it("clear() refreshes tooltip when last count was nonzero", () => {
		const { ui, activity, refresh } = fixture();
		activity.set("work", { status: "awaiting_input", updatedAt: Date.now() });
		ui.route({ sessionName: "work", status: "awaiting_input" });

		activity.clear();
		ui.clear();
		expect(refresh).toHaveBeenCalled();
	});

	it("clear() does not refresh tooltip if there was no active override", () => {
		const { ui, refresh } = fixture();
		ui.clear();
		expect(refresh).not.toHaveBeenCalled();
	});
});
