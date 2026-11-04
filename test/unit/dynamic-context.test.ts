import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { buildAsyncRunnerSteps, type AsyncRunnerStepBuildParams } from "../../src/runs/background/async-execution.ts";
import type { ContextMode } from "../../src/runs/shared/context-mode.ts";
import { materializeDynamicParallelStep, validateDynamicStepShape } from "../../src/runs/shared/dynamic-fanout.ts";
import { isDynamicRunnerGroup } from "../../src/runs/shared/parallel-utils.ts";
import type { DynamicParallelStep } from "../../src/shared/settings.ts";
import type { ChainOutputMap } from "../../src/shared/types.ts";

const dynamicStep: DynamicParallelStep = {
	expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 2 },
	parallel: { agent: "reviewer", task: "Review {target.path}", label: "Check {target.path}" },
	collect: { as: "reviews" },
};

function source(items: Array<{ path: string }>): ChainOutputMap {
	const structured = { items };
	return { targets: { text: JSON.stringify(structured), structured, agent: "producer", stepIndex: 0 } };
}

function builtStep(t: TestContext, context?: ContextMode): DynamicParallelStep {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-context-build-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const agents: AgentConfig[] = ["producer", "reviewer"].map((name) => ({
		name, description: "Context fixture", source: "builtin", filePath: "", systemPrompt: "",
		systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false,
		defaultProgress: false,
	}));
	const built = buildAsyncRunnerSteps("dynamic-context", {
		chain: [{ agent: "producer", task: "Produce targets", as: "targets" }, dynamicStep],
		agents, ctx: { pi: {} as AsyncRunnerStepBuildParams["ctx"]["pi"], cwd, currentSessionId: "context-parent" },
		asyncDir: path.join(cwd, "async"),
		maxSubagentDepth: 1,
		...(context ? { contextForAgent: () => context } : {}),
	});
	assert.ok("steps" in built, "error" in built ? built.error : "expected runner steps");
	const group = built.steps[1]!;
	assert.ok(isDynamicRunnerGroup(group));
	assert.equal(group.parallel.context, context);
	// The background runner consumes the JSON-persisted builder output.
	return JSON.parse(JSON.stringify(group)) as DynamicParallelStep;
}

describe("dynamic fanout runtime context", () => {
	for (const context of ["fresh", "fork"] as const) {
		it(`materializes every child with the builder's ${context} context`, (t) => {
			const step = builtStep(t, context);
			const group = materializeDynamicParallelStep(step, source([{ path: "src/a.ts" }, { path: "src/b.ts" }]), 1, { allowRunnerFields: true });
			assert.deepEqual(group.parallel.map((child) => child.task), ["Review src/a.ts", "Review src/b.ts"]);
			assert.deepEqual(group.parallel.map((child) => child.label), ["Check src/a.ts", "Check src/b.ts"]);
			assert.deepEqual(group.parallel.map((child) => (child as { context?: ContextMode }).context), [context, context]);
		});

		it(`keeps empty-source skip behavior with ${context} runtime context`, (t) => {
			const group = materializeDynamicParallelStep(builtStep(t, context), source([]), 1, { allowRunnerFields: true });
			assert.deepEqual(group, { items: [], parallel: [], collectedOnEmpty: [] });
		});

		it(`keeps empty-source failure behavior with ${context} runtime context`, (t) => {
			const step = builtStep(t, context);
			step.expand = { ...step.expand, onEmpty: "fail" };
			assert.throws(() => materializeDynamicParallelStep(step, source([]), 1, { allowRunnerFields: true }), /source array is empty/);
		});

		it(`continues rejecting caller-supplied ${context} context on a dynamic template`, () => {
			const step = { ...dynamicStep, parallel: { ...dynamicStep.parallel, context } };
			assert.throws(() => validateDynamicStepShape(step, 1), /parallel does not support field 'context'/);
		});
	}

	it("keeps older runner configurations without context compatible", (t) => {
		const group = materializeDynamicParallelStep(builtStep(t), source([{ path: "src/a.ts" }]), 1, { allowRunnerFields: true });
		assert.equal(group.parallel[0]?.task, "Review src/a.ts");
		assert.equal(Object.hasOwn(group.parallel[0]!, "context"), false);
	});

	it("continues rejecting unrelated fields in runner templates", () => {
		const step = { ...dynamicStep, parallel: { ...dynamicStep.parallel, unexpected: true } };
		assert.throws(() => validateDynamicStepShape(step, 1, { allowRunnerFields: true }), /parallel does not support field 'unexpected'/);
	});
});
