import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockPi } from "../support/mock-pi.ts";

const scriptUrl = new URL("../support/mock-pi-script.mjs", import.meta.url).href;

function startMockChild(queueDir: string, gated = false) {
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
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
		children.push(...responses.map(() => startMockChild(mockPi.dir)));
		const results = await Promise.all(children.map(({ completed }) => completed));
		assert.deepEqual(results.map(({ stdout }) => stdout.trim()).sort(), [...responses].sort());
		assert.ok(results.every(({ code, stderr }) => code === 0 && stderr === ""));
		assert.equal(mockPi.callCount(), responses.length);
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
