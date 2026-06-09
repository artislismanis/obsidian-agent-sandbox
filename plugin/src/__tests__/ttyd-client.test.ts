import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock obsidian's requestUrl before importing ttyd-client
vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

import { requestUrl } from "obsidian";
import {
	pollUntilReady,
	buildWsUrl,
	encodeInputFrames,
	exponentialBackoff,
	reconnectDelayMs,
	RECONNECT_BACKOFF_MS,
	resolveTtydBrowserUrl,
} from "../ttyd-client";

const mockRequestUrl = requestUrl as ReturnType<typeof vi.fn>;

beforeEach(() => {
	mockRequestUrl.mockReset();
});

describe("pollUntilReady", () => {
	it("returns true when server responds 200", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200 });
		const result = await pollUntilReady(7681, 3, 10, () => false);
		expect(result).toBe(true);
	});

	it("retries on error and eventually succeeds", async () => {
		mockRequestUrl
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockResolvedValueOnce({ status: 200 });

		const result = await pollUntilReady(7681, 5, 10, () => false);
		expect(result).toBe(true);
		expect(mockRequestUrl).toHaveBeenCalledTimes(3);
	});

	it("returns false after all retries exhausted", async () => {
		mockRequestUrl.mockRejectedValue(new Error("ECONNREFUSED"));
		const result = await pollUntilReady(7681, 3, 10, () => false);
		expect(result).toBe(false);
		expect(mockRequestUrl).toHaveBeenCalledTimes(3);
	});

	it("aborts early when isAborted returns true", async () => {
		let aborted = false;
		mockRequestUrl.mockRejectedValue(new Error("ECONNREFUSED"));

		const result = await pollUntilReady(7681, 10, 10, () => {
			if (mockRequestUrl.mock.calls.length >= 2) aborted = true;
			return aborted;
		});

		expect(result).toBe(false);
		expect(mockRequestUrl.mock.calls.length).toBeLessThan(10);
	});

	it("returns false for non-OK non-401 status", async () => {
		mockRequestUrl.mockResolvedValue({ status: 500 });
		const result = await pollUntilReady(7681, 2, 10, () => false);
		expect(result).toBe(false);
	});
});

describe("encodeInputFrames", () => {
	const INPUT_CMD = 0x30; // '0'

	it("empty string produces one frame containing only the command byte", () => {
		const frames = encodeInputFrames("");
		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual(new Uint8Array([INPUT_CMD]));
	});

	it("small input produces one frame with correct prefix and payload", () => {
		const text = "hello";
		const frames = encodeInputFrames(text);
		expect(frames).toHaveLength(1);
		const expected = new Uint8Array([INPUT_CMD, ...new TextEncoder().encode(text)]);
		expect(frames[0]).toEqual(expected);
	});

	it("input exactly at chunk size produces one frame", () => {
		const chunkBytes = 4;
		const text = "abcd"; // exactly 4 bytes
		const frames = encodeInputFrames(text, chunkBytes);
		expect(frames).toHaveLength(1);
		expect(frames[0][0]).toBe(INPUT_CMD);
		expect(frames[0].length).toBe(5); // 1 cmd + 4 payload
	});

	it("input larger than chunk size splits into ordered frames covering all bytes", () => {
		const chunkBytes = 4;
		const text = "abcdefgh"; // 8 bytes → 2 chunks
		const frames = encodeInputFrames(text, chunkBytes);
		expect(frames).toHaveLength(2);
		for (const frame of frames) expect(frame[0]).toBe(INPUT_CMD);
		const payload = new Uint8Array([...frames[0].subarray(1), ...frames[1].subarray(1)]);
		expect(payload).toEqual(new TextEncoder().encode(text));
	});

	it("multibyte UTF-8 chars: payload bytes equal TextEncoder output", () => {
		const text = "héllo"; // 'é' is 2 UTF-8 bytes
		const frames = encodeInputFrames(text);
		expect(frames).toHaveLength(1);
		expect(frames[0].subarray(1)).toEqual(new TextEncoder().encode(text));
	});
});

describe("buildWsUrl", () => {
	it("defaults to 127.0.0.1 when no bind address given", () => {
		expect(buildWsUrl(7681)).toBe("ws://127.0.0.1:7681/ws");
	});

	it("uses custom port", () => {
		expect(buildWsUrl(8080)).toBe("ws://127.0.0.1:8080/ws");
	});

	it("normalises 0.0.0.0 to loopback (Obsidian connects from the host)", () => {
		expect(buildWsUrl(7681, "0.0.0.0")).toBe("ws://127.0.0.1:7681/ws");
	});

	it("honours non-loopback bind addresses", () => {
		expect(buildWsUrl(7681, "192.168.1.5")).toBe("ws://192.168.1.5:7681/ws");
	});

	it("treats empty/whitespace as loopback", () => {
		expect(buildWsUrl(7681, "")).toBe("ws://127.0.0.1:7681/ws");
		expect(buildWsUrl(7681, "  ")).toBe("ws://127.0.0.1:7681/ws");
	});
});

// QA 2.11: connection retry backoff (500ms × 1.5^n, capped at 5s).
describe("exponentialBackoff", () => {
	it("starts at 500ms", () => {
		expect(exponentialBackoff(0)).toBe(500);
	});

	it("grows by 1.5× each attempt", () => {
		expect(exponentialBackoff(1)).toBe(750);
		expect(exponentialBackoff(2)).toBe(1125);
		expect(exponentialBackoff(3)).toBe(1688);
	});

	it("caps at 5000ms", () => {
		// 500·1.5^6 ≈ 5696 > cap; everything from here on is clamped.
		expect(exponentialBackoff(6)).toBe(5000);
		expect(exponentialBackoff(14)).toBe(5000);
	});

	it("never exceeds the cap across the full retry window", () => {
		for (let i = 0; i < 15; i++) {
			expect(exponentialBackoff(i)).toBeLessThanOrEqual(5000);
		}
	});
});

// Reconnect give-up decision used by TerminalView.scheduleReconnect.
describe("reconnectDelayMs", () => {
	it("follows the schedule for each attempt already made", () => {
		RECONNECT_BACKOFF_MS.forEach((expected, i) => {
			expect(reconnectDelayMs(i)).toBe(expected);
		});
	});

	it("starts patient and plateaus at 8s", () => {
		expect(reconnectDelayMs(0)).toBe(500);
		expect(reconnectDelayMs(RECONNECT_BACKOFF_MS.length - 1)).toBe(8000);
	});

	it("gives up once the schedule is exhausted", () => {
		expect(reconnectDelayMs(RECONNECT_BACKOFF_MS.length)).toBeNull();
		expect(reconnectDelayMs(RECONNECT_BACKOFF_MS.length + 5)).toBeNull();
	});
});

// QA 2.7: "Open in Browser" URL. Loopback/unset → localhost (browsers may not
// resolve bare IP literals); a LAN bind address is kept verbatim.
describe("resolveTtydBrowserUrl", () => {
	it("uses localhost for an unset bind address", () => {
		expect(resolveTtydBrowserUrl(7681, undefined)).toBe("http://localhost:7681");
	});

	it("maps loopback / wildcard literals to localhost", () => {
		expect(resolveTtydBrowserUrl(7681, "127.0.0.1")).toBe("http://localhost:7681");
		expect(resolveTtydBrowserUrl(7681, "0.0.0.0")).toBe("http://localhost:7681");
		expect(resolveTtydBrowserUrl(7681, "::1")).toBe("http://localhost:7681");
	});

	it("keeps a LAN bind address verbatim", () => {
		expect(resolveTtydBrowserUrl(8080, "192.168.1.50")).toBe("http://192.168.1.50:8080");
	});

	it("trims surrounding whitespace before deciding", () => {
		expect(resolveTtydBrowserUrl(7681, "  127.0.0.1  ")).toBe("http://localhost:7681");
	});
});
