import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { finalizeProcessTerminal, sanitizeProcessTerminal, writeProcessTerminalCandidate } from "../../src/runs/background/process-terminal.ts";
import { summarizeAsyncStatus } from "../../src/runs/background/async-status.ts";
import { nestedSummaryFromAsyncStatus } from "../../src/runs/shared/nested-events.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";

for (const state of ["complete", "failed", "stopped"] as const) {
	test(`child terminal evidence survives ${state} status and nested projection`, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "child-terminal-"));
		try {
			const writer = (id: string, attempt: number) => ({ processInstanceId: id, kind: "pi-writer" as const, attempt, closeObservedAt: 10 + attempt, exitCode: state === "complete" ? 0 : 1, signal: null });
			writeProcessTerminalCandidate(dir, { version: 1, runId: "run", runnerProcessInstanceId: "runner", expectedWriters: { "0": 2, "1": 1, "2": 0 }, writers: { "0": [writer("retry-0", 0), writer("retry-1", 1)], "1": [writer("sibling", 0)], "2": [] } });
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId: "run", state, mode: "parallel", steps: [{ agent: "a", status: state }, { agent: "b", status: state }, { agent: "c", status: "skipped" }] }));
			const root = finalizeProcessTerminal(dir, "run", { processInstanceId: "runner", closeObservedAt: 20, exitCode: 0, signal: null });
			assert.equal(root.state, "observed");
			const status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")) as AsyncStatus;
			const projections = [summarizeAsyncStatus(dir, status), nestedSummaryFromAsyncStatus(status, dir, { id: "run", parentRunId: "parent", depth: 1, ts: 20 })];
			for (const projection of projections) {
				const first = projection.steps![0].processTerminal!;
				assert.equal(first.state, "observed", first.diagnostic);
				assert.equal(first.childIndex, 0);
				assert.deepEqual(first.instances?.map((record) => record.processInstanceId), ["runner", "retry-0", "retry-1"]);
				assert.equal(first.resumeDisposition, state === "stopped" ? "non-resumable" : "unavailable");
				assert.deepEqual(projection.steps![1].processTerminal?.instances?.map((record) => record.processInstanceId), ["runner", "sibling"]);
				assert.equal(projection.steps![2].processTerminal?.state, "not-started");
			}
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
}

test("child terminal validation still rejects missing or mismatched runner evidence", () => {
	const base = { version: 1, state: "observed", runId: "run", runnerProcessInstanceId: "runner", childIndex: 0, observedAt: 20 };
	for (const instances of [[], [{ processInstanceId: "wrong-runner", kind: "runner", closeObservedAt: 20, exitCode: 0, signal: null }]]) {
		assert.equal(sanitizeProcessTerminal({ ...base, instances }, { runId: "run", runnerProcessInstanceId: "runner" })?.state, "unknown");
	}
});

test("incomplete child close evidence is never promoted by status projection", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "child-terminal-missing-"));
	try {
		writeProcessTerminalCandidate(dir, { version: 1, runId: "run", runnerProcessInstanceId: "runner", expectedWriters: { "0": 1 }, writers: { "0": [] } });
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId: "run", state: "failed", mode: "single", steps: [{ agent: "worker", status: "failed" }] }));
		finalizeProcessTerminal(dir, "run", { processInstanceId: "runner", closeObservedAt: 20, exitCode: 1, signal: null });
		const status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")) as AsyncStatus;
		const projected = summarizeAsyncStatus(dir, status).steps![0].processTerminal!;
		assert.equal(projected.state, "unknown");
		assert.equal(projected.reason, "writer-close-unverified");
		assert.equal(projected.instances, undefined);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
