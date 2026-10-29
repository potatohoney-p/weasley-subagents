import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { it, type TestContext } from "node:test";
import { acceptanceCleanupWarning, acceptanceFailureMessage, buildSkippedAcceptanceLedger, evaluateAcceptance, resolveEffectiveAcceptance } from "../../src/runs/shared/acceptance.ts";

async function waitFor(check: () => boolean, message: string, timeout = 5_000, pause: (ms: number) => Promise<unknown> = delay) {
	const deadline = Date.now() + timeout;
	while (!check() && Date.now() < deadline) await pause(10);
	assert.ok(check(), message);
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

interface FixtureScope {
	fixtures: { cwd: string; ready: string; proceed: string }[];
	roots: { closed: boolean }[];
	pending: Promise<unknown>[];
	observe?: (args: Parameters<typeof childProcess.spawn>, real: typeof childProcess.spawn) => ChildProcess;
}

const scopes = new WeakMap<TestContext, FixtureScope>();
const scopesByCwd = new Map<string, FixtureScope>();

function fixtureScope(t: TestContext): FixtureScope {
	const existing = scopes.get(t);
	if (existing) return existing;
	const scope: FixtureScope = { fixtures: [], roots: [], pending: [] };
	scopes.set(t, scope);
	const real = childProcess.spawn;
	const mock = t.mock.method(childProcess, "spawn", (...args: Parameters<typeof real>) => {
		const root = scope.observe ? scope.observe(args, real) : real(...args);
		if (!isTerminationHelper(args[0])) {
			const state = { closed: false };
			scope.roots.push(state);
			root.once("close", () => { state.closed = true; });
		}
		return root;
	});
	syncBuiltinESMExports();
	t.after(async () => {
		try {
			// Release every fixture before waiting, including concurrent verifications.
			let releaseError: unknown;
			for (const child of scope.fixtures) {
				try { fs.writeFileSync(child.proceed, "fixture cleanup"); }
				catch (error) { releaseError ??= error; }
			}
			// Keep simulated cleanup installed while any verification can still time out.
			await Promise.allSettled(scope.pending);
			await waitFor(() => scope.roots.every(root => root.closed), "owned shells and their pipes close before directory cleanup", 9_000);
			if (releaseError) throw releaseError;
			for (const child of scope.fixtures) {
				if (fs.existsSync(child.ready)) {
					const { pid } = JSON.parse(fs.readFileSync(child.ready, "utf8"));
					await waitFor(() => !alive(pid), "fixture descendant exits", 9_000);
				}
				fs.rmSync(child.cwd, { recursive: true, force: true });
			}
		} finally {
			// Automatic mock restoration does not update already-synchronized ESM exports.
			// Restore those even when filesystem teardown throws.
			mock.mock.restore();
			syncBuiltinESMExports();
			for (const child of scope.fixtures) scopesByCwd.delete(child.cwd);
		}
	});
	return scope;
}

function fixture(t: TestContext, mode: "normal" | "root-exit" | "resist" | "drain" = "normal") {
	const scope = fixtureScope(t);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-cleanup-"));
	const script = path.join(cwd, "child.cjs");
	const ready = path.join(cwd, "ready.json");
	const proceed = path.join(cwd, "proceed");
	const lateWrite = path.join(cwd, "late-write");
	fs.writeFileSync(script, `
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
if (process.argv[2] === "root-exit" || process.argv[2] === "drain") {
  const drain = process.argv[2] === "drain";
  require("node:child_process").spawn(process.execPath, [__filename, drain ? "drain-child" : "normal"], { detached: drain, stdio: ["ignore", 1, 2] });
  const ready = setInterval(() => {
    if (fs.existsSync(path.join(dir, "ready.json"))) process.exit(drain ? 17 : 0);
  }, 5);
  setTimeout(() => process.exit(99), 5000).unref();
} else {
if (process.argv[2] === "resist") process.on("SIGTERM", () => fs.writeFileSync(path.join(dir, "term"), "received"));
// Drain expiry deliberately closes these pipes before the release challenge.
if (process.argv[2] === "drain-child") {
  process.stdout.on("error", error => { if (error.code !== "EPIPE") throw error; });
  process.stderr.on("error", error => { if (error.code !== "EPIPE") throw error; });
}
process.stdout.write("verification stdout\\n");
process.stderr.write("verification stderr\\n");
const timer = setInterval(() => {
  if (fs.existsSync(path.join(dir, "proceed"))) {
    if (process.argv[2] === "drain-child") {
      process.stdout.write("final stdout\\n");
      process.stderr.write("final stderr\\n");
    }
    fs.writeFileSync(path.join(dir, "late-write"), "descendant was still alive");
    clearInterval(timer);
  }
}, 10);
setTimeout(() => {
  fs.writeFileSync(path.join(dir, "fallback"), "emergency self-release");
  clearInterval(timer);
}, 15000).unref();
fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify({ pid: process.pid }));
}
`);
	scope.fixtures.push({ cwd, ready, proceed });
	scopesByCwd.set(cwd, scope);
	return { cwd, script, ready, proceed, lateWrite, command: `${mode === "drain" ? "exec " : ""}"${process.execPath}" "${script}" ${mode}` };
}

function verify(command: string, cwd: string, signal?: AbortSignal, timeoutMs = 10_000, allowFailure = false, nextCommand?: string) {
	const acceptance = resolveEffectiveAcceptance({
		agentName: "worker", task: "Verify", agentContract: { version: 1 },
		explicit: { level: "verified", verify: [{ id: "command", command, timeoutMs, allowFailure }, ...(nextCommand ? [{ id: "next", command: nextCommand }] : [])] },
	});
	const pending = evaluateAcceptance({ acceptance, cwd, output: "", signal, reportOptional: true });
	scopesByCwd.get(cwd)?.pending.push(pending);
	return pending;
}

function observeSpawns(t: TestContext, observe: (args: Parameters<typeof childProcess.spawn>, real: typeof childProcess.spawn) => ChildProcess) {
	fixtureScope(t).observe = observe;
}

function isTerminationHelper(command: unknown) {
	return typeof command === "string" && /[\\/]taskkill\.exe$/i.test(command);
}

for (const mode of ["cancel", "timeout"] as const) {
	it(`terminates the verification descendant before ${mode} cleanup settles`, async (t) => {
		const child = fixture(t);
		const controller = new AbortController();
		const pending = verify(child.command, child.cwd, controller.signal, mode === "timeout" ? 6_000 : 10_000, true, child.command);
		await waitFor(() => fs.existsSync(child.ready), "descendant is ready before cancellation/timeout", 5_000);
		const { pid } = JSON.parse(fs.readFileSync(child.ready, "utf8"));
		if (mode === "cancel") controller.abort();
		const ledger = await pending;
		t.diagnostic(JSON.stringify(ledger.verifyRuns[0]?.termination));
		fs.writeFileSync(child.proceed, "evaluation already settled");
		assert.equal(ledger.status, "rejected");
		assert.equal(ledger.verifyRuns.length, 1, "no later command after cancellation or timeout, even with allowFailure");
		assert.equal(ledger.verifyRuns[0]?.status, "timed-out");
		assert.equal(ledger.verifyRuns[0]?.stdout, "verification stdout");
		assert.match(ledger.verifyRuns[0]?.stderr ?? "", /verification stderr/);
		assert.equal(alive(pid), false, "owned descendant has exited, not just its shell");
		assert.equal(fs.existsSync(child.lateWrite), false, "no mutation after settlement");
		assert.equal(fs.existsSync(path.join(child.cwd, "fallback")), false, "cleanup precedes emergency fixture self-release");
	});
}

it("preserves stdout, stderr, exit codes and allowFailure on ordinary completion", async (t) => {
	const child = fixture(t);
	const script = path.join(child.cwd, "ordinary.cjs");
	fs.writeFileSync(script, 'process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exitCode = Number(process.argv[2]);');
	let helperCalls = 0;
	observeSpawns(t, (args, real) => {
		if (isTerminationHelper(args[0])) { helperCalls++; throw new Error("unexpected termination after completion"); }
		return real(...args);
	});
	for (const code of [0, 7]) for (const allowFailure of [false, true]) {
		const controller = new AbortController();
		const ledger = await verify(`"${process.execPath}" "${script}" ${code}`, child.cwd, controller.signal, 10_000, allowFailure);
		assert.deepEqual([ledger.verifyRuns[0]?.stdout, ledger.verifyRuns[0]?.stderr, ledger.verifyRuns[0]?.exitCode], ["out", "err", code]);
		assert.equal(ledger.verifyRuns[0]?.status, code === 0 ? "passed" : allowFailure ? "allowed-failure" : "failed");
		assert.equal(ledger.verifyRuns[0]?.termination, undefined);
		controller.abort();
	}
	assert.equal(helperCalls, 0);
});

it("reports unconfirmed cleanup when cancellation races Windows root exit without reusing its PID", { skip: process.platform !== "win32" }, async (t) => {
	const child = fixture(t, "root-exit");
	const controller = new AbortController();
	let rootExited = false;
	let helperCalls = 0;
	observeSpawns(t, (args, real) => {
		if (isTerminationHelper(args[0])) { helperCalls++; throw new Error("must not target an exited root PID"); }
		const root = real(...args);
		root.once("exit", () => { rootExited = true; controller.abort(); });
		return root;
	});
	const pending = verify(child.command, child.cwd, controller.signal);
	await waitFor(() => rootExited && fs.existsSync(child.ready), "root exits while descendant is still running");
	const ledger = await pending;
	assert.equal(helperCalls, 0);
	assert.equal(ledger.verifyRuns[0]?.exitCode, 0);
	assert.equal(ledger.verifyRuns[0]?.termination?.outcome, "unconfirmed");
	assert.match(acceptanceFailureMessage(ledger) ?? "", /already exited/);
});

for (const failure of ["denial", "deadline"] as const) {
	it(`retains output and reports simulated Windows cleanup ${failure}`, { skip: process.platform !== "win32" }, async (t) => {
		const child = fixture(t);
		let helperCalls = 0;
		let deadlineKills = 0;
		let root: ChildProcess | undefined;
		let capturedStdout = "";
		let capturedStderr = "";
		observeSpawns(t, (args, real) => {
			if (!isTerminationHelper(args[0])) {
				root = real(...args);
				root.stdout?.on("data", chunk => { capturedStdout += chunk.toString(); });
				root.stderr?.on("data", chunk => { capturedStderr += chunk.toString(); });
				return root;
			}
			helperCalls++;
			// No taskkill is executed: exercise reporting and bounded local handles.
			const helper = new ChildProcess();
			helper.stderr = new PassThrough();
			if (failure === "denial") queueMicrotask(() => {
				helper.stderr?.emit("data", "simulated access denied");
				helper.emit("close", 1, null);
			});
			else t.mock.method(helper, "kill", () => {
				deadlineKills++;
				queueMicrotask(() => helper.emit("close", null, "SIGKILL"));
				return true;
			});
			return helper;
		});
		const controller = new AbortController();
		const pending = verify(child.command, child.cwd, controller.signal, 10_000, true, child.command);
		assert.ok(root);
		// Hold actual pipe delivery to prove the file-based readiness marker can
		// arrive first. Cleanup uncertainty preserves only output already captured.
		root.stdout?.pause();
		root.stderr?.pause();
		await waitFor(() => fs.existsSync(child.ready), "descendant ready");
		assert.equal(capturedStdout, "", "child readiness does not imply stdout delivery");
		assert.equal(capturedStderr, "", "child readiness does not imply stderr delivery");
		root.stdout?.resume();
		root.stderr?.resume();
		await waitFor(() => capturedStdout === "verification stdout\n" && capturedStderr === "verification stderr\n",
			"both output prefixes reach the parent before simulated cleanup failure");
		controller.abort();
		controller.abort();
		const ledger = await pending;
		assert.equal(helperCalls, 1);
		assert.equal(deadlineKills, failure === "deadline" ? 1 : 0);
		assert.equal(ledger.status, "rejected");
		assert.equal(ledger.verifyRuns.length, 1, "no later command after cancellation");
		assert.equal(ledger.verifyRuns[0]?.stdout, "verification stdout");
		assert.equal(ledger.verifyRuns[0]?.stderr, "verification stderr");
		assert.equal(ledger.verifyRuns[0]?.termination?.outcome, "unconfirmed");
		assert.match(acceptanceCleanupWarning(ledger) ?? "", failure === "denial" ? /simulated access denied/ : /deadline/);
		const stopped = buildSkippedAcceptanceLedger(ledger.effectiveAcceptance, { id: "stopped", message: "Stopped", verifyRuns: ledger.verifyRuns });
		assert.deepEqual(stopped.verifyRuns, ledger.verifyRuns);
		assert.match(acceptanceFailureMessage(stopped) ?? "", /cleanup unconfirmed/);
	});
}

it("escalates an owned POSIX group containing a SIGTERM-resistant descendant", { skip: process.platform === "win32" }, async (t) => {
	const child = fixture(t, "resist");
	const controller = new AbortController();
	const pending = verify(child.command, child.cwd, controller.signal);
	await waitFor(() => fs.existsSync(child.ready), "resistant descendant ready");
	const { pid } = JSON.parse(fs.readFileSync(child.ready, "utf8"));
	controller.abort();
	const ledger = await pending;
	assert.ok(fs.existsSync(path.join(child.cwd, "term")), "graceful signal reached descendant");
	assert.equal(alive(pid), false);
	assert.equal(ledger.status, "rejected");
	assert.equal(ledger.verifyRuns[0]?.termination?.method, "posix-process-group");
});

it("cleans up a POSIX group after its shell exits with inherited pipes still open", { skip: process.platform === "win32" }, async (t) => {
	const child = fixture(t, "root-exit");
	const controller = new AbortController();
	let rootExited = false;
	observeSpawns(t, (args, real) => {
		const root = real(...args);
		root.once("exit", () => { rootExited = true; controller.abort(); });
		return root;
	});
	const pending = verify(child.command, child.cwd, controller.signal);
	await waitFor(() => rootExited && fs.existsSync(child.ready), "root exits after descendant readiness");
	const { pid } = JSON.parse(fs.readFileSync(child.ready, "utf8"));
	const ledger = await pending;
	assert.equal(ledger.status, "rejected");
	assert.equal(ledger.verifyRuns[0]?.exitCode, 0);
	assert.equal(ledger.verifyRuns[0]?.stdout, "verification stdout");
	assert.equal(ledger.verifyRuns[0]?.stderr, "verification stderr");
	assert.equal(ledger.verifyRuns[0]?.termination?.method, "posix-process-group");
	assert.equal(alive(pid), false, "group ownership survives shell exit");
});

it("keeps another verification and an unrelated sentinel alive during cleanup", async (t) => {
	const target = fixture(t);
	const other = fixture(t);
	const sentinel = fixture(t);
	const sentinelProcess = childProcess.spawn(process.execPath, [sentinel.script], { stdio: "ignore", windowsHide: true });
	const controller = new AbortController();
	const targetPending = verify(target.command, target.cwd, controller.signal);
	const otherPending = verify(other.command, other.cwd);
	await waitFor(() => [target, other, sentinel].every(child => fs.existsSync(child.ready)), "all isolated processes ready");
	controller.abort();
	const ledger = await targetPending;
	t.diagnostic(JSON.stringify(ledger.verifyRuns[0]?.termination));
	assert.equal(ledger.status, "rejected");
	const { pid: targetPid } = JSON.parse(fs.readFileSync(target.ready, "utf8"));
	assert.equal(alive(targetPid), false, "the canceled verification ended before the isolation challenge");
	fs.writeFileSync(other.proceed, "unrelated verification challenge");
	fs.writeFileSync(sentinel.proceed, "unrelated sentinel challenge");
	assert.equal((await otherPending).status, "verified");
	await waitFor(() => fs.existsSync(sentinel.lateWrite), "sentinel answers challenge after target cleanup");
	assert.ok(fs.existsSync(other.lateWrite));
	assert.equal(sentinelProcess.killed, false);
});

for (const completion of ["before deadline", "at expiry"] as const) {
	it(`retains final output-drain evidence ${completion}`, { skip: process.platform === "win32", timeout: 12_000 }, async (t) => {
		// The child escapes the owned group but retains both output pipes. It exits
		// on a release gate or its eight-second self-release, without any test kill.
		const child = fixture(t, "drain");
		const controller = new AbortController();
		let rootExited = false;
		let rootClosed = false;
		let capturedStdout = "";
		let capturedStderr = "";
		observeSpawns(t, (args, real) => {
			const root = real(...args);
			root.once("exit", () => { rootExited = true; });
			root.once("close", () => { rootClosed = true; });
			root.stdout?.on("data", chunk => { capturedStdout += chunk.toString(); });
			root.stderr?.on("data", chunk => { capturedStderr += chunk.toString(); });
			return root;
		});
		let settled = false;
		const realSetTimeout = globalThis.setTimeout;
		const realClearTimeout = globalThis.clearTimeout;
		const realPause = (ms: number) => new Promise<void>(resolve => { realSetTimeout(resolve, ms); });
		const nextTurn = () => new Promise<void>(resolve => { setImmediate(resolve); });
		let watchdog: NodeJS.Timeout | undefined;
		// Enable before verification creates its timeout, so all production timeout
		// handles use the same clock. Readiness and teardown use preserved real timers.
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const pending = verify(child.command, child.cwd, controller.signal).then(ledger => {
			settled = true;
			return ledger;
		});
		try {
			await waitFor(() => rootExited && fs.existsSync(child.ready)
				&& capturedStdout === "verification stdout\n" && capturedStderr === "verification stderr\n",
				"root exits after descendant readiness and both output prefixes arrive", 5_000, realPause);
			const { pid } = JSON.parse(fs.readFileSync(child.ready, "utf8"));
			assert.equal(rootClosed, false, "escaped descendant still holds both pipes");
			assert.equal(alive(pid), true);
			assert.equal(settled, false);

			// Only virtual time controls the drain deadline; actual subprocess IO remains
			// event-driven. Keep an independent real-time watchdog for a broken drain.
			const bounded = Promise.race([pending, new Promise<never>((_, reject) => {
				watchdog = realSetTimeout(() => reject(new Error("output drain did not settle")), 5_000);
			})]);
			controller.abort();
			// cleanupVerificationProcess resolves after ESRCH for the exited group.
			await nextTurn();
			assert.equal(settled, false, "group exit starts a drain instead of settling early");
			t.mock.timers.tick(249);
			// A full turn drains every link of evaluateAcceptance's promise chain.
			await nextTurn();
			assert.equal(settled, false, "draining remains pending before the deadline");
			if (completion === "before deadline") fs.writeFileSync(child.proceed, "finish both output streams");
			else t.mock.timers.tick(1);
			const ledger = await bounded;
			const result = ledger.verifyRuns[0];
			assert.equal(ledger.status, "rejected");
			assert.equal(ledger.verifyRuns.length, 1);
			assert.equal(result?.status, "timed-out");
			assert.equal(result?.exitCode, 17, "retain the actual root exit code");
			assert.equal(result?.termination?.method, "posix-process-group");
			assert.equal(fs.existsSync(path.join(child.cwd, "fallback")), false, "emergency self-release cannot satisfy the test");
			if (completion === "before deadline") {
				assert.equal(rootClosed, true, "actual EOF completes the drain before virtual expiry");
				assert.equal(result?.stdout, "verification stdout\nfinal stdout");
				assert.equal(result?.stderr, "verification stderr\nfinal stderr");
				assert.equal(result?.termination?.outcome, "group-exited");
				assert.equal(acceptanceCleanupWarning(ledger), undefined);
			} else {
				assert.equal(alive(pid), true, "the gated survivor must not be reported terminated");
				assert.equal(fs.existsSync(child.proceed), false);
				assert.equal(result?.stdout, "verification stdout");
				assert.equal(result?.stderr, "verification stderr");
				assert.equal(result?.termination?.outcome, "unconfirmed");
				assert.match(result?.termination?.detail ?? "", /output pipes did not close before the drain deadline/);
				assert.match(acceptanceCleanupWarning(ledger) ?? "", /escaped descendants may remain/);
			}
			const snapshot = JSON.stringify(ledger);
			fs.writeFileSync(child.proceed, "release after checking settled evidence");
			await waitFor(() => !alive(pid), "escaped fixture exits after its release challenge", 5_000, realPause);
			assert.equal(fs.existsSync(child.lateWrite), true, "fixture answered its release gate");
			assert.equal(fs.existsSync(path.join(child.cwd, "fallback")), false);
			t.mock.timers.tick(1);
			await nextTurn();
			assert.equal(JSON.stringify(ledger), snapshot, "later clock ticks cannot replace settled evidence");
		} finally {
			try {
				// Failed assertions must also release the actual child and advance any
				// pending cleanup before restoring the clock for FixtureScope teardown.
				fs.writeFileSync(child.proceed, "fixture cleanup");
				controller.abort();
				await waitFor(() => {
					t.mock.timers.tick(250);
					return settled;
				}, "verification settles before timer restoration", 5_000, realPause);
			} finally {
				t.mock.timers.reset();
				if (watchdog) realClearTimeout(watchdog);
			}
		}
	});
}
