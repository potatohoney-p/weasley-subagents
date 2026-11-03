import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function fixture(t: TestContext, options: { code?: string; failures?: number; raw?: string } = {}) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-read-recovery-"));
	const file = path.join(directory, "run.json");
	fs.writeFileSync(file, options.raw ?? JSON.stringify({
		id: "run", runId: "run", sessionId: "owner", success: true,
		summary: "finished", nestedChildren: [],
	}));
	const state = {
		currentSessionId: "owner", completionSeen: new Map(), watcher: null,
		watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} },
	} as unknown as SubagentState;
	const emitted: string[] = [];
	const delivered: Array<{ triggerTurn?: boolean }> = [];
	const logged: unknown[][] = [];
	t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args); });
	let reads = 0;
	let remaining = options.failures ?? 1;
	const fakeWatcher = { on() { return this; }, close() {}, unref() {} } as unknown as fs.FSWatcher;
	const watcher = createResultWatcher({ events: {
		on: () => () => {}, emit: (event: string) => { emitted.push(event); },
	} }, state, directory, 60_000, {
		fs: {
			...fs,
			watch: (() => fakeWatcher) as typeof fs.watch,
			readFileSync: ((target: fs.PathOrFileDescriptor, encoding: BufferEncoding) => {
				if (target === file) {
					reads++;
					if (remaining-- > 0 && options.code) throw Object.assign(new Error("injected read failure"), { code: options.code });
				}
				return fs.readFileSync(target, encoding);
			}) as typeof fs.readFileSync,
		},
		notifier: { deliver: async (result) => { delivered.push(result); return true; } },
	});
	watcher.startResultWatcher();
	t.after(() => { watcher.stopResultWatcher(); fs.rmSync(directory, { recursive: true, force: true }); });
	return {
		watcher, state, file, emitted, delivered, logged,
		reads: () => reads,
		async tick(ms: number) { t.mock.timers.tick(ms); await Promise.resolve(); await Promise.resolve(); },
	};
}

describe("result watcher read recovery", () => {
	for (const code of ["EIO", "EACCES", "EMFILE"]) {
		it(`retries ${code} without another filesystem event and preserves silent priming`, async (t) => {
			const f = fixture(t, { code });
			f.watcher.primeExistingResults({ triggerTurn: false });
			await f.tick(1);
			assert.equal(f.reads(), 1);
			assert.equal(f.delivered.length, 0);
			assert.equal(fs.existsSync(f.file), true);
			assert.equal(f.state.completionSeen.size, 0);
			await f.tick(2999);
			assert.equal(f.reads(), 1, "read retries must not spin at the 100 ms delivery retry cadence");
			await f.tick(1);
			assert.equal(f.reads(), 2);
			assert.deepEqual(f.delivered.map((result) => result.triggerTurn), [false]);
			assert.deepEqual(f.emitted, ["subagent:async-complete"]);
			assert.equal(fs.existsSync(f.file), false);
			await f.tick(30_000);
			assert.equal(f.delivered.length, 1);
		});
	}

	it("retains an unreadable result across repeated failures until storage recovers", async (t) => {
		const f = fixture(t, { code: "EBUSY", failures: 3 });
		f.watcher.primeExistingResults();
		await f.tick(1);
		for (let i = 0; i < 2; i++) await f.tick(3000);
		assert.equal(f.reads(), 3);
		assert.equal(f.delivered.length, 0);
		assert.equal(fs.existsSync(f.file), true);
		await f.tick(3000);
		assert.equal(f.reads(), 4);
		assert.equal(f.delivered.length, 1);
		assert.equal(fs.existsSync(f.file), false);
	});

	for (const mode of ["stop", "session change"] as const) {
		it(`revokes pending read retries after ${mode}`, async (t) => {
			const f = fixture(t, { code: "EIO", failures: 5 });
			f.watcher.primeExistingResults();
			await f.tick(1);
			if (mode === "stop") f.watcher.stopResultWatcher();
			else f.state.currentSessionId = "other";
			await f.tick(3000);
			assert.equal(f.reads(), 1);
			assert.equal(f.delivered.length, 0);
			assert.equal(fs.existsSync(f.file), true);
		});
	}

	for (const code of ["ENOENT", "ENOTDIR", "EISDIR"]) {
		it(`does not retry a nonrecoverable ${code} read`, async (t) => {
			const f = fixture(t, { code, failures: 10 });
			f.watcher.primeExistingResults();
			await f.tick(1);
			await f.tick(30_000);
			assert.equal(f.reads(), 1);
			assert.equal(f.delivered.length, 0);
		});
	}

	it("retains malformed JSON without continuously retrying it", async (t) => {
		const f = fixture(t, { raw: "{bad-json" });
		f.watcher.primeExistingResults();
		await f.tick(1);
		await f.tick(30_000);
		assert.equal(f.reads(), 1);
		assert.equal(f.delivered.length, 0);
		assert.equal(f.logged.length, 1);
		assert.equal(fs.existsSync(f.file), true);
	});
});
