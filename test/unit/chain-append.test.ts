import assert from "node:assert/strict";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	appendRunnerStepsToStatus,
	consumeChainAppendRequests,
	countPendingChainAppendRequests,
	enqueueChainAppendRequest,
	readPendingChainAppendRequests,
	runnerStepOutputNames,
} from "../../src/runs/background/chain-append.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";
import type { RunnerStep } from "../../src/runs/shared/parallel-utils.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

function writeStatus(asyncDir: string, status: Partial<AsyncStatus> & Pick<AsyncStatus, "runId" | "mode" | "state" | "startedAt">): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
}

function readStatus(asyncDir: string): AsyncStatus {
	return JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatus;
}

function runnerStep(agent: string, task = "Use {previous}"): RunnerStep {
	return {
		agent,
		task,
		inheritProjectContext: false,
		inheritSkills: false,
	};
}

describe("chain append requests", () => {
	it("persists append requests for running async chains and records pending status", () => {
		const root = createTempDir("pi-chain-append-");
		try {
			const asyncDir = path.join(root, "run-a");
			writeStatus(asyncDir, {
				runId: "run-a",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 100,
				chainStepCount: 1,
				steps: [{ agent: "scout", status: "running" }],
			});

			const result = enqueueChainAppendRequest({
				asyncDir,
				runId: "run-a",
				steps: [runnerStep("worker")],
				now: 200,
			});

			assert.equal(result.pendingCount, 1);
			assert.equal(countPendingChainAppendRequests(asyncDir), 1);
			const status = readStatus(asyncDir);
			assert.equal(status.pendingAppends, 1);
			assert.equal(status.lastUpdate, 200);
			const eventLog = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
			assert.match(eventLog, /subagent\.chain\.append\.requested/);

			const { requests: consumed, error } = consumeChainAppendRequests(asyncDir);
			assert.equal(error, undefined);
			assert.equal(consumed.length, 1);
			assert.equal(consumed[0]!.id, result.request.id);
			assert.equal(countPendingChainAppendRequests(asyncDir), 0);
		} finally {
			removeTempDir(root);
		}
	});

	for (const code of ["EACCES", "EBUSY"] as const) {
		it(`retains blocked ${code} requests without replaying or losing an earlier consumed batch`, (t) => {
			const root = createTempDir("pi-chain-append-blocked-");
			const dir = path.join(root, "append-requests");
			fs.mkdirSync(dir);
			for (const id of ["a", "b", "c"]) {
				fs.writeFileSync(path.join(dir, `100-${id}.json`), JSON.stringify({ id, createdAt: 100, steps: [runnerStep(id)] }));
			}
			const blocked = path.join(dir, "100-b.json");
			const unlink = fsDefault.unlinkSync;
			const mock = t.mock.method(fsDefault, "unlinkSync", (file: fs.PathLike) => {
				if (String(file) === blocked) throw Object.assign(new Error(`injected ${code}`), { code });
				return unlink(file);
			});
			syncBuiltinESMExports();
			try {
				const first = consumeChainAppendRequests(root);
				assert.deepEqual(first.requests.map((request) => request.id), ["a"]);
				assert.match(first.error ?? "", new RegExp(code));
				assert.deepEqual(fs.readdirSync(dir).sort(), ["100-b.json", "100-c.json"]);
				const second = consumeChainAppendRequests(root);
				assert.deepEqual(second.requests, []);
				assert.match(second.error ?? "", new RegExp(code));
				mock.mock.restore();
				syncBuiltinESMExports();
				assert.deepEqual(consumeChainAppendRequests(root).requests.map((request) => request.id), ["b", "c"]);
				assert.deepEqual(consumeChainAppendRequests(root), { requests: [] });
			} finally {
				mock.mock.restore();
				syncBuiltinESMExports();
				removeTempDir(root);
			}
		});
	}

	it("does not yield a request when another consumer removes it first", (t) => {
		const root = createTempDir("pi-chain-append-race-");
		const dir = path.join(root, "append-requests");
		fs.mkdirSync(dir);
		const file = path.join(dir, "100-a.json");
		fs.writeFileSync(file, JSON.stringify({ id: "a", createdAt: 100, steps: [runnerStep("worker")] }));
		const unlink = fsDefault.unlinkSync;
		const mock = t.mock.method(fsDefault, "unlinkSync", (target: fs.PathLike) => {
			unlink(target);
			throw Object.assign(new Error("another consumer won"), { code: "ENOENT" });
		});
		syncBuiltinESMExports();
		try {
			assert.deepEqual(consumeChainAppendRequests(root), { requests: [] });
			assert.equal(fs.existsSync(file), false);
		} finally {
			mock.mock.restore();
			syncBuiltinESMExports();
			removeTempDir(root);
		}
	});

	it("returns an earlier consumed request when a later request cannot be parsed", () => {
		const root = createTempDir("pi-chain-append-malformed-");
		const dir = path.join(root, "append-requests");
		fs.mkdirSync(dir);
		try {
			fs.writeFileSync(path.join(dir, "100-a.json"), JSON.stringify({ id: "a", createdAt: 100, steps: [runnerStep("worker")] }));
			fs.writeFileSync(path.join(dir, "100-b.json"), "{");
			const consumed = consumeChainAppendRequests(root);
			assert.deepEqual(consumed.requests.map((request) => request.id), ["a"]);
			assert.match(consumed.error ?? "", /Failed to consume chain append request '100-b.json'/);
			assert.deepEqual(fs.readdirSync(dir), ["100-b.json"]);
		} finally {
			removeTempDir(root);
		}
	});

	it("reads pending append requests without consuming them and reports reserved output names", () => {
		const root = createTempDir("pi-chain-append-pending-");
		try {
			const asyncDir = path.join(root, "run-pending");
			writeStatus(asyncDir, {
				runId: "run-pending",
				mode: "chain",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "scout", status: "running" }],
			});
			enqueueChainAppendRequest({
				asyncDir,
				runId: "run-pending",
				steps: [{
					parallel: [
						{ ...runnerStep("worker"), outputName: "draft" },
						{ ...runnerStep("reviewer"), outputName: "review" },
					],
				}],
				now: 200,
			});

			const pending = readPendingChainAppendRequests(asyncDir);

			assert.equal(pending.length, 1);
			assert.deepEqual(runnerStepOutputNames(pending[0]!.steps), ["draft", "review"]);
			assert.equal(countPendingChainAppendRequests(asyncDir), 1);
		} finally {
			removeTempDir(root);
		}
	});

	it("rejects terminal and non-chain async runs", () => {
		const root = createTempDir("pi-chain-append-reject-");
		try {
			const completeDir = path.join(root, "complete");
			writeStatus(completeDir, {
				runId: "complete",
				mode: "chain",
				state: "complete",
				startedAt: 100,
				steps: [{ agent: "scout", status: "complete" }],
			});
			assert.throws(
				() => enqueueChainAppendRequest({ asyncDir: completeDir, runId: "complete", steps: [runnerStep("worker")] }),
				/only running chain runs/,
			);

			const parallelDir = path.join(root, "parallel");
			writeStatus(parallelDir, {
				runId: "parallel",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "scout", status: "running" }],
			});
			assert.throws(
				() => enqueueChainAppendRequest({ asyncDir: parallelDir, runId: "parallel", steps: [runnerStep("worker")] }),
				/only active chain runs/,
			);

			const drainedDir = path.join(root, "drained");
			writeStatus(drainedDir, {
				runId: "drained",
				mode: "chain",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "scout", status: "complete" }],
			});
			assert.throws(
				() => enqueueChainAppendRequest({ asyncDir: drainedDir, runId: "drained", steps: [runnerStep("worker")] }),
				/no running or pending chain steps left/,
			);
		} finally {
			removeTempDir(root);
		}
	});

	it("extends async chain status, parallel groups, and workflow graph", () => {
		const status: AsyncStatus = {
			runId: "run-graph",
			mode: "chain",
			state: "running",
			startedAt: 100,
			currentStep: 0,
			chainStepCount: 1,
			steps: [{ agent: "scout", status: "complete" }],
			parallelGroups: [],
			workflowGraph: {
				runId: "run-graph",
				mode: "chain",
				phases: [],
				nodes: [{
					id: "step-0",
					kind: "step",
					agent: "scout",
					label: "scout",
					status: "completed",
					flatIndex: 0,
					stepIndex: 0,
				}],
			},
		};
		const appended: RunnerStep[] = [
			runnerStep("worker"),
			{
				parallel: [
					runnerStep("reviewer"),
					runnerStep("auditor"),
				],
				concurrency: 2,
			},
		];

		const result = appendRunnerStepsToStatus({ status, steps: appended, now: 300, pendingAppends: 0 });

		assert.deepEqual(result, { addedChainSteps: 2, addedFlatSteps: 3 });
		assert.equal(status.chainStepCount, 3);
		assert.equal(status.pendingAppends, 0);
		assert.equal(status.lastUpdate, 300);
		assert.deepEqual(status.steps?.map((step) => `${step.agent}:${step.status}`), [
			"scout:complete",
			"worker:pending",
			"reviewer:pending",
			"auditor:pending",
		]);
		assert.deepEqual(status.parallelGroups, [{ start: 2, count: 2, stepIndex: 2 }]);
		assert.equal(status.workflowGraph?.nodes[1]?.id, "step-1");
		assert.equal(status.workflowGraph?.nodes[2]?.kind, "parallel-group");
		assert.deepEqual(status.workflowGraph?.nodes[2]?.children?.map((child) => child.flatIndex), [2, 3]);
	});
});
