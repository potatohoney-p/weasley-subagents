import assert from "node:assert/strict";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { waitForSubagents, type SubagentWaitDeps, type SubagentWaitParams } from "../../src/runs/background/subagent-wait.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function isError(result: unknown): boolean | undefined {
	return (result as { isError?: boolean }).isError;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "weasley-scoped-wait-"));
	const asyncDirRoot = path.join(root, "runs");
	const state = { currentSessionId: "owner", foregroundRuns: new Map() } as SubagentState;
	const probes: number[] = [];
	let polls = 0;
	const write = (id: string, status = "running", extra: object = {}) => {
		const dir = path.join(asyncDirRoot, id);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
			runId: id, mode: "single", state: status, sessionId: "owner",
			startedAt: Date.now(), lastUpdate: Date.now(), pid: 999901,
			steps: [{ agent: "reviewer", status }], ...extra,
		}));
	};
	const deps: SubagentWaitDeps = {
		state, asyncDirRoot, resultsDir: path.join(root, "results"), pollIntervalMs: 250,
		kill: (pid) => { probes.push(pid); return true; },
		now: () => polls * 250,
		backgroundWork: {
			snapshot: () => { throw new Error("unrelated provider snapshot was called"); },
			wakeChannels: () => { throw new Error("unrelated provider wake channels were read"); },
		},
	};
	return {
		root, asyncDirRoot, state, probes, write,
		polls: () => polls,
		wait: (params: SubagentWaitParams, onPoll: (poll: number) => void = () => {}, overrides: Partial<SubagentWaitDeps> = {}, signal?: AbortSignal) =>
			waitForSubagents({ timeoutMs: 2000, ...params }, signal, {
				...deps, sleep: async () => { onPoll(++polls); }, ...overrides,
			}),
		close: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

describe("scoped async fan-in", () => {
	it("waits for the first selected run, not unrelated completion or attention", async () => {
		const f = fixture();
		try {
			f.write("review-a"); f.write("review-b");
			f.write("unrelated", "running", { pid: 999999, activityState: "needs_attention" });
			const result = await f.wait({ ids: ["review-a", "review-b"] }, (poll) => {
				if (poll === 1) f.write("unrelated", "complete");
				if (poll === 2) f.write("review-b", "complete");
			}, { backgroundWork: { snapshot: () => ({ providers: [], items: [] }), wakeChannels: () => [] } });
			assert.equal(isError(result), undefined);
			assert.equal(f.polls(), 2);
			assert.match(textOf(result), /1 of 2 selected run\(s\) finished/);
			assert.match(textOf(result), /review-b/);
			assert.doesNotMatch(textOf(result), /unrelated/);
			assert.ok(!f.probes.includes(999999));
		} finally { f.close(); }
	});

	it("joins all selected runs while unrelated work and later launches stay active", async () => {
		const f = fixture();
		try {
			f.write("a"); f.write("b"); f.write("other", "running", { pid: 999999, activityState: "needs_attention" });
			const result = await f.wait({ ids: ["a", "b"], all: true }, (poll) => {
				if (poll === 1) { f.write("a", "complete"); f.write("a-later", "running", { pid: 999998 }); }
				if (poll === 2) f.write("b", "failed");
			}, { backgroundWork: { snapshot: () => ({ providers: [], items: [] }), wakeChannels: () => [] } });
			assert.equal(isError(result), undefined);
			assert.equal(f.polls(), 2);
			assert.match(textOf(result), /done.*1 complete, 1 failed/s);
			assert.match(textOf(result), /a \(complete\)/);
			assert.match(textOf(result), /b \(failed\)/);
			assert.ok(!f.probes.includes(999999) && !f.probes.includes(999998));
		} finally { f.close(); }
	});

	it("returns immediately for selected attention but not for an unrelated provider", async () => {
		const f = fixture();
		try {
			f.write("a");
			f.write("b", "running", { steps: [{ agent: "reviewer", status: "running", activityState: "needs_attention", currentTool: "contact_supervisor" }] });
			const result = await f.wait({ ids: ["a", "b"], all: true });
			assert.equal(isError(result), undefined);
			assert.equal(f.polls(), 0);
			assert.match(textOf(result), /attention required/);
			assert.match(textOf(result), /b.*Reply to any pending supervisor request/s);
		} finally { f.close(); }
	});

	it("snapshots only initially active selected runs", async () => {
		const f = fixture();
		try {
			f.write("active"); f.write("already-done", "complete");
			const result = await f.wait({ ids: ["active", "already-done"], all: true }, () => {
				f.write("already-done", "running", { pid: 999999 });
				f.write("active", "complete");
			});
			assert.equal(isError(result), undefined);
			assert.equal(f.polls(), 1);
			assert.match(textOf(result), /1 selected async run\(s\).*done/s);
			assert.ok(!f.probes.includes(999999));
		} finally { f.close(); }
	});

	it("returns without sleeping when all selected runs are already terminal", async () => {
		const f = fixture();
		try {
			f.write("a", "complete"); f.write("b", "stopped"); f.write("other");
			const result = await f.wait({ ids: ["a", "b"] });
			assert.equal(isError(result), undefined);
			assert.equal(f.polls(), 0);
			assert.match(textOf(result), /No active selected async runs/);
			assert.deepEqual(f.probes, []);
		} finally { f.close(); }
	});

	for (const [name, ids] of [
		["empty", []], ["non-array", "a"], ["duplicates", ["a", "a"]],
		["empty ID", [""]], ["whitespace", [" a"]], ["non-string", [2]],
		["dot", ["."]], ["parent", [".."]], ["slash", ["../a"]],
		["backslash", ["a\\b"]], ["NUL", ["a\0b"]], ["control", ["a\nb"]],
		["oversize ID", ["a".repeat(257)]], ["oversize set", Array.from({ length: 101 }, (_, i) => String(i))],
	] as const) {
		it(`rejects ${name} selection before inspecting work`, async () => {
			const f = fixture();
			try {
				f.write("a");
				const result = await f.wait({ ids } as unknown as SubagentWaitParams);
				assert.equal(isError(result), true);
				assert.match(textOf(result), /ids/);
				assert.equal(f.polls(), 0);
				assert.deepEqual(f.probes, []);
			} finally { f.close(); }
		});
	}

	it("rejects id plus ids before inspecting work", async () => {
		const f = fixture();
		try {
			f.write("a");
			const result = await f.wait({ id: "a", ids: ["a"] });
			assert.equal(isError(result), true);
			assert.match(textOf(result), /id and ids/);
			assert.deepEqual(f.probes, []);
		} finally { f.close(); }
	});

	for (const scenario of ["unknown", "prefix", "foreign", "foreground", "mismatched-status"] as const) {
		it(`fails closed for a ${scenario} exact selection`, async () => {
			const f = fixture();
			try {
				if (scenario === "prefix") f.write("target-long", "running", { pid: 999999 });
				if (scenario === "foreign") f.write("target", "running", { sessionId: "foreign", pid: 999999 });
				if (scenario === "mismatched-status") f.write("target", "running", { runId: "imposter" });
				if (scenario === "foreground") f.state.foregroundRuns!.set("target", { runId: "target", sessionId: "owner", mode: "single", cwd: f.root, updatedAt: 1, children: [{ agent: "reviewer", index: 0, status: "detached" }] });
				const result = await f.wait({ ids: ["target"] });
				assert.equal(isError(result), true);
				assert.match(textOf(result), /selected async run.*target.*not found|selected async run.*target.*identity/is);
				assert.equal(f.polls(), 0);
				assert.ok(!f.probes.includes(999999));
			} finally { f.close(); }
		});
	}

	it("does not follow a selected directory symlink", async () => {
		const f = fixture();
		try {
			const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
			fs.mkdirSync(f.asyncDirRoot);
			fs.writeFileSync(path.join(outside, "status.json"), JSON.stringify({ runId: "target", sessionId: "owner", state: "running", pid: 999999, steps: [] }));
			fs.symlinkSync(outside, path.join(f.asyncDirRoot, "target"), process.platform === "win32" ? "junction" : "dir");
			const result = await f.wait({ ids: ["target"] });
			assert.equal(isError(result), true);
			assert.deepEqual(f.probes, []);
		} finally { f.close(); }
	});

	for (const scenario of ["disappeared", "session-changed", "ownership-changed"] as const) {
		it(`does not claim completion when tracked state ${scenario}`, async () => {
			const f = fixture();
			try {
				f.write("a");
				const result = await f.wait({ ids: ["a"], all: true }, () => {
					if (scenario === "disappeared") fs.rmSync(path.join(f.asyncDirRoot, "a"), { recursive: true });
					if (scenario === "session-changed") f.state.currentSessionId = "other";
					if (scenario === "ownership-changed") f.write("a", "running", { sessionId: "other", pid: 999999 });
				});
				assert.equal(isError(result), true);
				assert.doesNotMatch(textOf(result), /; done/);
				assert.match(textOf(result), /completion cannot be confirmed|active session changed/i);
				assert.equal(f.polls(), 1);
				assert.ok(!f.probes.includes(999999));
			} finally { f.close(); }
		});
	}

	for (const identity of ["session", "run"] as const) {
		for (const withResult of [false, true]) {
			it(`does not reconcile a changed ${identity} identity behind unchanged cached metadata${withResult ? " with persisted result" : ""}`, async (t) => {
				const f = fixture();
				f.write("a");
				const statusPath = path.join(f.asyncDirRoot, "a", "status.json");
				const originalStat = fsDefault.statSync;
				const metadata = originalStat(statusPath);
				const statMock = t.mock.method(fsDefault, "statSync", (...args: Parameters<typeof fs.statSync>) =>
					String(args[0]) === statusPath ? metadata : originalStat(...args));
				const resultPath = path.join(f.root, "results", `${identity === "session" ? "a" : "b"}.json`);
				const originalRead = fsDefault.readFileSync;
				let foreignResultReads = 0;
				const readMock = t.mock.method(fsDefault, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
					if (String(args[0]) === resultPath) foreignResultReads++;
					return originalRead(...args);
				});
				syncBuiltinESMExports();
				try {
					let changedStatus = "";
					const result = await f.wait({ ids: ["a"], all: true }, () => {
						f.write("a", "running", identity === "session"
							? { sessionId: "other", pid: 999999 }
							: { runId: "b", pid: 999999 });
						changedStatus = fs.readFileSync(statusPath, "utf8");
						if (withResult) {
							fs.mkdirSync(path.dirname(resultPath), { recursive: true });
							fs.writeFileSync(resultPath, JSON.stringify({ success: true, state: "complete", results: [] }));
						}
					});
					assert.equal(isError(result), true);
					assert.match(textOf(result), /completion cannot be confirmed/i);
					assert.equal(f.polls(), 1);
					assert.equal(foreignResultReads, 0, "foreign results are not read");
					assert.ok(!f.probes.includes(999999), "fresh identity is checked before probing a foreign PID");
					assert.equal(fs.readFileSync(statusPath, "utf8"), changedStatus, "foreign status is not repaired");
				} finally {
					statMock.mock.restore();
					readMock.mock.restore();
					syncBuiltinESMExports();
					f.close();
				}
			});
		}
	}

	it("caps waiting without stopping selected work", async () => {
		const f = fixture();
		try {
			f.write("a"); f.write("unrelated", "running", { pid: 999999 });
			const before = fs.readFileSync(path.join(f.asyncDirRoot, "a", "status.json"), "utf8");
			const result = await f.wait({ ids: ["a"], timeoutMs: 500 });
			assert.equal(isError(result), true);
			assert.match(textOf(result), /timed out.*a \(running\)/is);
			assert.doesNotMatch(textOf(result), /unrelated/);
			assert.equal(f.polls(), 2);
			assert.equal(fs.readFileSync(path.join(f.asyncDirRoot, "a", "status.json"), "utf8"), before);
		} finally { f.close(); }
	});

	it("aborts waiting without stopping selected work", async () => {
		const f = fixture();
		try {
			f.write("a"); const controller = new AbortController();
			const result = await f.wait({ ids: ["a"] }, () => controller.abort(), {}, controller.signal);
			assert.equal(isError(result), true);
			assert.match(textOf(result), /aborted.*a \(running\)/is);
			assert.equal(f.polls(), 1);
		} finally { f.close(); }
	});

	it("keeps failed-run and attention controls within the selected snapshot", async () => {
		const f = fixture();
		try {
			f.write("a", "running", { activityState: "needs_attention" });
			const result = await f.wait({ ids: ["a"], all: true }, () => f.write("a", "failed"), { stopOnAttention: false, failOnFailedRuns: true });
			assert.equal(isError(result), true);
			assert.equal(f.polls(), 1);
			assert.match(textOf(result), /1 failed/);
		} finally { f.close(); }
	});

	it("wakes on selected completion events and disposes listeners without provider discovery", { timeout: 5000 }, async () => {
		const f = fixture();
		const controller = new AbortController();
		const handlers = new Map<string, Set<(event: unknown) => void>>();
		const events = {
			on(channel: string, handler: (event: unknown) => void) {
				const listeners = handlers.get(channel) ?? new Set();
				listeners.add(handler); handlers.set(channel, listeners);
				return () => { listeners.delete(handler); };
			},
		};
		const emit = () => { for (const listener of handlers.get("subagent:async-complete") ?? []) listener({}); };
		const listenerCount = () => [...handlers.values()].reduce((sum, listeners) => sum + listeners.size, 0);
		try {
			f.write("a"); f.write("b"); f.write("unrelated");
			let settled = false;
			const pending = f.wait({ ids: ["a", "b"], all: true, timeoutMs: 4000 }, undefined, {
				events, now: Date.now, sleep: undefined, pollIntervalMs: 10_000,
			}, controller.signal).then((value) => { settled = true; return value; });
			assert.ok(listenerCount() > 0);
			f.write("unrelated", "complete"); emit();
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(settled, false);
			f.write("a", "complete"); emit();
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(settled, false);
			f.write("b", "complete"); emit();
			const result = await pending;
			assert.equal(isError(result), undefined);
			assert.match(textOf(result), /2 selected async run\(s\); done/);
			assert.equal(listenerCount(), 0);
		} finally { controller.abort(); f.close(); }
	});

	it("fails closed for corrupt state and session changes during reconciliation", async () => {
		for (const scenario of ["corrupt-json", "unknown-state", "read-session-change"] as const) {
			const f = fixture();
			try {
				f.write("a");
				const result = await f.wait({ ids: ["a"] }, () => {
					if (scenario === "corrupt-json") fs.writeFileSync(path.join(f.asyncDirRoot, "a", "status.json"), "{");
					if (scenario === "unknown-state") f.write("a", "not-a-lifecycle-state");
				}, scenario === "read-session-change" ? { kill: () => { f.state.currentSessionId = "other"; return true; } } : {});
				assert.equal(isError(result), true);
				assert.match(textOf(result), /completion cannot be confirmed|active session changed|Failed to parse async status/i);
				assert.doesNotMatch(textOf(result), /; done/);
			} finally { f.close(); }
		}
	});
});
