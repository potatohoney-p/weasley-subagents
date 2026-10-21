import assert from "node:assert/strict";
import childProcess from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { it, type TestContext } from "node:test";
import { evaluateAcceptance, resolveEffectiveAcceptance } from "../../src/runs/shared/acceptance.ts";

// Each fragment starts with text the decoder can emit. The next fragment is
// released only after the parent consumes this one, so pipe coalescing cannot
// hide a split UTF-8 character. No model process or network service is involved.
const fixture = `
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  for (let index = 0; index < config.stdout.length; index++) {
    for (const stream of ["stdout", "stderr"]) {
      process[stream].write(Buffer.from(config[stream][index], "hex"));
    }
    const deadline = Date.now() + 5000;
    for (const stream of ["stdout", "stderr"]) {
      const ack = path.join(path.dirname(process.argv[2]), stream + ".ack");
      while (!fs.existsSync(ack) || fs.readFileSync(ack, "utf8") !== String(index + 1)) {
        if (Date.now() > deadline) throw new Error("fragment acknowledgement timed out: " + stream);
        await delay(5);
      }
    }
  }
  process.exitCode = config.exitCode;
}
main().catch(error => { console.error(error); process.exitCode = 99; });
`;

async function verifyFragments(t: TestContext, stdout: Buffer[], stderr: Buffer[], exitCode = 0) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-output-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const fixturePath = path.join(cwd, "writer.cjs");
	const configPath = path.join(cwd, "fragments.json");
	fs.writeFileSync(fixturePath, fixture);
	fs.writeFileSync(configPath, JSON.stringify({
		stdout: stdout.map(chunk => chunk.toString("hex")),
		stderr: stderr.map(chunk => chunk.toString("hex")),
		exitCode,
	}));

	const spawn = childProcess.spawn;
	const consumed = { stdout: 0, stderr: 0 };
	const observer = t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
		const child = spawn(...args);
		for (const stream of ["stdout", "stderr"] as const) {
			assert.ok(child[stream]);
			child[stream].on("data", () => {
				fs.writeFileSync(path.join(cwd, `${stream}.ack`), String(++consumed[stream]));
			});
		}
		return child;
	});
	syncBuiltinESMExports();
	t.after(() => {
		observer.mock.restore();
		syncBuiltinESMExports();
	});

	const acceptance = resolveEffectiveAcceptance({
		agentName: "worker",
		task: "Verify command output",
		agentContract: { version: 1 },
		explicit: {
			level: "verified",
			verify: [{
				id: "fragmented-output",
				command: `"${process.execPath}" "${fixturePath}" "${configPath}"`,
				timeoutMs: 15_000,
			}],
		},
	});
	const ledger = await evaluateAcceptance({ acceptance, output: "", cwd, reportOptional: true });
	assert.equal(observer.mock.callCount(), 1);
	// A decoder may emit one additional chunk when it flushes an incomplete
	// sequence at EOF, after the last fragment has already been acknowledged.
	assert.ok(consumed.stdout >= stdout.length);
	assert.ok(consumed.stderr >= stderr.length);
	assert.equal(ledger.verifyRuns[0]?.exitCode, exitCode);
	return ledger;
}

it("preserves split UTF-8 characters in verification stdout and stderr", async (t) => {
	const fragments = (prefix: string) => [
		Buffer.concat([Buffer.from(`${prefix}: `), Buffer.from("é").subarray(0, 1)]),
		Buffer.concat([Buffer.from("é").subarray(1), Buffer.from(" / "), Buffer.from("한").subarray(0, 2)]),
		Buffer.concat([Buffer.from("한").subarray(2), Buffer.from(" / "), Buffer.from("🪄").subarray(0, 3)]),
		Buffer.concat([Buffer.from("🪄").subarray(3), Buffer.from(" done\n")]),
	];
	const ledger = await verifyFragments(t, fragments("stdout"), fragments("stderr"));
	assert.equal(ledger.status, "verified");
	assert.deepEqual(
		[ledger.verifyRuns[0]?.stdout, ledger.verifyRuns[0]?.stderr],
		["stdout: é / 한 / 🪄 done", "stderr: é / 한 / 🪄 done"],
	);
});

it("flushes an incomplete final UTF-8 sequence and preserves a failed command's output", async (t) => {
	const ledger = await verifyFragments(t,
		[Buffer.concat([Buffer.from("out "), Buffer.from("🪄").subarray(0, 3)])],
		[Buffer.concat([Buffer.from("err "), Buffer.from("한").subarray(0, 2)])],
		7,
	);
	assert.equal(ledger.status, "rejected");
	assert.equal(ledger.verifyRuns[0]?.status, "failed");
	assert.equal(ledger.verifyRuns[0]?.stdout, "out �");
	assert.equal(ledger.verifyRuns[0]?.stderr, "err �");
});
