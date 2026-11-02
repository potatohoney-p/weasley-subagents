import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { type ProcessTerminalCandidate, finalizeProcessTerminal, sanitizeProcessTerminal, writeProcessTerminalCandidate } from "../../src/runs/background/process-terminal.ts";

const writer = { processInstanceId: "writer-1", kind: "pi-writer" as const, attempt: 0, closeObservedAt: 10, exitCode: 0, signal: null };
const runner = { processInstanceId: "runner-1", closeObservedAt: 20, exitCode: 0, signal: null };
for (const [name, writers, expectedWriters] of [
	["duplicate writer within a child", { "0": [writer, { ...writer, attempt: 1 }] }, { "0": 2 }],
	["duplicate writer across children", { "0": [writer], "1": [writer] }, { "0": 1, "1": 1 }],
	["writer using the runner identity", { "0": [{ ...writer, processInstanceId: runner.processInstanceId }] }, { "0": 1 }],
] as Array<[string, ProcessTerminalCandidate["writers"], Record<string, number>]>) {
	test(`terminal candidate rejects ${name}`, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-identities-"));
		try {
			writeProcessTerminalCandidate(dir, { version: 1, runId: "run-1", runnerProcessInstanceId: runner.processInstanceId, writers, expectedWriters });
			assert.equal(finalizeProcessTerminal(dir, "run-1", runner).state, "unknown");
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
}
for (const [name, instances] of [
	["duplicate writer", [{ kind: "runner", ...runner }, writer, { ...writer, attempt: 1 }]],
	["multiple runners", [{ kind: "runner", ...runner }, { kind: "runner", ...runner, processInstanceId: "runner-2" }, writer]],
	["runner/writer identity collision", [{ kind: "runner", ...runner }, { ...writer, processInstanceId: runner.processInstanceId }]],
] as const) {
	test(`persisted terminal proof rejects ${name}`, () => {
		const proof = { version: 1, state: "observed", runId: "run-1", runnerProcessInstanceId: runner.processInstanceId, observedAt: 20, instances };
		assert.equal(sanitizeProcessTerminal(proof, { runId: "run-1", runnerProcessInstanceId: runner.processInstanceId })?.state, "unknown");
	});
}

test("distinct writer instances retain observed evidence across retries and children", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-identities-"));
	try {
		writeProcessTerminalCandidate(dir, { version: 1, runId: "run-1", runnerProcessInstanceId: runner.processInstanceId,
			writers: { "0": [writer, { ...writer, processInstanceId: "writer-2", attempt: 1 }], "1": [{ ...writer, processInstanceId: "writer-3" }] }, expectedWriters: { "0": 2, "1": 1 } });
		const proof = finalizeProcessTerminal(dir, "run-1", runner);
		assert.equal(proof.state, "observed");
		assert.equal(sanitizeProcessTerminal(proof, { runId: "run-1" })?.state, "observed");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runner-only proof remains valid when no writers were started", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-identities-"));
	try {
		writeProcessTerminalCandidate(dir, { version: 1, runId: "run-1", runnerProcessInstanceId: runner.processInstanceId, writers: { "0": [] }, expectedWriters: { "0": 0 } });
		assert.equal(finalizeProcessTerminal(dir, "run-1", runner).state, "observed");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
