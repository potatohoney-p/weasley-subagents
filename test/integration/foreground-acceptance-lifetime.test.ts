/** Real foreground execution and verification processes; no provider requests. */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { executeChain } from "../../src/runs/foreground/chain-execution.ts";
import { DEFAULT_CONTROL_CONFIG } from "../../src/runs/shared/subagent-control.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import type { AcceptanceLedger, RunSyncOptions, SingleResult } from "../../src/shared/types.ts";
import { createMockPi, createTempDir, events, makeMinimalCtx, removeTempDir, type MockPi } from "../support/helpers.ts";

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return { name, description: "Lifetime fixture", systemPrompt: "", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false, source: "builtin", filePath: "", ...overrides };
}

const report = `Done.\n\`\`\`acceptance-report\n${JSON.stringify({
	criteriaSatisfied: [], changedFiles: [], testsAddedOrUpdated: [], commandsRun: [],
	validationOutput: [], residualRisks: [], noStagedFiles: true,
})}\n\`\`\``;
const artifactConfig = { enabled: true, includeInput: false, includeOutput: true, includeJsonl: false, includeMetadata: true, cleanupDays: 7 };

async function waitUntil(predicate: () => boolean, message: string, timeout = 15_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, message);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("foreground acceptance lifetime", () => {
	let dir: string;
	let mockPi: MockPi;
	let controller: AbortController;
	let pending: Promise<unknown> | undefined;
	let verifier: string;
	let sentinel: string;
	let ready: string;
	let release: string;
	let next: string;

	beforeEach(() => {
		dir = createTempDir("foreground-acceptance-");
		controller = new AbortController();
		mockPi = createMockPi();
		mockPi.install();
		ready = path.join(dir, "ready.json");
		release = path.join(dir, "release");
		next = path.join(dir, "next-command");
		verifier = path.join(dir, "verify.cjs");
		sentinel = path.join(dir, "next.cjs");
		fs.writeFileSync(verifier, `const fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid }));\nconst poll = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(poll); process.exit(0); } }, 20);\nsetTimeout(() => process.exit(88), 30000).unref();\n`);
		fs.writeFileSync(sentinel, `require('node:fs').writeFileSync(${JSON.stringify(next)}, 'ran');`);
	});

	afterEach(async () => {
		// Release a baseline verifier before awaiting it. Do not remove its files
		// while it is running, including when an assertion failed.
		controller.abort();
		fs.writeFileSync(release, "release");
		await pending?.catch(() => {});
		if (fs.existsSync(ready)) {
			const { pid } = JSON.parse(fs.readFileSync(ready, "utf8")) as { pid: number };
			await waitUntil(() => !isAlive(pid), "owned verification process must exit before cleanup");
		}
		pending = undefined;
		mockPi.uninstall();
		removeTempDir(dir);
	});

	function acceptance() {
		return { level: "verified" as const, verify: [
			{ id: "blocking", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(verifier)}`, timeoutMs: 25_000 },
			{ id: "must-not-run", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(sentinel)}` },
		] };
	}

	function single(overrides: Partial<RunSyncOptions> = {}) {
		mockPi.onCall({ output: report });
		const completion = runSync(dir, [agent("reviewer", { completionGuard: false })], "reviewer", "Review the result", {
			runId: "acceptance-lifetime", artifactsDir: path.join(dir, "artifacts"), artifactConfig,
			acceptance: acceptance(), signal: controller.signal, ...overrides,
		});
		pending = completion;
		return completion;
	}

	function group(empty: boolean, deadlineAt?: number) {
		const producer = { output: "items", structuredOutput: { items: empty ? [] : ["one"] } };
		mockPi.onCall(producer);
		if (!empty) mockPi.onCall({ output: "reviewed" });
		mockPi.onCall({ output: "should not run" });
		const completion = executeChain({
			chain: [
				{ agent: "scout", task: "Return items", as: "items", outputSchema: { type: "object" }, acceptance: false },
				{
					expand: { from: { output: "items", path: "/items" }, maxItems: 1 },
					parallel: { agent: "reviewer", task: "Review {item}", acceptance: false },
					collect: { as: "reviews" }, acceptance: acceptance(), agentContract: { version: 1 }, gateOn: "execution",
				},
				{ agent: "writer", task: "Read {outputs.reviews}", acceptance: false },
			],
			agents: [agent("scout"), agent("reviewer"), agent("writer")],
			ctx: makeMinimalCtx(dir) as unknown as Parameters<typeof executeChain>[0]["ctx"],
			runId: "group-lifetime", artifactsDir: path.join(dir, "artifacts"), artifactConfig,
			shareEnabled: false, sessionDirForIndex: () => undefined, clarify: false,
			controlConfig: DEFAULT_CONTROL_CONFIG, maxSubagentDepth: 1,
			signal: controller.signal, ...(deadlineAt ? { deadlineAt, timeoutMs: 5_000 } : {}),
		});
		pending = completion;
		return completion;
	}

	async function assertInterrupted(ledger: AcceptanceLedger | undefined) {
		assert.equal(ledger?.status, "rejected");
		assert.equal(ledger?.verifyRuns.length, 1, "cancellation must stop later verification commands");
		assert.equal(ledger?.verifyRuns[0]?.status, "timed-out");
		assert.ok(ledger?.verifyRuns[0]?.termination, "retain bounded process cleanup evidence");
		assert.equal(fs.existsSync(next), false);
		const { pid } = JSON.parse(fs.readFileSync(ready, "utf8")) as { pid: number };
		await waitUntil(() => !isAlive(pid), "verification must terminate");
	}

	for (const strict of [false, true]) {
		it(`cancels single verification and persists failure (${strict ? "contract v1" : "legacy"})`, async () => {
			let completed = false;
			const completion = single(strict ? { agentContract: { version: 1 } } : {}).finally(() => { completed = true; });
			await waitUntil(() => fs.existsSync(ready), "verification must start");
			controller.abort();
			await waitUntil(() => completed, "cancellation must finish before the command's own timeout", 8_000);
			const result = await completion;
			assert.equal(result.exitCode, 1);
			assert.match(result.error ?? "", /cancelled during acceptance/);
			assert.equal(result.timedOut, undefined);
			assert.equal(result.progress?.status, "failed");
			await assertInterrupted(result.acceptance);
			const metadata = JSON.parse(fs.readFileSync(result.artifactPaths!.metadataPath, "utf8"));
			assert.equal(metadata.exitCode, 1);
			assert.equal(metadata.acceptance.verifyRuns.length, 1);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		});
	}

	it("uses the remaining single-run deadline during verification", async () => {
		const completion = single({ agentContract: { version: 1 }, timeoutMs: 5_000, deadlineAt: Date.now() + 5_000 });
		await waitUntil(() => fs.existsSync(ready), "verification must start before its deadline");
		const result = await completion;
		assert.equal(result.exitCode, 1);
		assert.equal(result.timedOut, true);
		assert.match(result.error ?? "", /timed out after 5000ms/);
		await assertInterrupted(result.acceptance);
	});

	for (const empty of [false, true]) {
		for (const timeout of [false, true]) {
			it(`${timeout ? "times out" : "cancels"} ${empty ? "empty" : "populated"} dynamic-group verification without advancing the chain`, async () => {
				let completed = false;
				const completion = group(empty, timeout ? Date.now() + 5_000 : undefined).finally(() => { completed = true; });
				await waitUntil(() => fs.existsSync(ready), "group verification must start");
				if (!timeout) controller.abort();
				await waitUntil(() => completed, "group interruption must finish before its command timeout", 10_000);
				const result = await completion;
				assert.equal(result.isError, true);
				assert.match(result.content[0]!.text as string, timeout ? /timed out/ : /cancelled/);
				const node = result.details.workflowGraph!.nodes[1]!;
				assert.equal(node.status, "failed");
				assert.equal(node.acceptanceStatus, "rejected");
				assert.equal(fs.existsSync(next), false);
				assert.equal(mockPi.callCount(), empty ? 1 : 2, "following child must not launch, even with gateOn execution");
			});
		}
	}

	it("skips verification when cancellation arrives in the child's final update", async () => {
		const result = await single({ agentContract: { version: 1 }, onUpdate: (update) => {
			if (update.details?.results?.[0]?.progress?.status === "completed") controller.abort();
		} });
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /cancelled/);
		assert.equal(result.acceptance?.verifyRuns.length, 0);
		assert.equal(fs.existsSync(ready), false, "do not spawn the first verification after cancellation");
	});

	it("preserves per-attempt timeout policy after model fallback", async () => {
		fs.writeFileSync(release, "release");
		mockPi.onCall({ delay: 1_600, exitCode: 1, jsonl: [{ type: "message_end", message: {
			role: "assistant", content: [{ type: "text", text: "provider failure" }], errorMessage: "rate limit exceeded",
		} }] });
		mockPi.onCall({ delay: 1_600, output: report });
		const completion = runSync(dir, [agent("reviewer", { model: "mock/first", fallbackModels: ["mock/second"] })], "reviewer", "Review the result", {
			runId: "fallback-lifetime", signal: controller.signal, timeoutMs: 3_000,
			acceptance: acceptance(), agentContract: { version: 1 },
		});
		pending = completion;
		const result = await completion;
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.timedOut, undefined);
		assert.equal(result.modelAttempts?.length, 2);
		assert.equal(result.acceptance?.status, "verified");
	});

	it("preserves the existing paused result without reclassifying it as a timeout", async () => {
		const interrupt = new AbortController();
		mockPi.onCall({ steps: [
			{ jsonl: [events.assistantMessage(report)] },
			{ delay: 30_000, jsonl: [] },
		] });
		const completion = runSync(dir, [agent("reviewer")], "reviewer", "Review the result", {
			runId: "paused-lifetime", signal: controller.signal, interruptSignal: interrupt.signal,
			timeoutMs: 1_000, acceptance: acceptance(), agentContract: { version: 1 },
			onUpdate: (update) => {
				if (update.details?.progress?.[0]?.recentOutput.some((line) => line.includes("Done."))) interrupt.abort();
			},
		});
		pending = completion;
		await waitUntil(() => fs.existsSync(ready), "paused acceptance must retain its existing evaluation path");
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		fs.writeFileSync(release, "release");
		const result = await completion;
		assert.equal(result.interrupted, true);
		assert.equal(result.exitCode, 0);
		assert.equal(result.timedOut, undefined);
		assert.equal(result.execution?.status, "paused");
		assert.equal(result.acceptance?.status, "verified");
	});

	it("keeps accepted detached verification independent of the origin signal", async () => {
		let terminal: SingleResult | undefined;
		let complete!: (result: SingleResult) => void;
		const terminalPromise = new Promise<SingleResult>((resolve) => { complete = resolve; });
		const receipt = await single({
			agentContract: { version: 1 },
			onDetachReady: (detach) => assert.equal(detach("user request"), true),
			onDetachedExit: (result) => { terminal = result; complete(result); },
		});
		pending = terminalPromise;
		assert.equal(receipt.detached, true);
		await waitUntil(() => fs.existsSync(ready), "detached verification must start");
		controller.abort();
		assert.equal(terminal, undefined);
		fs.writeFileSync(release, "release");
		const result = await terminalPromise;
		assert.equal(result.exitCode, 0);
		assert.equal(result.acceptance?.status, "verified");
		assert.equal(fs.existsSync(next), true);
	});

	it("preserves successful verification and removes its cancellation listener", async () => {
		fs.writeFileSync(release, "release");
		const result = await single({ agentContract: { version: 1 }, timeoutMs: 30_000 });
		assert.equal(result.exitCode, 0);
		assert.equal(result.acceptance?.status, "verified");
		assert.deepEqual(result.acceptance?.verifyRuns.map((run) => run.status), ["passed", "passed"]);
		assert.equal(fs.existsSync(next), true);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		controller.abort();
		assert.equal(result.exitCode, 0);
	});
});
