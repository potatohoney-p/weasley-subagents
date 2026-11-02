import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const schedulerUrl = new URL("../../src/runs/background/scheduled-runs.ts", import.meta.url).href;

// Run each failure in a real process with Node's strict rejection policy: a
// detached timer rejection must not terminate the extension's host process.
function runScenario(mode: string) {
	return spawnSync(process.execPath, ["--unhandled-rejections=strict", "--experimental-strip-types", "--input-type=module", "--eval", `
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { ScheduledRunManager, scheduledRunStorePath } from ${JSON.stringify(schedulerUrl)};
const mode = ${JSON.stringify(mode)};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-timer-error-"));
let now = 1000000;
let callback;
let launches = 0;
let timers = 0;
const ctx = { cwd: root, sessionManager: { getSessionFile: () => path.join(root, "session.jsonl"), getSessionId: () => "session" } };
const manager = new ScheduledRunManager({
 config: { scheduledRuns: { enabled: true } }, storeRoot: root,
 now: () => now, randomId: () => "test-job",
 timers: { setTimeout: cb => { callback = cb; timers++; return timers; }, clearTimeout: () => {} },
 launch: async () => {
  launches++;
  if (mode === "result-write" || mode === "launch-error-write") failWrites = true;
  if (mode === "launch-error-write") throw new Error("launch rejected");
  return { content: [], details: { asyncId: "launched-run" } };
 }
});
let failWrites = false;
const rename = fs.renameSync;
try {
 const result = await manager.handleToolCall({ action: "schedule", agent: "worker", task: "test", schedule: "+1s" }, ctx);
 assert.notEqual(result.isError, true);
 const storePath = scheduledRunStorePath(root, path.join(root, "session.jsonl"), root);
 const original = fs.readFileSync(storePath, "utf8");
 fs.renameSync = (from, to) => {
  if (failWrites && to === storePath) throw Object.assign(new Error("injected scheduled store write failure"), { code: "EIO" });
  return rename(from, to);
 };
 syncBuiltinESMExports();
 if (mode === "read") fs.writeFileSync(storePath, "{bad json");
 if (mode === "running-write" || mode === "missed-write") failWrites = true;
 now += mode === "missed-write" ? 86400000 : 1000;
 callback();
 await new Promise(resolve => setTimeout(resolve, 25));
 assert.equal(launches, mode === "result-write" || mode === "launch-error-write" || mode === "healthy" ? 1 : 0);
 assert.equal(timers, 1, "uncertain failures must not automatically relaunch work");
 if (mode !== "read") {
  const state = JSON.parse(fs.readFileSync(storePath, "utf8")).jobs[0].state;
  assert.equal(state, mode === "healthy" ? "fired" : launches ? "running" : "scheduled");
 }
 // Explicit rebind can recover a pre-launch failure after storage is repaired.
 if (["read", "running-write"].includes(mode)) {
  failWrites = false;
  if (mode === "read") fs.writeFileSync(storePath, original);
  manager.bindSession(ctx);
  callback();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(launches, 1);
  assert.equal(JSON.parse(fs.readFileSync(storePath, "utf8")).jobs[0].state, "fired");
 }
 console.log("SCENARIO_OK");
} finally {
 manager.stop(); fs.renameSync = rename; syncBuiltinESMExports();
 fs.rmSync(root, { recursive: true, force: true });
}
`], { encoding: "utf8", timeout: 20000 });
}

describe("scheduled timer error containment", () => {
	for (const mode of ["read", "running-write", "missed-write", "result-write", "launch-error-write", "healthy"]) {
		it(`keeps the host alive for ${mode}`, () => {
			const result = runScenario(mode);
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /SCENARIO_OK/);
			if (mode === "healthy") assert.doesNotMatch(result.stderr, /Scheduled subagent run test-job/);
			else assert.match(result.stderr, /Scheduled subagent run test-job failed.*not retried automatically/s);
		});
	}
});
