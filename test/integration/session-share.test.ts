import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

interface Scenario {
	share?: boolean | string;
	viewerTemplate?: string;
	authStatus?: number;
	uploadStatus?: number;
	exportError?: string;
	missingSession?: boolean;
}

interface TraceEvent {
	kind: "guard-ready" | "export" | "command" | "unexpected-command" | "unexpected-network";
	command?: string;
	args?: string[];
	inputPath?: string;
	outputPath?: string;
}

interface ShareOutcome {
	state: string;
	success?: boolean;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
}

function runShareScenario(scenario: Scenario) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "weasley-share-test-"));
	try {
		const asyncDir = path.join(root, "run");
		const sessionDir = path.join(root, "sessions");
		const piPackageRoot = path.join(root, "fake-pi");
		const exportDir = path.join(piPackageRoot, "dist", "core", "export-html");
		for (const dir of [asyncDir, sessionDir, exportDir]) fs.mkdirSync(dir, { recursive: true });
		const tracePath = path.join(root, "trace.jsonl");
		const sessionFile = path.join(sessionDir, "fixture.jsonl");
		if (!scenario.missingSession) fs.writeFileSync(sessionFile, '{"type":"session","id":"fake-share-session"}\n');
		fs.writeFileSync(path.join(piPackageRoot, "package.json"), '{"type":"module"}');
		fs.writeFileSync(path.join(exportDir, "index.js"), `
			import fs from "node:fs";
			export function exportFromFile(inputPath, { outputPath }) {
				fs.appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ kind: "export", inputPath, outputPath }) + "\\n");
				if (${JSON.stringify(scenario.exportError ?? "")}) throw new Error(${JSON.stringify(scenario.exportError ?? "")});
				fs.readFileSync(inputPath, "utf-8");
				fs.writeFileSync(outputPath, "<html>synthetic session fixture</html>");
				return outputPath;
			}
		`);
		const runnerConfigPath = path.join(root, "config.json");
		const resultPath = path.join(root, "result.json");
		fs.writeFileSync(runnerConfigPath, JSON.stringify({
			id: "share-fixture", steps: [], cwd: root, placeholder: "{previous}",
			asyncDir, sessionDir, piPackageRoot, resultPath,
			...(scenario.share !== undefined ? { share: scenario.share } : {}),
		}));
		const scenarioPath = path.join(root, "scenario.json");
		fs.writeFileSync(scenarioPath, JSON.stringify({ ...scenario, runnerConfigPath, tracePath }));
		// No agent steps are needed: this exercises the actual runner's share
		// finalization over an existing synthetic session, with every CLI mocked.
		const child = spawnSync(process.execPath, [
			"--experimental-strip-types",
			"--import", new URL("../support/register-loader.mjs", import.meta.url).href,
			fileURLToPath(new URL("../support/share-runner-fixture.mjs", import.meta.url)), scenarioPath,
		], { encoding: "utf-8", timeout: 15_000, windowsHide: true });
		assert.equal(child.error, undefined, String(child.error));
		assert.equal(child.status, 0, child.stderr || child.stdout);
		const trace = fs.readFileSync(tracePath, "utf-8").trim().split("\n").map(line => JSON.parse(line) as TraceEvent);
		assert.deepEqual(trace[0], { kind: "guard-ready" });
		assert.equal(trace.some(event => event.kind.startsWith("unexpected-")), false);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as ShareOutcome;
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as ShareOutcome;
		for (const field of ["shareUrl", "gistUrl", "shareError"] as const) assert.equal(status[field], result[field]);
		assert.equal(result.success, true, "sharing outcomes must not replace the execution result");
		assert.equal(status.state, "complete");
		return { result, trace: trace.slice(1), sessionFile, htmlPath: path.join(sessionDir, "fixture.html") };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("runner session sharing boundary", () => {
	for (const share of [undefined, false, "true"]) {
		it(`does not export, authenticate or upload when share is ${share === undefined ? "omitted" : JSON.stringify(share)}`, () => {
			const { result, trace } = runShareScenario({ share, viewerTemplate: "https://viewer.example/{gistId}" });
			assert.deepEqual(trace, []);
			assert.equal(result.shareUrl, undefined);
			assert.equal(result.gistUrl, undefined);
			assert.equal(result.shareError, undefined);
		});
	}

	for (const [viewerTemplate, expectedError] of [
		["http://viewer.example/{gistId}", /HTTPS/],
		["https://user:password@viewer.example/{gistId}", /credentials/],
		["https://[broken/{gistId}", /valid URL/],
		["https://viewer.example/session", /placeholder/],
	] as const) {
		it(`rejects ${viewerTemplate} before authentication or upload`, () => {
			const { result, trace } = runShareScenario({ share: true, viewerTemplate });
			assert.match(result.shareError ?? "", expectedError);
			assert.equal(result.shareUrl, undefined);
			assert.equal(result.gistUrl, undefined);
			assert.equal(trace.filter(event => event.kind === "command").length, 0);
		});
	}

	for (const viewerTemplate of [undefined, "https://viewer.example/session/{gistId}"]) {
		it(`exports and uploads only after explicit opt-in (${viewerTemplate ?? "default Gist viewer"})`, () => {
			const { result, trace, sessionFile, htmlPath } = runShareScenario({ share: true, viewerTemplate });
			assert.deepEqual(trace, [
				{ kind: "export", inputPath: sessionFile, outputPath: htmlPath },
				{ kind: "command", command: "gh", args: ["auth", "status"] },
				{ kind: "command", command: "gh", args: ["gist", "create", htmlPath] },
			]);
			assert.equal(result.gistUrl, "https://gist.github.com/example/abc123");
			assert.equal(result.shareUrl, viewerTemplate ? "https://viewer.example/session/abc123" : result.gistUrl);
			assert.equal(result.shareError, undefined);
		});
	}

	for (const [scenario, expectedError, expectedKinds] of [
		[{ missingSession: true }, /Session file not found/, []],
		[{ exportError: "mock export failed" }, /mock export failed/, ["export"]],
		[{ authStatus: 1 }, /not logged in/, ["export", "command"]],
		[{ uploadStatus: 1 }, /mock upload failed/, ["export", "command", "command"]],
	] as const) {
		it(`persists share failure without claiming a URL (${expectedError.source})`, () => {
			const { result, trace } = runShareScenario({ share: true, ...scenario });
			assert.match(result.shareError ?? "", expectedError);
			assert.equal(result.shareUrl, undefined);
			assert.equal(result.gistUrl, undefined);
			assert.deepEqual(trace.map(event => event.kind), expectedKinds);
		});
	}
});
