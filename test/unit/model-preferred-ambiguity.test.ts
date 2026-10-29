import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildModelCandidates, fuzzyResolveModel, resolveEffectiveSubagentModel, resolveModelCandidate } from "../../src/runs/shared/model-fallback.ts";
import { buildPiArgs, cleanupTempDir } from "../../src/runs/shared/pi-args.ts";

const entry = (provider: string, id: string) => ({ provider, id, fullId: `${provider}/${id}` });
const revisions = [entry("example", "model-20260101"), entry("example", "model-20260201")];

describe("preferred-provider fuzzy ambiguity", () => {
	it("does not choose a dated revision by registry order within the preferred provider", () => {
		for (const registry of [revisions, [...revisions].reverse()]) {
			assert.equal(fuzzyResolveModel("MODEL", registry, "example"), undefined);
			assert.equal(resolveModelCandidate("MODEL", registry, "example"), "MODEL");
		}
	});

	it("keeps qualified ambiguous spellings and thinking suffixes intact", () => {
		for (const registry of [revisions, [...revisions].reverse()]) {
			for (const query of ["example/MODEL", "Example:MODEL", "example.MODEL", "example/MODEL:high", "MODEL:high"]) {
				assert.equal(resolveModelCandidate(query, registry, "example"), query);
			}
		}
	});

	it("does not substitute a different provider when preferred matches are ambiguous", () => {
		const registry = [...revisions, entry("other", "model-20260301")];
		assert.equal(resolveModelCandidate("MODEL", registry, "example"), "MODEL");
		assert.equal(resolveModelCandidate("MODEL", registry, "other"), "other/model-20260301");
		assert.equal(resolveModelCandidate("example/MODEL", registry, "other"), "example/MODEL");
	});

	it("preserves ambiguity for separator-normalized model collisions", () => {
		const registry = [entry("example", "model-a"), entry("example", "model_a")];
		assert.equal(resolveModelCandidate("MODEL.A", registry, "Example"), "MODEL.A");
		assert.equal(resolveModelCandidate("model_a", registry, "example"), "example/model_a");
	});

	it("retains exact and unique fuzzy resolution with and without provider preference", () => {
		assert.equal(resolveModelCandidate("model-20260201", revisions, "example"), "example/model-20260201");
		assert.equal(resolveModelCandidate("example/model-20260101", revisions, "other"), "example/model-20260101");
		assert.equal(resolveModelCandidate("MODEL", [revisions[0]!], "example"), "example/model-20260101");
		assert.equal(resolveModelCandidate("MODEL", [revisions[0]!], "absent"), "example/model-20260101");
	});

	it("preserves requested model through fallback construction and child CLI arguments", () => {
		const model = resolveEffectiveSubagentModel("MODEL:high", undefined, { provider: "other", id: "default" }, revisions, "example");
		const candidates = buildModelCandidates(model, ["example/model-20260201", "MODEL:high"], revisions, "example");
		assert.deepEqual(candidates, ["MODEL:high", "example/model-20260201"]);
		for (const candidate of candidates) {
			const launch = buildPiArgs({ baseArgs: [], task: "synthetic model argument check", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false, model: candidate });
			try {
				assert.equal(launch.args.filter((arg) => arg === "--model").length, 1);
				assert.equal(launch.args[launch.args.indexOf("--model") + 1], candidate);
			} finally {
				cleanupTempDir(launch.tempDir);
			}
		}
	});
});
