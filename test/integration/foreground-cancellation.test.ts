/** Synthetic Pi processes only; no model/provider requests are made. */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { createMockPi, createTempDir, removeTempDir, type MockPi } from "../support/helpers.ts";

const agent: AgentConfig = {
	name: "synthetic",
	description: "Cancellation fixture",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "builtin",
	filePath: "",
};

async function waitForChild(mockPi: MockPi): Promise<number> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		// The call record is published after the mock's SIGTERM handler is installed.
		const record = fs.readdirSync(mockPi.dir).find((name) => /^call-\d+-\d+-[a-f0-9]+\.json$/.test(name));
		if (record) return Number(record.split("-")[2]);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Synthetic child did not publish readiness");
}

function killFixture(pid: number | undefined): void {
	if (pid === undefined) return;
	try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
}

describe("foreground cancellation", () => {
	let tempDir: string;
	let mockPi: MockPi;

	beforeEach(() => {
		tempDir = createTempDir("foreground-cancellation-");
		mockPi = createMockPi();
		mockPi.install();
	});

	afterEach(() => {
		mockPi.uninstall();
		removeTempDir(tempDir);
	});

	it("escalates an originating abort when the child ignores SIGTERM", {
		skip: process.platform === "win32" ? "Windows does not support ignoring SIGTERM" : false,
	}, async () => {
		mockPi.onCall({ ignoreSigterm: true, delay: 30_000, output: "must not complete" });
		const controller = new AbortController();
		let fixtureRunning = true;
		const completion = runSync(tempDir, [agent], agent.name, "Wait", { runId: "abort-escalation", signal: controller.signal })
			.finally(() => { fixtureRunning = false; });
		let childPid: number | undefined;
		let deadlineTimer: NodeJS.Timeout | undefined;
		try {
			childPid = await waitForChild(mockPi);
			controller.abort();
			const result = await Promise.race([
				completion,
				new Promise<never>((_resolve, reject) => {
					deadlineTimer = setTimeout(() => reject(new Error("Aborted child survived the SIGKILL escalation deadline")), 6_000);
				}),
			]);
			assert.equal(result.processSignal, "SIGKILL");
			assert.notEqual(result.exitCode, 0);
			assert.equal(result.progress?.status, "failed");
			assert.equal(mockPi.callCount(), 1, "cancellation must not relaunch the child");
		} finally {
			if (deadlineTimer) clearTimeout(deadlineTimer);
			controller.abort();
			if (fixtureRunning) killFixture(childPid);
			await completion;
		}
	});

	it("clears escalation after prompt exit and ignores a stale timer callback", async (t) => {
		mockPi.onCall({ delay: 30_000, output: "must not complete" });
		const kill = t.mock.method(ChildProcess.prototype, "kill");
		const timers = t.mock.method(globalThis, "setTimeout");
		const clearedTimers = t.mock.method(globalThis, "clearTimeout");
		const controller = new AbortController();
		let fixtureRunning = true;
		const completion = runSync(tempDir, [agent], agent.name, "Wait", { runId: "abort-cleanup", signal: controller.signal })
			.finally(() => { fixtureRunning = false; });
		let childPid: number | undefined;
		try {
			childPid = await waitForChild(mockPi);
			controller.abort();
			const result = await completion;
			assert.notEqual(result.exitCode, 0);
			assert.deepEqual(kill.mock.calls.map((call) => call.arguments[0]), ["SIGTERM"]);
			const escalation = timers.mock.calls.find((call) => call.arguments[1] === 3_000);
			assert.ok(escalation, "abort should arm a bounded escalation");
			assert.ok(clearedTimers.mock.calls.some((call) => call.arguments[0] === escalation.result), "completed lifecycle must clear its escalation timer");
			// Even a callback already queued before cleanup must not signal a dead child.
			escalation.arguments[0]();
			assert.equal(kill.mock.callCount(), 1);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		} finally {
			controller.abort();
			if (fixtureRunning) killFixture(childPid);
			await completion;
		}
	});

	it("does not arm escalation after a synchronous signal error finishes the lifecycle", async (t) => {
		// An owned in-memory child models Node's synchronous kill-error path.
		// No OS process is spawned or signaled in this interleaving.
		const signals: Array<NodeJS.Signals | number | undefined> = [];
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill(signal?: NodeJS.Signals | number) {
				signals.push(signal);
				child.emit("error", new Error("synthetic synchronous kill failure"));
				return false;
			},
		});
		t.mock.method(childProcess, "spawn", () => child as unknown as ChildProcess);
		const timers = t.mock.method(globalThis, "setTimeout");
		syncBuiltinESMExports();
		try {
			const controller = new AbortController();
			const completion = runSync(tempDir, [agent], agent.name, "Wait", {
				runId: "abort-synchronous-error",
				signal: controller.signal,
				acceptance: false,
			});
			controller.abort();
			const result = await completion;
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(signals, ["SIGTERM"]);
			assert.equal(result.error, "synthetic synchronous kill failure");
			assert.equal(timers.mock.calls.filter((call) => call.arguments[1] === 3_000).length, 0);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		} finally {
			child.stdout.destroy();
			child.stderr.destroy();
			t.mock.restoreAll();
			syncBuiltinESMExports();
		}
	});

	it("removes the originating abort listener after completion", async (t) => {
		mockPi.onCall({ output: "completed normally" });
		const kill = t.mock.method(ChildProcess.prototype, "kill");
		const controller = new AbortController();
		const completion = runSync(tempDir, [agent], agent.name, "Complete", { runId: "abort-after-completion", signal: controller.signal });
		assert.equal(getEventListeners(controller.signal, "abort").length, 1);
		const result = await completion;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(result.exitCode, 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		controller.abort();
		assert.equal(kill.mock.callCount(), 0, "abort after completion must not signal any child");
	});
});
