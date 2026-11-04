import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildAsyncRunnerSteps } from "../../src/runs/background/async-execution.ts";
import type { ChainStep } from "../../src/shared/settings.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

const cases = ["$&", "$$", "$`", "$'", "$1-$99-$<name>-plain"];

function makeAgent(name: string): AgentConfig {
	return {
		name, description: `Test agent: ${name}`, systemPrompt: "", systemPromptMode: "replace",
		inheritProjectContext: false, inheritSkills: false, source: "project", filePath: `${name}.md`,
	};
}

describe("async chain literal template values", () => {
	for (const mode of ["sequential", "parallel", "dynamic"] as const) {
		for (const token of cases) {
			it(`preserves ${JSON.stringify(token)} in ${mode} task and directory values`, () => {
				const cwd = path.join(process.cwd(), `literal-${token}`);
				const task = `goal ${token} 한글`;
				const template = "BEGIN {task} MIDDLE {chain_dir} AGAIN {task} END";
				const leaf = { agent: "reviewer", task: template };
				const chain: ChainStep[] = mode === "sequential" ? [leaf]
					: mode === "parallel" ? [{ parallel: [leaf, leaf] }]
					: [
						{ agent: "source", task: "List targets", as: "targets" },
						{
							expand: { from: { output: "targets", path: "/items" }, maxItems: 2 },
							parallel: leaf,
							collect: { as: "reviews" },
						},
					];
				const built = buildAsyncRunnerSteps("literal-templates", {
					chain,
					task,
					agents: [makeAgent("source"), makeAgent("reviewer")],
					ctx: { pi: {} as never, cwd, currentSessionId: "literal-session" },
					asyncDir: path.join(cwd, "async"),
					maxSubagentDepth: 1,
				});
				assert.ok("steps" in built, "expected successful build");
				const step = built.steps.at(-1)!;
				assert.ok(!("checkpoint" in step));
				const leaves = "parallel" in step
					? (Array.isArray(step.parallel) ? step.parallel : [step.parallel])
					: [step];
				for (const child of leaves) {
					assert.equal(child.task, `BEGIN ${task} MIDDLE ${cwd} AGAIN ${task} END`);
				}
			});
		}
	}
});
