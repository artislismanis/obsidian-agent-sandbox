import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock obsidian's requestUrl before importing ttyd-client
vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

import { requestUrl } from "obsidian";
import { pollUntilReady, buildWsUrl, encodeInputFrames } from "../ttyd-client";

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
		// Every frame starts with the command byte.
		for (const frame of frames) expect(frame[0]).toBe(INPUT_CMD);
		// Concatenated payloads equal the full UTF-8 encoding.
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
