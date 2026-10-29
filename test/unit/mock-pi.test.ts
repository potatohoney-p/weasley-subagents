import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockPi } from "../support/mock-pi.ts";

const scriptUrl = new URL("../support/mock-pi-script.mjs", import.meta.url).href;

function startMockChild(queueDir: string, gated = false, synchronizeClaims = false) {
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		${synchronizeClaims ? `
			const fs = (await import("node:fs")).default;
			const path = (await import("node:path")).default;
			const dir = process.env.MOCK_PI_QUEUE_DIR;
			const readFileSync = fs.readFileSync;
			// Unmatched entries are read once in the matcher scan, then again to claim.
			let firstEntryReads = 0;
			fs.readFileSync = function(file, ...args) {
				const result = readFileSync.call(this, file, ...args);
				if (path.basename(String(file)) === "pending-000001.json" && ++firstEntryReads === 2) {
					process.send("ready");
					const deadline = Date.now() + 10_000;
					while (!fs.existsSync(path.join(dir, "release-claims"))) {
						if (Date.now() >= deadline) throw new Error("Claim barrier timed out");
						Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
					}
					process.disconnect();
				}
				return result;
			};
			const renameSync = fs.renameSync;
			fs.renameSync = function(source, target) {
				if (path.basename(String(source)).startsWith("pending-")) {
					fs.appendFileSync(path.join(dir, "renames-" + process.pid), path.basename(String(source)) + "\\n");
				}
				return renameSync.call(this, source, target);
			};
		` : ""}
		${gated ? 'process.send("ready"); await new Promise(resolve => process.once("message", resolve)); process.disconnect();' : ""}
		await import(${JSON.stringify(scriptUrl)});
	`], {
		env: { ...process.env, MOCK_PI_QUEUE_DIR: queueDir },
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		timeout: 5_000,
	});
	let stdout = "";
	let stderr = "";
	assert.ok(child.stdout);
	assert.ok(child.stderr);
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const completed = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});
	return { child, completed };
}

it("isolates delayed pre-reset children from the next test's responses and call records", async () => {
	const mockPi = createMockPi();
	const children: ReturnType<typeof startMockChild>[] = [];
	mockPi.install();
	try {
		mockPi.onCall({ output: "previous test response" });
		const previousQueue = mockPi.dir;
		const delayed = startMockChild(previousQueue, true);
		children.push(delayed);
		await once(delayed.child, "message", { signal: AbortSignal.timeout(5_000) });

		mockPi.reset();
		mockPi.onCall({ output: "primary failed", exitCode: 1 });
		mockPi.onCall({ output: "Recovered asynchronously" });
		delayed.child.send("continue");
		const previousResult = await delayed.completed;

		const primary = startMockChild(mockPi.dir);
		children.push(primary);
		const primaryResult = await primary.completed;
		assert.equal(primaryResult.stdout.trim(), "primary failed");
		assert.equal(primaryResult.code, 1);
		assert.equal(previousResult.stdout.trim(), "previous test response");
		assert.equal(mockPi.callCount(), 1, "late calls belong only to their original generation");
		assert.notEqual(mockPi.dir, previousQueue);
		assert.equal(process.env.MOCK_PI_QUEUE_DIR, mockPi.dir);
		assert.equal(fs.readdirSync(previousQueue).filter(name => name.startsWith("call-")).length, 1);

		const fallback = startMockChild(mockPi.dir);
		children.push(fallback);
		assert.equal((await fallback.completed).stdout.trim(), "Recovered asynchronously");
		assert.equal(mockPi.callCount(), 2);
	} finally {
		for (const { child } of children) if (child.exitCode === null) child.kill();
		await Promise.allSettled(children.map(({ completed }) => completed));
		mockPi.uninstall();
	}
});

it("keeps parallel claims unique within the current reset generation", async () => {
	const mockPi = createMockPi();
	const children: ReturnType<typeof startMockChild>[] = [];
	mockPi.install();
	try {
		mockPi.onCall({ output: "discarded generation" });
		mockPi.reset();
		const responses = ["first", "second", "third", "fourth"];
		for (const output of responses) mockPi.onCall({ output });
		children.push(...responses.map(() => startMockChild(mockPi.dir, false, true)));
		// Every child has read the same first entry before any can claim it.
		await Promise.all(children.map(({ child }) => once(child, "message", { signal: AbortSignal.timeout(5_000) })));
		fs.writeFileSync(path.join(mockPi.dir, "release-claims"), "");
		const results = await Promise.all(children.map(({ completed }) => completed));
		assert.deepEqual(results.map(({ stdout }) => stdout.trim()).sort(), [...responses].sort());
		assert.ok(results.every(({ code, stderr }) => code === 0 && stderr === ""));
		assert.equal(mockPi.callCount(), responses.length);
		const renameAttempts = fs.readdirSync(mockPi.dir)
			.filter(name => name.startsWith("renames-"))
			.flatMap(name => fs.readFileSync(path.join(mockPi.dir, name), "utf-8").trim().split("\n"));
		assert.deepEqual(renameAttempts.sort(), responses.map((_, index) => `pending-${String(index + 1).padStart(6, "0")}.json`),
			"only the exclusive owner may rename each response, even with stale pending-file reads");
		assert.equal(fs.readdirSync(mockPi.dir).filter(name => name.startsWith("pending-")).length, 0);
	} finally {
		for (const { child } of children) if (child.exitCode === null) child.kill();
		await Promise.allSettled(children.map(({ completed }) => completed));
		mockPi.uninstall();
	}
});

it("resets an uninstalled mock without replacing the active environment", () => {
	const activeMock = createMockPi();
	const inactiveMock = createMockPi();
	activeMock.install();
	try {
		const previousQueue = inactiveMock.dir;
		inactiveMock.reset();
		assert.notEqual(inactiveMock.dir, previousQueue);
		assert.equal(process.env.MOCK_PI_QUEUE_DIR, activeMock.dir);
		inactiveMock.install();
		assert.equal(process.env.MOCK_PI_QUEUE_DIR, inactiveMock.dir);
		inactiveMock.onCall({ output: "new generation" });
		assert.equal(fs.existsSync(path.join(inactiveMock.dir, "pending-000001.json")), true);
		inactiveMock.reset();
		assert.equal(inactiveMock.callCount(), 0);
		assert.deepEqual(fs.readdirSync(inactiveMock.dir), []);
	} finally {
		inactiveMock.uninstall();
		activeMock.uninstall();
	}
});
