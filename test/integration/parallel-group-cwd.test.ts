/** Exercise real foreground/background orchestration with a synthetic Pi CLI. */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { ChainStep } from "../../src/shared/settings.ts";
import { ASYNC_DIR, RESULTS_DIR, DEFAULT_ARTIFACT_CONFIG, type ParallelHandoffManifest } from "../../src/shared/types.ts";
import { executeChain } from "../../src/runs/foreground/chain-execution.ts";
import { executeAsyncChain } from "../../src/runs/background/async-execution.ts";
import { readProcessTerminal } from "../../src/runs/background/process-terminal.ts";
import { createMockPi, createTempDir, makeMinimalCtx, removeTempDir, type MockPi } from "../support/helpers.ts";

const agent: AgentConfig = {
	name: "cwd-fixture", description: "Directory propagation fixture", systemPrompt: "",
	systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false,
	source: "builtin", filePath: "",
};
const artifactConfig = { ...DEFAULT_ARTIFACT_CONFIG, enabled: false };

describe("static parallel group working directories", () => {
	let root: string;
	let mockPi: MockPi;
	let asyncIds: string[];
	beforeEach(() => {
		root = createTempDir("parallel-group-cwd-");
		mockPi = createMockPi();
		mockPi.install();
		asyncIds = [];
	});

	async function waitForTerminal(id: string): Promise<void> {
		const asyncDir = path.join(ASYNC_DIR, id);
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			if (readProcessTerminal(asyncDir, { runId: id })?.state === "observed") return;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const logs = ["status.json", "runner.stderr.log"].map((name) => {
			try { return fs.readFileSync(path.join(asyncDir, name), "utf8"); } catch { return ""; }
		});
		assert.fail(`Runner ${id} did not terminate: ${logs.join("\n")}`);
	}

	afterEach(async () => {
		// Do not remove fixtures while a detached runner still owns them.
		for (const id of asyncIds) {
			await waitForTerminal(id);
			removeTempDir(path.join(ASYNC_DIR, id));
			fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true });
		}
		mockPi.uninstall();
		removeTempDir(root);
	});

	async function run(mode: "foreground" | "background", chain: ChainStep[], cwd: string) {
		const id = `parallel-cwd-${randomUUID()}`;
		const common = { chain, agents: [agent], cwd, artifactConfig, shareEnabled: false, maxSubagentDepth: 1,
			artifactsDir: path.join(root, "artifacts"), worktreeBaseDir: path.join(root, "worktrees"), timeoutMs: 60_000 };
		if (mode === "foreground") {
			const result = await executeChain({ ...common, runId: id, clarify: false,
				ctx: makeMinimalCtx(root) as unknown as Parameters<typeof executeChain>[0]["ctx"],
				sessionDirForIndex: () => undefined,
				controlConfig: { enabled: false, needsAttentionAfterMs: 0, activeNoticeAfterMs: 0,
					failedToolAttemptsBeforeAttention: 0, notifyOn: [], notifyChannels: [] },
			});
			return { success: !result.isError, text: result.content.map((item) => item.text).join("\n"),
				parallelHandoff: result.details.parallelHandoff };
		}
		const started = executeAsyncChain(id, { ...common,
			ctx: { cwd: root, currentSessionId: "parallel-cwd-session", pi: { events: { emit() {} } } as unknown as Parameters<typeof executeAsyncChain>[1]["ctx"]["pi"] },
		});
		assert.ok(!started.isError, JSON.stringify(started));
		asyncIds.push(id);
		await waitForTerminal(id);
		return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${id}.json`), "utf8")) as {
			success: boolean; text?: string; error?: string; parallelHandoff?: { path: string; cleanupState: string };
		};
	}

	const cases = [
		{ name: "inherits a relative group directory", group: "packages/ui" },
		{ name: "inherits an absolute group directory", group: "absolute" },
		{ name: "resolves a relative task directory inside its group", group: "packages/ui", task: "nested" },
		{ name: "keeps absolute task overrides authoritative", group: "packages/ui", task: "absolute" },
		{ name: "preserves the run directory without a group override" },
		{ name: "preserves relative task overrides without a group override", task: "nested" },
	] as const;
	for (const mode of ["foreground", "background"] as const) {
		for (const entry of cases) {
			it(`${mode}: ${entry.name}`, async () => {
				const runCwd = path.join(root, "run with spaces");
				const groupValue = "group" in entry ? entry.group : undefined;
				const groupCwd = groupValue === "absolute" ? path.join(root, "absolute group") : groupValue;
				const taskValue = "task" in entry ? entry.task : undefined;
				const taskCwd = taskValue === "absolute" ? path.join(root, "absolute task") : taskValue;
				const groupBase = groupCwd ? path.resolve(runCwd, groupCwd) : runCwd;
				const expected = taskCwd ? path.resolve(groupBase, taskCwd) : groupBase;
				// Both correct and old resolution targets exist, so failures prove the
				// child ran in the wrong place rather than just failing to spawn.
				for (const dir of [runCwd, groupBase, expected, path.resolve(runCwd, taskCwd ?? ".")]) fs.mkdirSync(dir, { recursive: true });
				for (const marker of ["first", "second", "after"]) mockPi.onCall({
					matchArgIncludes: `Inspect ${marker}`, output: `${marker} complete`,
					writeFiles: [{ path: `${marker}.txt`, content: marker }],
				});
				const result = await run(mode, [
					{ cwd: groupCwd, parallel: [
						{ agent: agent.name, task: "Inspect first", cwd: taskCwd, acceptance: false },
						{ agent: agent.name, task: "Inspect second", acceptance: false },
					] },
					{ agent: agent.name, task: "Inspect after", acceptance: false },
				], runCwd);
				assert.equal(result.success, true, JSON.stringify(result));
				assert.equal(mockPi.callCount(), 3);
				assert.equal(fs.existsSync(path.join(expected, "first.txt")), true, `first child should run in ${expected}`);
				assert.equal(fs.existsSync(path.join(groupBase, "second.txt")), true, `sibling should run in ${groupBase}`);
				assert.equal(fs.readFileSync(path.join(runCwd, "after.txt"), "utf8"), "after", "group cwd must not leak to later steps");
				if (expected !== runCwd) assert.equal(fs.existsSync(path.join(runCwd, "first.txt")), false);
			});
		}

		it(`${mode}: creates worktrees from the selected group repository and subdirectory`, async () => {
			const repo = path.join(root, "selected repository");
			const packageDir = path.join(repo, "packages", "ui");
			fs.mkdirSync(packageDir, { recursive: true });
			fs.writeFileSync(path.join(packageDir, "input.md"), "input\n");
			for (const args of [["init"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Fixture"]]) {
				const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
				assert.equal(result.status, 0, result.stderr);
			}
			mockPi.onCall({ output: "review complete", writeFiles: [{ path: "child.txt", content: "group worktree\n" }] });
			const result = await run(mode, [{ cwd: path.relative(root, packageDir), worktree: true,
				parallel: [{ agent: agent.name, task: "Inspect group worktree", cwd: ".", reads: ["input.md"], acceptance: false }],
			}], root);
			assert.equal(result.success, true, JSON.stringify(result));
			assert.equal(result.parallelHandoff?.cleanupState, "complete");
			assert.ok(result.parallelHandoff?.path);
			const handoff = JSON.parse(fs.readFileSync(result.parallelHandoff.path, "utf8")) as ParallelHandoffManifest;
			assert.equal(path.resolve(handoff.groups[0]!.repoRoot), path.resolve(repo));
			const patch = fs.readFileSync(handoff.groups[0]!.children[0]!.patch.path, "utf8");
			assert.match(patch, /b\/packages\/ui\/child\.txt/);
			assert.equal(fs.existsSync(path.join(packageDir, "child.txt")), false, "source checkout remains untouched");
			const records = fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-") && name.endsWith(".json"));
			assert.equal(records.length, 1);
			const { args } = JSON.parse(fs.readFileSync(path.join(mockPi.dir, records[0]!), "utf8")) as { args: string[] };
			if (mode === "background") {
				assert.ok(args.at(-1)?.includes(`${path.sep}packages${path.sep}ui${path.sep}input.md`), "reads must resolve inside the selected worktree package");
			}
		});
	}
});
