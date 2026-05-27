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
		n.markMcpWrite("agent-workspace/a.md");
		n.onCreate("agent-workspace/a.md");
		expect((Notice as NoticeMock).lastMessage).toBe("");
		vi.advanceTimersByTime(1999);
		expect((Notice as NoticeMock).lastMessage).toBe("");
		vi.advanceTimersByTime(1);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent created agent-workspace/a.md");
	});

	it("aggregates burst of creates into one notice", () => {
		const n = notifier();
		n.markMcpWrite("agent-workspace/a.md");
		n.markMcpWrite("agent-workspace/b.md");
		n.markMcpWrite("agent-workspace/c.md");
		n.onCreate("agent-workspace/a.md");
		n.onCreate("agent-workspace/b.md");
		n.onCreate("agent-workspace/c.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent output: 3 created");
	});

	it("ignores modify events unless mode is new_or_modified", () => {
		const n = notifier();
		n.markMcpWrite("agent-workspace/a.md");
		n.onModify("agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");

		mode = "new_or_modified";
		n.markMcpWrite("agent-workspace/b.md");
		n.onModify("agent-workspace/b.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent modified agent-workspace/b.md");
	});

	it("ignores paths outside the write directory", () => {
		const n = notifier();
		n.markMcpWrite("other/path.md");
		n.onCreate("other/path.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
	});

	it("off mode suppresses everything", () => {
		mode = "off";
		const n = notifier();
		n.markMcpWrite("agent-workspace/a.md");
		n.onCreate("agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
	});

	it("silently ignores creates not preceded by markMcpWrite (human edits)", () => {
		const n = notifier();
		n.onCreate("agent-workspace/a.md"); // no markMcpWrite — human edit
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
	});

	it("requeues buffered events under rate-limit instead of dropping them", () => {
		const n = notifier();
		n.markMcpWrite("agent-workspace/a.md");
		n.onCreate("agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent created agent-workspace/a.md");

		// Second burst arrives during the 5s rate-limit window.
		(Notice as NoticeMock).lastMessage = "";
		n.markMcpWrite("agent-workspace/b.md");
		n.markMcpWrite("agent-workspace/c.md");
		n.onCreate("agent-workspace/b.md");
		n.onCreate("agent-workspace/c.md");
		// Debounce fires inside the rate-limit window — should NOT emit yet.
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
		// Rate-limit window elapses and the re-armed timer fires.
		vi.advanceTimersByTime(3000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent output: 2 created");
	});

	it("second burst after rate-limit window starts fresh (no cross-burst leakage)", () => {
		const n = notifier();
		// First burst — 3 files
		n.markMcpWrite("agent-workspace/a.md");
		n.markMcpWrite("agent-workspace/b.md");
		n.markMcpWrite("agent-workspace/c.md");
		n.onCreate("agent-workspace/a.md");
		n.onCreate("agent-workspace/b.md");
		n.onCreate("agent-workspace/c.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent output: 3 created");

		// During rate-limit hold: 2 new events arrive.
		(Notice as NoticeMock).lastMessage = "";
		n.markMcpWrite("agent-workspace/d.md");
		n.markMcpWrite("agent-workspace/e.md");
		n.onCreate("agent-workspace/d.md");
		n.onCreate("agent-workspace/e.md");
		vi.advanceTimersByTime(2000); // debounce fires inside hold → held
		expect((Notice as NoticeMock).lastMessage).toBe("");
		vi.advanceTimersByTime(3000); // rate-limit expires → emit exactly 2
		expect((Notice as NoticeMock).lastMessage).toBe("Agent output: 2 created");
	});

	it("dispose() clears pending timer and buffer", () => {
		const n = notifier();
		n.markMcpWrite("agent-workspace/a.md");
		n.onCreate("agent-workspace/a.md");
		n.dispose();
		vi.advanceTimersByTime(10000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
	});
});

describe("ActivityUi attention propagation", () => {
	function fixture() {
		const setAttention = vi.fn();
		const statusBar = {
			setAttention,
			setDetails: vi.fn(),
			getState: () => "running",
		};
		const activity = new Map<string, ActivityEntry>();
		const app = {
			workspace: {
				getLeavesOfType: () => [] as unknown[],
			},
		};
		const ui = new ActivityUi(app as never, statusBar as never, () => activity);
		return { ui, activity, setAttention };
	}

	it("forwards waiting count + names to StatusBarManager.setAttention", () => {
		const { ui, activity, setAttention } = fixture();
		activity.set("work", { status: "awaiting_input", updatedAt: Date.now() });
		ui.route({ sessionName: "work", status: "awaiting_input" });
		expect(setAttention).toHaveBeenLastCalledWith(1, ["work"]);

		activity.set("work", { status: "idle", updatedAt: Date.now() });
		ui.route({ sessionName: "work", status: "idle" });
		expect(setAttention).toHaveBeenLastCalledWith(0, []);
	});

	it("aggregates multiple awaiting sessions", () => {
		const { ui, activity, setAttention } = fixture();
		activity.set("a", { status: "awaiting_input", updatedAt: Date.now() });
		activity.set("b", { status: "awaiting_input", updatedAt: Date.now() });
		ui.route({ sessionName: "a", status: "awaiting_input" });
		expect(setAttention).toHaveBeenLastCalledWith(2, ["a", "b"]);
	});

	it("clear() resets the attention badge to zero", () => {
		const { ui, activity, setAttention } = fixture();
		activity.set("work", { status: "awaiting_input", updatedAt: Date.now() });
		ui.route({ sessionName: "work", status: "awaiting_input" });

		ui.clear();
		expect(setAttention).toHaveBeenLastCalledWith(0);
	});
});
