/** Real execution entry point and synthetic Pi CLI only; no provider requests. */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_ARTIFACT_CONFIG } from "../../src/shared/types.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { mapConcurrent } from "../../src/runs/shared/parallel-utils.ts";
import { createMockPi, createTempDir, removeTempDir, type MockPi } from "../support/helpers.ts";

const agent: AgentConfig = {
	name: "synthetic", description: "Admission fixture", systemPrompt: "",
	systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false,
	source: "builtin", filePath: "",
};
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

describe("foreground launch admission", () => {
	let tempDir: string;
	let mockPi: MockPi;
	beforeEach(() => {
		tempDir = createTempDir("foreground-admission-");
		mockPi = createMockPi();
		mockPi.install();
	});
	afterEach(() => {
		mockPi.uninstall();
		removeTempDir(tempDir);
	});

	it("does not spawn or publish detach callbacks for a pre-aborted run", async (t) => {
		const spawn = t.mock.method(childProcess, "spawn");
		syncBuiltinESMExports();
		try {
			const controller = new AbortController();
			controller.abort(new Error("private reason must not become output"));
			let callbacks = 0;
			const result = await runSync(tempDir, [agent], agent.name, "Task", {
				runId: "admission-cancel", signal: controller.signal, acceptance: false, artifactConfig: { ...DEFAULT_ARTIFACT_CONFIG, enabled: false },
				onDetachReady: () => { callbacks++; }, onDetachedExit: () => { callbacks++; },
			});
			assert.equal(spawn.mock.callCount(), 0);
			assert.equal(callbacks, 0);
			assert.equal(result.exitCode, 1);
			assert.equal(result.error, "Subagent run cancelled before launch.");
			assert.equal(result.finalOutput, result.error);
			assert.equal(result.processSignal, undefined);
			assert.equal(result.modelAttempts, undefined);
			assert.equal(result.attemptedModels, undefined);
			assert.deepEqual(result.usage, zeroUsage);
			assert.deepEqual(result.messages, []);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	});

	it("preserves existing structured and textual output without creating artifacts", async () => {
		const capture = path.join(tempDir, "capture.json");
		const output = path.join(tempDir, "answer.md");
		const artifactsDir = path.join(tempDir, "artifacts");
		const originalCapture = '{"existing":"한 🪄"}\n';
		fs.writeFileSync(capture, originalCapture);
		fs.writeFileSync(output, "Existing answer\n");
		const controller = new AbortController(); controller.abort();
		const result = await runSync(tempDir, [agent], agent.name, "Task", {
			signal: controller.signal, runId: "admission-artifacts", artifactsDir,
			outputPath: output, acceptance: false,
			structuredOutput: { schema: { type: "object" }, schemaPath: path.join(tempDir, "schema.json"), outputPath: capture },
		});
		assert.equal(fs.existsSync(capture), true);
		assert.equal(fs.readFileSync(capture, "utf8"), originalCapture);
		assert.equal(fs.readFileSync(output, "utf8"), "Existing answer\n");
		assert.equal(fs.existsSync(artifactsDir), false);
		assert.equal(result.structuredOutput, undefined);
		assert.equal(result.artifactPaths, undefined);
	});

	it("keeps strict-contract execution unsuccessful and preserves resolved context", async () => {
		const controller = new AbortController(); controller.abort();
		const result = await runSync(tempDir, [agent], agent.name, "Task", {
			runId: "admission-contract", signal: controller.signal, context: "fork", agentContract: { version: 1 }, acceptance: false,
		});
		assert.equal(result.context, "fork");
		assert.equal(result.execution?.status, "failed");
		assert.equal(result.execution?.success, false);
		assert.deepEqual(result.agentContract, { version: 1 });
		assert.equal(result.error, "Subagent run cancelled before launch.");
		assert.deepEqual(result.progressSummary, { toolCount: 0, tokens: 0, durationMs: 0 });
		assert.equal(result.interrupted, undefined, "cancellation must not masquerade as a paused successful run");
	});

	it("admits normal work but does not launch queued work after its shared signal aborts", async (t) => {
		mockPi.onCall({ output: "First task completed" });
		const spawn = t.mock.method(childProcess, "spawn");
		syncBuiltinESMExports();
		try {
			const controller = new AbortController();
			const results = await mapConcurrent(["first", "queued"], 1, async (task) => {
				const result = await runSync(tempDir, [agent], agent.name, task, {
					runId: "admission-cancel", signal: controller.signal, acceptance: false, artifactConfig: { ...DEFAULT_ARTIFACT_CONFIG, enabled: false },
				});
				if (task === "first") controller.abort();
				return result;
			});
			assert.equal(results[0]!.exitCode, 0);
			assert.match(results[0]!.finalOutput ?? "", /First task completed/);
			assert.equal(results[1]!.error, "Subagent run cancelled before launch.");
			assert.equal(spawn.mock.callCount(), 1);
			assert.equal(mockPi.callCount(), 1);
			assert.deepEqual(results[1]!.usage, zeroUsage);
		} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	});
});
