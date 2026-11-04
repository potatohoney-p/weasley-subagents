import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { deliverStopRequest } from "../../src/runs/background/control-channel.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";
import { createEventBus, createMockPi, createTempDir, makeAgent } from "../support/helpers.ts";

type Context = "fresh" | "fork";
interface RunPayload {
	success: boolean;
	error?: string;
	results: Array<{ agent: string; context?: Context; output: string; error?: string }>;
	outputs?: Record<string, { structured?: unknown }>;
}
interface RunStatus {
	state: string;
	steps: Array<{ agent: string; context?: Context; sessionFile?: string }>;
}

async function waitForResult(id: string, timeoutMs = 20_000): Promise<RunPayload> {
	const resultPath = path.join(RESULTS_DIR, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(resultPath)) return JSON.parse(fs.readFileSync(resultPath, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const statusPath = path.join(ASYNC_DIR, id, "status.json");
	throw new Error(`Timed out waiting for ${id}: ${fs.existsSync(statusPath) ? fs.readFileSync(statusPath, "utf8") : "no status"}`);
}

async function waitForRunnerClose(id: string): Promise<void> {
	const statusPath = path.join(ASYNC_DIR, id, "status.json");
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (fs.existsSync(statusPath)) {
			const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
			if (status.processTerminal?.state === "observed") return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Runner close was not observed for ${id}; preserving its fixtures`);
}

// Exercise the public executor, which always supplies contextForAgent to the
// detached runner, rather than constructing a narrower async launch fixture.
describe("async dynamic fanout context", () => {
	for (const scenario of [
		{ name: "default fresh", contexts: ["fresh", "fresh", "fresh", "fresh"] },
		{ name: "explicit fresh", context: "fresh", contexts: ["fresh", "fresh", "fresh", "fresh"] },
		{ name: "explicit fork", context: "fork", contexts: ["fork", "fork", "fork", "fork"] },
		{ name: "per-agent mixed defaults", mixed: true, contexts: ["fresh", "fork", "fork", "fresh"] },
	] as const) {
		it(`completes dynamic children and consumer with ${scenario.name}`, async () => {
			const root = createTempDir("weasley-dynamic-context-");
			const mock = createMockPi();
			const environment = Object.fromEntries(["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PATH", "WEASLEY_SUBAGENT_PI_BINARY", "MOCK_PI_QUEUE_DIR"].map((key) => [key, process.env[key]]));
			const originalArgv1 = process.argv[1];
			const home = path.join(root, "home");
			fs.mkdirSync(home);
			process.env.HOME = home;
			process.env.USERPROFILE = home;
			process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
			mock.install();
			let runId: string | undefined;
			let settled = false;
			try {
				const producerResponse = { output: "targets", structuredOutput: { items: [{ id: "one" }, { id: "two" }] } };
				mock.onCall(producerResponse);
				mock.onCall({ matchArgIncludes: "Inspect one", output: "review-one" });
				mock.onCall({ matchArgIncludes: "Inspect two", output: "review-two" });
				mock.onCall({ matchArgIncludes: "Consume", output: "consumed reviews" });
				const parentSession = path.join(root, "parent.jsonl");
				const writeSession = (file: string, id: string) => fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 1, id, timestamp: "2026-11-04T00:00:00.000Z", cwd: root })}\n`);
				writeSession(parentSession, "parent");
				const forks: string[] = [];
				const sessionId = randomUUID();
				const sessionManager = {
					getSessionId: () => sessionId,
					getSessionFile: () => parentSession,
					getLeafId: () => "leaf-current",
					openSession: () => ({ createBranchedSession: () => {
						const file = path.join(root, `fork-${forks.length + 1}.jsonl`);
						writeSession(file, `child-${forks.length + 1}`);
						forks.push(file);
						return file;
					} }),
				};
				const executor = createSubagentExecutor({
					pi: { events: createEventBus(), getSessionName: () => undefined, setSessionName() {}, sendMessage() {} },
					state: {
						baseCwd: root, currentSessionId: null, asyncJobs: new Map(), cleanupTimers: new Map(),
						lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
						resultFileCoalescer: { schedule: () => false, clear() {} },
					},
					config: {}, asyncByDefault: false, tempArtifactsDir: root,
					getSubagentSessionRoot: () => root, expandTilde: (value: string) => value,
					discoverAgents: () => ({ agents: [makeAgent("producer"), { ...makeAgent("reviewer"), ...("mixed" in scenario ? { defaultContext: "fork" } : {}) }, makeAgent("consumer")], projectAgentsDir: null }),
				} as unknown as Parameters<typeof createSubagentExecutor>[0]);
				const launch = await executor.execute("dynamic-context", {
					async: true, clarify: false,
					...("context" in scenario ? { context: scenario.context } : {}),
					chain: [
						{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
						{ expand: { from: { output: "targets", path: "/items" }, maxItems: 3 }, parallel: { agent: "reviewer", task: "Inspect {item.id}" }, collect: { as: "reviews" }, concurrency: 1 },
						{ agent: "consumer", task: "Consume {outputs.reviews}" },
					],
				}, new AbortController().signal, undefined, {
					cwd: root, hasUI: false, ui: {}, modelRegistry: { getAvailable: () => [] }, sessionManager,
				} as unknown as Parameters<typeof executor.execute>[4]);
				assert.ok(!("isError" in launch && launch.isError), JSON.stringify(launch.content));
				runId = launch.details?.asyncId;
				assert.ok(runId, "executor should launch a detached chain");
				const payload = await waitForResult(runId);
				settled = true;
				assert.equal(payload.success, true, payload.error ?? payload.results.map((result) => result.error).filter(Boolean).join("; "));
				assert.equal(mock.callCount(), 4);
				assert.deepEqual(payload.results.map((result) => result.context), scenario.contexts);
				const status: RunStatus = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, runId, "status.json"), "utf8"));
				assert.deepEqual(status.steps.map((step) => step.context), scenario.contexts);
				const collection = payload.outputs?.reviews?.structured as Array<{ text: string }>;
				assert.deepEqual(collection.map((entry) => entry.text), ["review-one", "review-two"]);
				const calls = fs.readdirSync(mock.dir).filter((file) => /^call-.*\.json$/.test(file)).sort()
					.map((file) => JSON.parse(fs.readFileSync(path.join(mock.dir, file), "utf8")).args as string[]);
				assert.match(calls[3]!.at(-1)!, /review-one/);
				assert.match(calls[3]!.at(-1)!, /review-two/);
				for (let index = 0; index < calls.length; index++) {
					if (scenario.contexts[index] !== "fork") continue;
					const sessionIndex = calls[index]!.indexOf("--session");
					assert.notEqual(sessionIndex, -1);
					const session = calls[index]![sessionIndex + 1]!;
					assert.ok(forks.includes(session), `expected branched session, got ${session}`);
					assert.equal(status.steps[index]!.sessionFile, session);
				}
			} finally {
				// Result publication can precede the launcher's close callback. Keep
				// artifacts and the mock executable until process termination is observed.
				try {
					if (runId) {
						if (!settled) {
							deliverStopRequest({ asyncDir: path.join(ASYNC_DIR, runId), source: "dynamic-context-test-cleanup" });
							await waitForResult(runId);
						}
						await waitForRunnerClose(runId);
					}
					mock.uninstall();
					fs.rmSync(root, { recursive: true, force: true });
					if (runId) {
						fs.rmSync(path.join(ASYNC_DIR, runId), { recursive: true, force: true });
						fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
					}
				} finally {
					if (originalArgv1 === undefined) delete process.argv[1];
					else process.argv[1] = originalArgv1;
					for (const [key, value] of Object.entries(environment)) {
						if (value === undefined) delete process.env[key];
						else process.env[key] = value;
					}
				}
			}
		});
	}
});
