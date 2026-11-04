import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { executeChain } from "../../src/runs/foreground/chain-execution.ts";
import { DEFAULT_CONTROL_CONFIG } from "../../src/runs/shared/subagent-control.ts";
import type { ChainStep } from "../../src/shared/settings.ts";
import { getSingleResultOutput } from "../../src/shared/utils.ts";
import { createMockPi, createTempDir, makeMinimalCtx, removeTempDir, type MockPi } from "../support/helpers.ts";

import type { AgentConfig } from "../../src/agents/agents.ts";

const cases = ["$&", "$$", "$`", "$'", "$1-$99-$<name>-plain"];

function makeAgent(name: string): AgentConfig {
	return {
		name, description: `Test agent: ${name}`, systemPrompt: "", systemPromptMode: "replace",
		inheritProjectContext: false, inheritSkills: false, source: "project", filePath: `${name}.md`,
	};
}

describe("foreground chain literal template values", () => {
	let mockPi: MockPi;
	let tempDir: string;
	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});
	after(() => mockPi.uninstall());
	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});
	afterEach(() => removeTempDir(tempDir));

	for (const mode of ["sequential", "parallel", "dynamic"] as const) {
		for (const token of cases) {
			it(`preserves ${JSON.stringify(token)} across ${mode} child handoffs`, async () => {
				const originalTask = `goal ${token} 한글`;
				const sourceOutput = `context ${token} 줄\nnext line`;
				const runId = "literal-handoff";
				const chainDir = path.join(tempDir, `chain-${token.replace(/[<>]/g, "_")}`);
				const template = "BEGIN {task} PREV {previous} DIR {chain_dir} AGAIN {previous} END";
				const leaf = { agent: "reviewer", task: template };
				const chain: ChainStep[] = [
					{ agent: "source", task: "Gather context", as: "targets", ...(mode === "dynamic" ? { outputSchema: { type: "object" } } : {}) },
					...(mode === "sequential" ? [leaf]
						: mode === "parallel" ? [{ parallel: [leaf, leaf], concurrency: 2 }]
						: [{
							expand: { from: { output: "targets", path: "/items" }, maxItems: 2 },
							parallel: leaf,
							collect: { as: "reviews" },
							concurrency: 2,
						}]),
				];
				mockPi.onCall({ output: sourceOutput, ...(mode === "dynamic" ? { structuredOutput: { items: ["a", "b"] } } : {}) });
				mockPi.onCall({ output: "Reviewed" });
				mockPi.onCall({ output: "Reviewed" });
				const result = await executeChain({
					chain,
					task: originalTask,
					agents: [makeAgent("source"), makeAgent("reviewer")],
					ctx: makeMinimalCtx(tempDir) as unknown as Parameters<typeof executeChain>[0]["ctx"],
					runId,
					chainDir,
					shareEnabled: false,
					sessionDirForIndex: () => undefined,
					artifactsDir: path.join(tempDir, "artifacts"),
					artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
					controlConfig: DEFAULT_CONTROL_CONFIG,
					maxSubagentDepth: 1,
					clarify: false,
				});
				assert.ok(!result.isError, JSON.stringify(result.content));
				const previous = getSingleResultOutput(result.details.results[0]!);
				assert.equal(previous, sourceOutput);
				const expected = `BEGIN ${originalTask} PREV ${previous} DIR ${path.join(chainDir, runId)} AGAIN ${previous} END`;
				const calls = fs.readdirSync(mockPi.dir).filter((name) => /^call-.*\.json$/.test(name)).sort();
				assert.equal(calls.length, mode === "sequential" ? 2 : 3);
				for (const call of calls.slice(1)) {
					const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, call), "utf-8")).args as string[];
					const prompt = args.at(-1)!;
					assert.equal(prompt.slice(prompt.indexOf("BEGIN "), prompt.lastIndexOf(" END") + 4), expected, "the actual child prompt must retain literal values");
				}
			});
		}
	}
});
