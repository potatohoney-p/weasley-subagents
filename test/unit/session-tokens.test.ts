import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseSessionTokens } from "../../src/shared/session-tokens.ts";

function withSession(lines: string[], check: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "session-token-validation-"));
	try {
		writeFileSync(join(dir, "session.jsonl"), lines.join("\n"));
		check(dir);
	} finally { rmSync(dir, { recursive: true, force: true }); }
}
const record = (usage: unknown) => JSON.stringify({ message: { usage } });

describe("persisted session token validation", () => {
	it("preserves aliases, top-level precedence, missing fields and recorded zero", () => {
		withSession([
			JSON.stringify({ usage: { inputTokens: 0, input: 99, outputTokens: 2 }, message: { usage: { input: 900 } } }),
			record({ input: 3, output: 4 }), record({ inputTokens: null, input: 5 }),
			record({ outputTokens: 6 }), record({}), "", "not JSON", "null", "[]",
		], dir => assert.deepEqual(parseSessionTokens(dir), { input: 8, output: 12, total: 20 }));
	});
	for (const value of ["12", -1, 0.5, true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
		for (const field of ["inputTokens", "outputTokens", "input", "output"]) {
			it(`rejects invalid ${field} ${JSON.stringify(value)} without returning a partial sum`, () => {
				withSession([record({ input: 5, output: 2 }), record({ [field]: value }), record({ input: 9 })],
					dir => assert.equal(parseSessionTokens(dir), null));
			});
		}
	}
	for (const usage of [false, 0, "", "bad", []]) {
		it(`rejects non-object usage ${JSON.stringify(usage)}`, () => {
			withSession([record(usage)], dir => assert.equal(parseSessionTokens(dir), null));
		});
	}
	it("rejects JSON numeric overflow", () => {
		withSession(['{"usage":{"input":1e400}}'], dir => assert.equal(parseSessionTokens(dir), null));
	});
	it("rejects unsafe aggregate totals even if individual counts are safe", () => {
		for (const lines of [
			[record({ input: Number.MAX_SAFE_INTEGER }), record({ input: 1 })],
			[record({ output: Number.MAX_SAFE_INTEGER }), record({ output: 1 })],
			[record({ input: Number.MAX_SAFE_INTEGER, output: 1 })],
		]) withSession(lines, dir => assert.equal(parseSessionTokens(dir), null));
	});
	it("allows the largest safe aggregate and does not coerce an invalid preferred alias", () => {
		withSession([record({ input: Number.MAX_SAFE_INTEGER - 1, output: 1 })], dir =>
			assert.deepEqual(parseSessionTokens(dir), { input: Number.MAX_SAFE_INTEGER - 1, output: 1, total: Number.MAX_SAFE_INTEGER }));
		withSession([record({ inputTokens: "bad", input: 7 })], dir => assert.equal(parseSessionTokens(dir), null));
	});
	it("preserves latest-file selection and unavailable lookup behavior", () => {
		withSession([record({ input: 1 })], dir => {
			const latest = join(dir, "latest.jsonl");
			writeFileSync(latest, record({ input: 8 }));
			utimesSync(join(dir, "session.jsonl"), new Date(1000), new Date(1000));
			utimesSync(latest, new Date(2000), new Date(2000));
			assert.deepEqual(parseSessionTokens(dir), { input: 8, output: 0, total: 8 });
			assert.equal(parseSessionTokens(join(dir, "missing")), null);
		});
	});
});
