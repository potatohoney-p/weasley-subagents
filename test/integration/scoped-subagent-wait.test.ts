import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { Compile } from "typebox/compile";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerWaitTool } from "../../src/runs/background/wait-tool.ts";
import { SubagentWaitParams } from "../../src/extension/schemas.ts";
import { registerBackgroundWorkProvider } from "../../src/api/background-work.ts";
import { ASYNC_DIR, RESULTS_DIR, type Details, type SubagentState } from "../../src/shared/types.ts";
import { createEventBus, createMockPi, events } from "../support/helpers.ts";

function isError(result: unknown): boolean | undefined {
	return (result as { isError?: boolean }).isError;
}

async function until(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

it("registers scoped wait and joins real synthetic async reviewers without draining unrelated work", { timeout: 60_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "weasley-scoped-fan-in-"));
	const sessionId = `scoped-${randomUUID()}`;
	const ids = ["a", "b", "unrelated"].map((name) => `${sessionId}-${name}`);
	const releases = ids.map((id) => path.join(root, `${id}.release`));
	const mock = createMockPi();
	mock.install();
	const bus = createEventBus();
	let tool: ToolDefinition<typeof SubagentWaitParams, Details> | undefined;
	const pi = { events: bus, registerTool: (value: typeof tool) => { tool = value; } } as unknown as ExtensionAPI;
	const state = { currentSessionId: sessionId, foregroundRuns: new Map() } as SubagentState;
	let providerReads = 0;
	const dispose = registerBackgroundWorkProvider({
		name: sessionId,
		listActiveWork: () => { providerReads++; throw new Error("unrelated provider unavailable"); },
	});
	const launched: string[] = [];
	try {
		registerWaitTool(pi, state, true);
		assert.ok(tool);
		assert.match(tool.description, /ids/);
		const validator = Compile(tool.parameters);
		assert.equal(validator.Check({ ids: [ids[0], ids[1]], all: true }), true);
		for (const invalid of [[], [""], [ids[0], ids[0]], Array.from({ length: 101 }, (_, i) => String(i)), ["x".repeat(257)]]) {
			assert.equal(validator.Check({ ids: invalid }), false);
		}
		const { executeAsyncSingle } = await import("../../src/runs/background/async-execution.ts");
		for (const [index, id] of ids.entries()) {
			mock.onCall({ matchArgIncludes: id, waitForPath: releases[index], jsonl: [events.assistantMessage(`${id} reviewed`)] });
			const started = executeAsyncSingle(id, {
				agent: "reviewer", task: `Review fixture ${id}`,
				agentConfig: {
					name: "reviewer", description: "Synthetic read-only reviewer", systemPrompt: "", systemPromptMode: "replace",
					inheritProjectContext: false, inheritSkills: false, source: "user", filePath: path.join(root, "reviewer.md"),
				},
				ctx: { pi, cwd: root, currentSessionId: sessionId },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false, sessionRoot: path.join(root, "sessions"), maxSubagentDepth: 1,
			});
			assert.equal(started.isError, undefined, started.content[0]?.text);
			launched.push(id);
		}
		await until(() => mock.callCount() === 3, "all synthetic reviewers ready at release gates");
		const readState = (id: string) => JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8")).state;
		assert.ok(ids.every((id) => readState(id) === "running"));

		const first = tool.execute("first", { ids: ids.slice(0, 2), timeoutMs: 15_000 }, undefined, undefined, {} as never);
		fs.writeFileSync(releases[0]!, "release");
		const firstResult = await first;
		assert.equal(isError(firstResult), undefined);
		const firstText = firstResult.content.map((part) => part.type === "text" ? part.text : "").join("");
		assert.match(firstText, /1 of 2 selected run\(s\) finished/);
		assert.ok(firstText.includes(`${ids[0]} (complete)`));
		assert.equal(readState(ids[1]!), "running");
		assert.equal(readState(ids[2]!), "running");

		const joined = tool.execute("join", { ids: ids.slice(0, 2), all: true, timeoutMs: 15_000 }, undefined, undefined, {} as never);
		fs.writeFileSync(releases[1]!, "release");
		const joinedResult = await joined;
		assert.equal(isError(joinedResult), undefined);
		const joinedText = joinedResult.content.map((part) => part.type === "text" ? part.text : "").join("");
		assert.match(joinedText, /1 selected async run\(s\); done/);
		assert.ok(joinedText.includes(`${ids[1]} (complete)`));
		assert.equal(readState(ids[2]!), "running", "unrelated reviewer must remain in flight");
		assert.equal(providerReads, 0, "scoped barriers must not inspect unrelated providers");
	} finally {
		// Release only these owned, bounded fixtures. No process-signaling cleanup.
		for (const release of releases) fs.writeFileSync(release, "release");
		try {
			await until(() => launched.every((id) => fs.existsSync(path.join(RESULTS_DIR, `${id}.json`))), "owned async results before fixture cleanup");
			for (const id of launched) {
				const result = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${id}.json`), "utf8"));
				assert.equal(result.success, true, result.error);
				assert.ok(result.results[0]?.output.includes(`${id} reviewed`));
			}
		} finally {
			dispose();
			mock.uninstall();
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
});
