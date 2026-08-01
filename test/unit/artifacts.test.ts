import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	getArtifactsDir,
	getProjectArtifactsDir,
	getProjectChainRunsDir,
	getProjectSubagentsDir,
} from "../../src/shared/artifacts.ts";

describe("project-local artifact paths", () => {
	it("places generated subagent files under .weasley-subagents for a project cwd", () => {
		const cwd = path.join("tmp", "repo");
		assert.equal(getProjectSubagentsDir(cwd), path.join(cwd, ".weasley-subagents"));
		assert.equal(getProjectArtifactsDir(cwd), path.join(cwd, ".weasley-subagents", "artifacts"));
		assert.equal(getProjectChainRunsDir(cwd), path.join(cwd, ".weasley-subagents", "chain-runs"));
		assert.equal(getArtifactsDir(null, cwd), path.join(cwd, ".weasley-subagents", "artifacts"));
	});

	it("keeps the session artifact fallback when no project cwd is available", () => {
		const sessionFile = path.join("tmp", "sessions", "parent.jsonl");
		assert.equal(getArtifactsDir(sessionFile), path.join("tmp", "sessions", "subagent-artifacts"));
	});
});

