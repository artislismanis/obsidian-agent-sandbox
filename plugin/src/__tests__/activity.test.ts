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
import { VIEW_TYPE_TERMINAL } from "../view-types";

type NoticeMock = typeof Notice & { lastMessage: string; lastTimeout: number | undefined };

describe("AgentOutputNotifier", () => {
	let notifyCreated = true;
	let notifyEdited = false;
	let notifyDeleted = true;
	let notifyRenamed = true;
	let vaultWide = false;
	let dir = "agent-workspace";
	let userEditTtl = 10;

	beforeEach(() => {
		vi.useFakeTimers();
		notifyCreated = true;
		notifyEdited = false;
		notifyDeleted = true;
		notifyRenamed = true;
		vaultWide = false;
		dir = "agent-workspace";
		userEditTtl = 10;
		(Notice as NoticeMock).lastMessage = "";
		(Notice as NoticeMock).lastTimeout = undefined;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function notifier() {
		return new AgentOutputNotifier(
			() => notifyCreated,
			() => notifyEdited,
			() => notifyDeleted,
			() => notifyRenamed,
			() => vaultWide,
			() => dir,
			() => userEditTtl,
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

	it("ignores modify events when notifyEdited is false", () => {
		const n = notifier();
		n.onModify("agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
	});

	it("fires for modify events when notifyEdited is true", () => {
		notifyEdited = true;
		const n = notifier();
		n.onModify("agent-workspace/b.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent modified agent-workspace/b.md");
	});

	it("fires for delete events when notifyDeleted is true", () => {
		const n = notifier();
		n.onDelete("agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent deleted agent-workspace/a.md");
	});

	it("ignores delete events when notifyDeleted is false", () => {
		notifyDeleted = false;
		const n = notifier();
		n.onDelete("agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
	});

	it("fires for rename events when notifyRenamed is true", () => {
		const n = notifier();
		n.onRename("agent-workspace/b.md", "agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe(
			"Agent renamed agent-workspace/a.md → agent-workspace/b.md",
		);
	});

	it("ignores rename events when notifyRenamed is false", () => {
		notifyRenamed = false;
		const n = notifier();
		n.onRename("agent-workspace/b.md", "agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
	});

	it("ignores paths outside the write directory", () => {
		const n = notifier();
		n.onCreate("other/path.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
	});

	it("vault-wide scope fires for paths outside the write directory", () => {
		vaultWide = true;
		const n = notifier();
		n.onCreate("other/path.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent created other/path.md");
	});

	it("all-off suppresses everything", () => {
		notifyCreated = false;
		notifyEdited = false;
		notifyDeleted = false;
		notifyRenamed = false;
		const n = notifier();
		n.onCreate("agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
	});

	it("suppresses notifications when the user recently edited the file (markUserEdit)", () => {
		const n = notifier();
		n.markUserEdit("agent-workspace/a.md");
		n.onCreate("agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
	});

	it("resumes notifications after user-edit TTL expires", () => {
		userEditTtl = 5;
		const n = notifier();
		n.markUserEdit("agent-workspace/a.md");
		vi.advanceTimersByTime(5001); // TTL expires
		n.onCreate("agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent created agent-workspace/a.md");
	});

	it("suppresses modify that immediately follows a create for the same path", () => {
		notifyEdited = true;
		const n = notifier();
		n.onCreate("agent-workspace/a.md");
		n.onModify("agent-workspace/a.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent created agent-workspace/a.md");
	});

	it("allows modify on a different path after a create", () => {
		notifyEdited = true;
		const n = notifier();
		n.onCreate("agent-workspace/a.md");
		n.onModify("agent-workspace/b.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent output: 1 created, 1 modified");
	});

	it("resumes modify notifications after create-suppress TTL expires", () => {
		notifyCreated = false; // suppress debounce/rate-limit from the create itself
		notifyEdited = true;
		const n = notifier();
		n.onCreate("agent-workspace/a.md"); // stamps TTL only, no enqueue
		vi.advanceTimersByTime(3001); // CREATE_MODIFY_SUPPRESS_MS expires
		n.onModify("agent-workspace/a.md"); // should NOT be suppressed
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent modified agent-workspace/a.md");
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
		// Debounce fires inside the rate-limit window - should NOT emit yet.
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
		// Rate-limit window elapses and the re-armed timer fires.
		vi.advanceTimersByTime(3000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent output: 2 created");
	});

	it("second burst after rate-limit window starts fresh (no cross-burst leakage)", () => {
		const n = notifier();
		// First burst - 3 files
		n.onCreate("agent-workspace/a.md");
		n.onCreate("agent-workspace/b.md");
		n.onCreate("agent-workspace/c.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent output: 3 created");

		// During rate-limit hold: 2 new events arrive.
		(Notice as NoticeMock).lastMessage = "";
		n.onCreate("agent-workspace/d.md");
		n.onCreate("agent-workspace/e.md");
		vi.advanceTimersByTime(2000); // debounce fires inside hold → held
		expect((Notice as NoticeMock).lastMessage).toBe("");
		vi.advanceTimersByTime(3000); // rate-limit expires → emit exactly 2
		expect((Notice as NoticeMock).lastMessage).toBe("Agent output: 2 created");
	});

	it("mixed kinds in one batch produce correct counts", () => {
		notifyEdited = true;
		const n = notifier();
		n.onCreate("agent-workspace/a.md");
		n.onModify("agent-workspace/b.md");
		n.onDelete("agent-workspace/c.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe(
			"Agent output: 1 created, 1 modified, 1 deleted",
		);
	});

	it("dispose() clears pending timer and buffer", () => {
		const n = notifier();
		n.onCreate("agent-workspace/a.md");
		n.dispose();
		vi.advanceTimersByTime(10000);
		expect((Notice as NoticeMock).lastMessage).toBe("");
	});

	it("emitBatch includes 'renamed' count when batch has renames", () => {
		const n = notifier();
		n.onRename("agent-workspace/a-new.md", "agent-workspace/a.md");
		n.onRename("agent-workspace/b-new.md", "agent-workspace/b.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe("Agent output: 2 renamed");
	});

	it("emitBatch includes 'deleted' and 'renamed' counts together", () => {
		notifyEdited = true;
		const n = notifier();
		n.onDelete("agent-workspace/a.md");
		n.onRename("agent-workspace/b-new.md", "agent-workspace/b.md");
		n.onModify("agent-workspace/c.md");
		vi.advanceTimersByTime(2000);
		expect((Notice as NoticeMock).lastMessage).toBe(
			"Agent output: 1 modified, 1 deleted, 1 renamed",
		);
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
				on: vi.fn(() => ({})),
				offref: vi.fn(),
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

describe("ActivityUi per-tab routing", () => {
	/** Build a live-leaf stub satisfying isTerminalViewLike. */
	function makeLeaf(routingKey: string, sessionName: string | null = null) {
		const setActivityPrefix = vi.fn();
		const view = {
			getViewType: () => VIEW_TYPE_TERMINAL,
			getSessionName: () => sessionName,
			getRoutingKey: () => routingKey,
			setActivityPrefix,
		};
		return { leaf: { view }, setActivityPrefix };
	}

	function fixtureWithLeaves(leaves: { leaf: { view: unknown } }[]) {
		const setAttention = vi.fn();
		const statusBar = { setAttention, setDetails: vi.fn(), getState: () => "running" };
		const activity = new Map<string, ActivityEntry>();
		const app = {
			workspace: {
				getLeavesOfType: () => leaves.map((l) => l.leaf),
				on: vi.fn(() => ({})),
				offref: vi.fn(),
			},
		};
		const ui = new ActivityUi(app as never, statusBar as never, () => activity);
		return { ui, activity, setAttention };
	}

	it("routes to the matching unnamed tab only, not its sibling", () => {
		const tab1 = makeLeaf("oas-tab-1");
		const tab2 = makeLeaf("oas-tab-2");
		const { ui } = fixtureWithLeaves([tab1, tab2]);

		ui.route({ sessionName: "oas-tab-1", status: "working" });

		expect(tab1.setActivityPrefix).toHaveBeenCalledWith("working");
		expect(tab2.setActivityPrefix).not.toHaveBeenCalled();
	});

	it("routes to the correct tab when the other tab fires", () => {
		const tab1 = makeLeaf("oas-tab-1");
		const tab2 = makeLeaf("oas-tab-2");
		const { ui } = fixtureWithLeaves([tab1, tab2]);

		ui.route({ sessionName: "oas-tab-2", status: "awaiting_input" });

		expect(tab2.setActivityPrefix).toHaveBeenCalledWith("awaiting_input");
		expect(tab1.setActivityPrefix).not.toHaveBeenCalled();
	});

	it("routes named tab by sessionName", () => {
		const named = makeLeaf("work", "work");
		const unnamed = makeLeaf("oas-tab-3");
		const { ui } = fixtureWithLeaves([named, unnamed]);

		ui.route({ sessionName: "work", status: "idle" });

		expect(named.setActivityPrefix).toHaveBeenCalledWith("idle");
		expect(unnamed.setActivityPrefix).not.toHaveBeenCalled();
	});

	it("orphaned per-tab activity entries don't inflate the attention badge", () => {
		// tab is open, oas-tab-1 should count
		const tab1 = makeLeaf("oas-tab-1");
		const { ui, activity, setAttention } = fixtureWithLeaves([tab1]);

		// oas-tab-99 is a closed tab that was left in the activity map
		activity.set("oas-tab-1", { status: "awaiting_input", updatedAt: Date.now() });
		activity.set("oas-tab-99", { status: "awaiting_input", updatedAt: Date.now() });

		ui.route({ sessionName: "oas-tab-1", status: "awaiting_input" });

		// Only the live tab's entry should count
		expect(setAttention).toHaveBeenLastCalledWith(1, ["(unnamed)"]);
	});

	it("named session entries always count regardless of open leaves", () => {
		// No leaves open at all
		const { ui, activity, setAttention } = fixtureWithLeaves([]);

		activity.set("work", { status: "awaiting_input", updatedAt: Date.now() });
		ui.route({ sessionName: "other", status: "idle" });

		expect(setAttention).toHaveBeenLastCalledWith(1, ["work"]);
	});

	it("per-tab keys render as '(unnamed)' in attention names", () => {
		const tab1 = makeLeaf("oas-tab-5");
		const { ui, activity, setAttention } = fixtureWithLeaves([tab1]);

		activity.set("oas-tab-5", { status: "awaiting_input", updatedAt: Date.now() });
		ui.route({ sessionName: "oas-tab-5", status: "awaiting_input" });

		expect(setAttention).toHaveBeenLastCalledWith(1, ["(unnamed)"]);
	});
});
