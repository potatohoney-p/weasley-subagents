import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { checkPidLiveness, reconcileAsyncRun, reconcileNestedAsyncDescendants } from "../../src/runs/background/stale-run-reconciler.ts";
import { createNestedRoute, projectNestedEvents, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { TEMP_ROOT_DIR } from "../../src/shared/types.ts";

function tempRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeStatus(asyncDir: string, status: Record<string, unknown>): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("async stale-run reconciliation", () => {
	it("updates a nested child after its checkpoint is rejected while the parent is offline", () => {
		const rootRunId = `rejected-${randomUUID()}`;
		const route = createNestedRoute(rootRunId);
		const asyncRoot = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId);
		const asyncDir = path.join(asyncRoot, "child");
		const resultsDir = tempRoot("pi-nested-rejected-");
		try {
			writeNestedEvent(route, {
				type: "subagent.nested.started", ts: 1000, parentRunId: rootRunId,
				child: { id: "child", parentRunId: rootRunId, depth: 1, mode: "single", state: "running", startedAt: 1000, lastUpdate: 1000, asyncDir },
			});
			writeStatus(asyncDir, {
				runId: "child", mode: "single", state: "rejected", startedAt: 1000, lastUpdate: 2000,
				steps: [{ agent: "worker", status: "rejected" }],
			});
			reconcileNestedAsyncDescendants(route, { resultsDir, now: () => 3000 });
			const rejected = projectNestedEvents(route).children[0];
			assert.equal(rejected?.state, "rejected");
			assert.equal(rejected?.steps?.[0]?.status, "rejected");
			writeNestedEvent(route, {
				type: "subagent.nested.updated", ts: 4000, parentRunId: rootRunId,
				child: { id: "child", parentRunId: rootRunId, depth: 1, mode: "single", state: "running", lastUpdate: 4000 },
			});
			assert.equal(projectNestedEvents(route).children[0]?.state, "rejected");
		} finally {
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
			fs.rmSync(asyncRoot, { recursive: true, force: true });
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	for (const outcome of [
		{ state: "stopped", child: { success: false, stopped: true }, childState: "stopped", exitCode: 1 },
		{ state: "paused", child: { success: false, interrupted: true }, childState: "paused", exitCode: 0 },
		{ state: "failed", child: { success: false, timedOut: true }, childState: "failed", exitCode: 1 },
		{ state: "rejected", child: undefined, childState: "rejected", exitCode: 1 },
	] as const) {
		it(`preserves ${outcome.state} lifecycle details when restoring stale status`, () => {
			const root = tempRoot("pi-stale-lifecycle-");
			try {
				const asyncDir = path.join(root, "run");
				const resultsDir = path.join(root, "results");
				fs.mkdirSync(resultsDir);
				writeStatus(asyncDir, {
					runId: "run", mode: "chain", state: "running", pid: 12345,
					startedAt: 1000, lastUpdate: 1000,
					steps: [
						{ agent: "scout", status: "completed", exitCode: 0 },
						{ agent: "worker", status: "running", startedAt: 1100, activityState: "needs_attention" },
					],
				});
				fs.writeFileSync(path.join(resultsDir, "run.json"), JSON.stringify({
					id: "run", success: false, state: outcome.state,
					results: [{ agent: "scout", success: true }, ...(outcome.child ? [{ agent: "worker", ...outcome.child, error: "Stopped at checkpoint" }] : [])],
				}));

				const result = reconcileAsyncRun(asyncDir, { resultsDir, now: () => 2000 });
				assert.equal(result.status?.state, outcome.state);
				assert.equal(result.status?.steps?.[0]?.status, "completed");
				const child = result.status?.steps?.[1];
				assert.equal(child?.status, outcome.childState);
				assert.equal(child?.exitCode, outcome.exitCode);
				assert.equal(child?.activityState, undefined);
				if (outcome.state === "stopped") assert.equal(child?.stopped, true);
				if (outcome.state === "failed") assert.equal(child?.timedOut, true);
				assert.equal(reconcileAsyncRun(asyncDir, { resultsDir }).repaired, false);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}

	it("preserves a real result published while checking a stale runner", () => {
		const root = tempRoot("pi-stale-late-result-");
		try {
			const asyncDir = path.join(root, "run");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir);
			writeStatus(asyncDir, {
				runId: "run", mode: "single", state: "running", pid: 12345,
				startedAt: 1000, lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running" }],
			});
			const resultPath = path.join(resultsDir, "run.json");
			const completed = JSON.stringify({ id: "run", success: true, state: "complete", summary: "durable answer" });
			const result = reconcileAsyncRun(asyncDir, {
				resultsDir, now: () => 2000,
				kill: () => {
					fs.writeFileSync(resultPath, completed);
					throw errno("ESRCH");
				},
			});
			assert.equal(fs.readFileSync(resultPath, "utf-8"), completed);
			assert.equal(result.status?.state, "complete");
			assert.equal(result.status?.steps?.[0]?.status, "complete");
			assert.equal(fs.existsSync(path.join(asyncDir, "events.jsonl")), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("classifies pid liveness without treating EPERM as dead", () => {
		assert.equal(checkPidLiveness(123, () => true), "alive");
		assert.equal(checkPidLiveness(123, () => { throw errno("ESRCH"); }), "dead");
		assert.equal(checkPidLiveness(123, () => { throw errno("EPERM"); }), "unknown");
		assert.equal(checkPidLiveness(123, () => { throw new Error("boom"); }), "unknown");
	});

	it("marks a running async run failed when the runner pid is dead and no result exists", () => {
		const root = tempRoot("pi-stale-run-");
		try {
			const asyncDir = path.join(root, "run-dead");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-dead",
				sessionId: "session-current",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				currentStep: 0,
				steps: [{ agent: "scout", status: "running", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? "", /process 12345 exited or disappeared/);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(status.state, "failed");
			assert.equal(status.sessionId, "session-current");
			assert.equal(status.steps[0].status, "failed");
			assert.match(status.steps[0].error, /process 12345 exited or disappeared/);
			const resultJson = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-dead.json"), "utf-8"));
			assert.equal(resultJson.success, false);
			assert.equal(resultJson.sessionId, "session-current");
			assert.equal(resultJson.state, "failed");
			assert.equal(resultJson.exitCode, 1);
			assert.match(resultJson.summary, /process 12345 exited or disappeared/);
			assert.match(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"), /subagent\.run\.repaired_stale/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("includes runner stderr diagnostics when repairing a stale startup crash", () => {
		const root = tempRoot("pi-stale-run-stderr-");
		try {
			const asyncDir = path.join(root, "run-dead-stderr");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-dead-stderr",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				currentStep: 0,
				steps: [{ agent: "scout", status: "running", startedAt: 1000 }],
			});
			fs.writeFileSync(path.join(asyncDir, "runner.stderr.log"), "startup failed\nmissing peer package\n", "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.match(result.message ?? "", /Runner stderr tail:/);
			assert.match(result.message ?? "", /missing peer package/);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.match(status.steps[0].error, /missing peer package/);
			const resultJson = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-dead-stderr.json"), "utf-8"));
			assert.match(resultJson.summary, /missing peer package/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps stale repair successful when the event log cannot be appended", () => {
		const root = tempRoot("pi-stale-event-log-collision-");
		try {
			const asyncDir = path.join(root, "run-dead-events-dir");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-dead-events-dir",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				currentStep: 0,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});
			fs.mkdirSync(path.join(asyncDir, "events.jsonl"));

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state, "failed");
			assert.equal(JSON.parse(fs.readFileSync(path.join(resultsDir, "run-dead-events-dir.json"), "utf-8")).success, false);
			assert.equal(fs.statSync(path.join(asyncDir, "events.jsonl")).isDirectory(), true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs stale status with per-child result outcomes", () => {
		const root = tempRoot("pi-stale-mixed-result-");
		try {
			const asyncDir = path.join(root, "run-mixed");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			writeStatus(asyncDir, {
				runId: "run-mixed",
				mode: "chain",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [
					{ agent: "scout", status: "running", startedAt: 1000, model: "planned-scout", attemptedModels: ["planned-scout"] },
					{ agent: "worker", status: "running", startedAt: 1100, model: "planned-worker", attemptedModels: ["planned-worker"] },
				],
			});
			const scoutSession = path.join(root, "scout.jsonl");
			const workerSession = path.join(root, "worker.jsonl");
			fs.writeFileSync(path.join(resultsDir, "run-mixed.json"), JSON.stringify({
				id: "run-mixed",
				success: false,
				state: "failed",
				results: [
					{ agent: "scout", success: true, sessionFile: scoutSession, model: "fast", attemptedModels: ["planned-scout", "fast"] },
					{ agent: "worker", success: false, error: "boom", sessionFile: workerSession, model: "careful", attemptedModels: ["planned-worker", "careful"] },
				],
			}, null, 2), "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.equal(result.status?.steps?.[0]?.status, "complete");
			assert.equal(result.status?.steps?.[0]?.exitCode, 0);
			assert.equal(result.status?.steps?.[0]?.model, "fast");
			assert.deepEqual(result.status?.steps?.[0]?.attemptedModels, ["planned-scout", "fast"]);
			assert.equal(result.status?.steps?.[0]?.sessionFile, scoutSession);
			assert.equal(result.status?.steps?.[1]?.status, "failed");
			assert.equal(result.status?.steps?.[1]?.exitCode, 1);
			assert.equal(result.status?.steps?.[1]?.error, "boom");
			assert.equal(result.status?.steps?.[1]?.model, "careful");
			assert.deepEqual(result.status?.steps?.[1]?.attemptedModels, ["planned-worker", "careful"]);
			assert.equal(result.status?.steps?.[1]?.sessionFile, workerSession);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails a stale run when a live pid has not updated beyond the stale threshold", () => {
		const root = tempRoot("pi-stale-live-pid-");
		try {
			const asyncDir = path.join(root, "run-reused-pid");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-reused-pid",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => true,
				now: () => 5000,
				staleAlivePidMs: 1000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? "", /live PID, but status has not updated/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves an existing result instead of overwriting it with stale-run failure", () => {
		const root = tempRoot("pi-stale-existing-result-");
		try {
			const asyncDir = path.join(root, "run-result");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			writeStatus(asyncDir, {
				runId: "run-result",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});
			const resultPath = path.join(resultsDir, "run-result.json");
			fs.writeFileSync(resultPath, JSON.stringify({ id: "run-result", success: true, state: "complete", summary: "already done" }, null, 2), "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "complete");
			assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).summary, "already done");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
