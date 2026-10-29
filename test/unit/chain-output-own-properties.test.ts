import assert from "node:assert/strict";
import { it } from "node:test";
import { resolveOutputReferences } from "../../src/runs/shared/chain-outputs.ts";
import { resolveDynamicFanoutItems } from "../../src/runs/shared/dynamic-fanout.ts";

it("rejects inherited output names instead of rendering undefined", () => {
	for (const name of ["constructor", "toString", "__proto__"]) {
		assert.throws(() => resolveOutputReferences(`{outputs.${name}}`, {}), /Unknown chain output reference/);
	}
});

it("does not expand inherited structured outputs", () => {
	const outputs = Object.create({ targets: { text: "[]", structured: [1], agent: "producer", stepIndex: 0 } });
	assert.throws(() => resolveDynamicFanoutItems({
		expand: { from: { output: "targets", path: "" }, item: "target", maxItems: 2 },
		parallel: { agent: "worker", task: "Use {target}" }, collect: { as: "reviews" },
	}, outputs, 1), /unknown output 'targets'/);
});

it("resolves own prototype-named entries restored from JSON", () => {
	const outputs = JSON.parse('{"__proto__":{"text":"named output","agent":"producer","stepIndex":0}}');
	assert.equal(resolveOutputReferences("Use {outputs.__proto__}", outputs), "Use named output");
});
