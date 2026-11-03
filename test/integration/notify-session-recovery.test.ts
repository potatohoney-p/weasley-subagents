import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { it } from "node:test";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import type { SubagentState } from "../../src/shared/types.ts";

it("keeps a queued result for its owner after a session switch, then recovers it silently", async (t) => {
	const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-session-recovery-"));
	const resultPath = path.join(resultsDir, "delayed.json");
	const state: SubagentState = {
		baseCwd: resultsDir,
		currentSessionId: "session-a",
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear() {} },
	};
	const emitter = new EventEmitter();
	const sent: Array<{ sessionId: string | null; options: unknown }> = [];
	const pi = {
		events: {
			on(name: string, listener: (data: unknown) => void) {
				emitter.on(name, listener);
				return () => emitter.off(name, listener);
			},
			emit(name: string, data: unknown) { emitter.emit(name, data); },
		},
		sendMessage(_message: unknown, options: unknown) {
			sent.push({ sessionId: state.currentSessionId, options });
		},
	};
	let nextTimer = 1;
	const timers = new Map<number, () => void>();
	const notifier = registerSubagentNotify(pi as never, state, {
		timers: {
			setTimeout(handler) { const id = nextTimer++; timers.set(id, handler); return id; },
			clearTimeout(handle) { timers.delete(handle as number); },
		},
	});
	const flushBatch = () => {
		const handler = timers.values().next().value;
		assert.ok(handler, "the result has reached the completion batcher");
		handler();
	};
	const waitFor = async (predicate: () => boolean, message: string) => {
		const deadline = Date.now() + 5_000;
		while (!predicate() && Date.now() < deadline) await nextTurn();
		assert.ok(predicate(), message);
	};
	let watcher = createResultWatcher(pi, state, resultsDir, 60_000, { notifier, deliverIntercomResults: false });
	t.after(() => {
		watcher.stopResultWatcher();
		notifier.dispose();
		fs.rmSync(resultsDir, { recursive: true, force: true });
	});
	fs.writeFileSync(resultPath, JSON.stringify({
		id: "delayed", sessionId: "session-a", agent: "worker", success: true, summary: "done", nestedChildren: [],
	}));
	watcher.primeExistingResults({ triggerTurn: false });
	await waitFor(() => timers.size > 0, "first delivery was queued");

	watcher.stopResultWatcher();
	state.currentSessionId = "session-b";
	flushBatch();
	await nextTurn();
	assert.deepEqual(sent, [], "old-session output must not enter the new session");
	assert.equal(fs.existsSync(resultPath), true);
	assert.equal(state.completionSeen.size, 0);
	assert.equal(timers.size, 0);

	state.currentSessionId = "session-a";
	watcher = createResultWatcher(pi, state, resultsDir, 60_000, { notifier, deliverIntercomResults: false });
	watcher.primeExistingResults({ triggerTurn: false });
	await waitFor(() => timers.size > 0, "returning to the owner retries rather than deduplicating the rejected batch");
	flushBatch();
	await waitFor(() => !fs.existsSync(resultPath), "accepted result was removed");
	assert.deepEqual(sent, [{ sessionId: "session-a", options: { triggerTurn: false } }]);
	assert.equal(state.completionSeen.size, 1);
	watcher.primeExistingResults();
	await nextTurn();
	assert.equal(sent.length, 1);
	assert.equal(timers.size, 0);
});
