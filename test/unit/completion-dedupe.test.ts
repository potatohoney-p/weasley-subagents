import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCompletionKey, markSeenWithTtl } from "../../src/runs/background/completion-dedupe.ts";

describe("buildCompletionKey", () => {
	it("scopes ids to their owning session", () => {
		const first = buildCompletionKey({ id: "run-123", sessionId: "session-a" }, "fallback");
		const second = buildCompletionKey({ id: "run-123", sessionId: "session-b" }, "fallback");
		assert.deepEqual(JSON.parse(first), ["id", "session-a", "run-123"]);
		assert.notEqual(first, second);
	});

	it("builds deterministic fallback key when id is missing", () => {
		const first = buildCompletionKey({ agent: "reviewer", timestamp: 123, taskIndex: 1, totalTasks: 2, success: true }, "x");
		const second = buildCompletionKey({ agent: "reviewer", timestamp: 123, taskIndex: 1, totalTasks: 2, success: true }, "x");
		assert.equal(first, second);
	});
});

describe("completion identity collisions", () => {
	const cases = [
		[{ sessionId: "a:id:b", id: "c" }, { sessionId: "a", id: "b:id:c" }],
		[{ id: "c" }, { sessionId: "no-session", id: "c" }],
		[{ sessionId: "a:b", agent: "c" }, { sessionId: "a", agent: "b:c" }],
		[{ agent: "worker" }, { sessionId: "no-session", agent: "worker" }],
		[{ sessionId: "a" }, { sessionId: "a", agent: "unknown" }],
	];
	for (const [index, [first, second]] of cases.entries()) {
		it(`retains distinct identity pair ${index}`, () => {
			const seen = new Map<string, number>();
			assert.equal(markSeenWithTtl(seen, buildCompletionKey(first, "notify"), 10, 1000), false);
			assert.equal(markSeenWithTtl(seen, buildCompletionKey(second, "notify"), 11, 1000), false);
			assert.equal(markSeenWithTtl(seen, buildCompletionKey(first, "notify"), 12, 1000), true);
		});
	}
	it("preserves exact identity and normalization regardless of fallback", () => {
		assert.equal(buildCompletionKey({ sessionId: " a ", id: " b " }, "x"), buildCompletionKey({ sessionId: "a", id: "b" }, "y"));
	});
	it("keeps escaped and Unicode identity components distinct", () => {
		const ids = ["a:b", "a\\b", 'a"b', "a\n b", "a\0b", "한글", "null"];
		assert.equal(new Set(ids.map(id => buildCompletionKey({ sessionId: "a", id }, "x"))).size, ids.length);
	});
});

describe("markSeenWithTtl", () => {
	it("returns true only for duplicates within ttl", () => {
		const seen = new Map<string, number>();
		const ttlMs = 1000;
		assert.equal(markSeenWithTtl(seen, "k", 100, ttlMs), false);
		assert.equal(markSeenWithTtl(seen, "k", 200, ttlMs), true);
		assert.equal(markSeenWithTtl(seen, "k", 1201, ttlMs), false);
	});
});
