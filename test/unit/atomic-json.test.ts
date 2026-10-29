import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createAtomicJsonWriter, writeAtomicJsonIfAbsent } from "../../src/shared/atomic-json.ts";

class FakeFs {
	files = new Map<string, string>();
	madeDirs: string[] = [];
	renameCalls = 0;
	failMkdirCodes: string[] = [];
	failRenameCodes: string[] = [];
	writeOptions = new Map<string, unknown>();

	mkdirSync(dirPath: string): void {
		this.madeDirs.push(dirPath);
		const failureCode = this.failMkdirCodes.shift();
		if (failureCode) {
			const error = new Error(`mkdir failed with ${failureCode}`) as NodeJS.ErrnoException;
			error.code = failureCode;
			throw error;
		}
	}

	writeFileSync(filePath: string, contents: string, options?: unknown): void {
		this.files.set(filePath, contents);
		this.writeOptions.set(filePath, options);
	}

	renameSync(sourcePath: string, targetPath: string): void {
		this.renameCalls++;
		const failureCode = this.failRenameCodes.shift();
		if (failureCode) {
			const error = new Error(`rename failed with ${failureCode}`) as NodeJS.ErrnoException;
			error.code = failureCode;
			throw error;
		}
		const contents = this.files.get(sourcePath);
		if (contents === undefined) throw new Error(`missing source file: ${sourcePath}`);
		this.files.delete(sourcePath);
		this.files.set(targetPath, contents);
	}

	rmSync(filePath: string): void {
		this.files.delete(filePath);
	}
}

function createWriter(fakeFs: FakeFs, waits: number[]) {
	return createAtomicJsonWriter({
		fs: fakeFs as any,
		now: () => 12345,
		pid: 678,
		random: () => 0.5,
		retryRenameErrors: true,
		retryDelaysMs: [1, 2, 3],
		wait: (delayMs) => waits.push(delayMs),
	});
}

describe("writeAtomicJson", () => {
	it("publishes complete JSON once without replacing an existing result", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-json-publish-"));
		try {
			const target = path.join(root, "result.json");
			assert.equal(writeAtomicJsonIfAbsent(target, { success: true }), true);
			assert.equal(writeAtomicJsonIfAbsent(target, { success: false }), false);
			assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf-8")), { success: true });
			assert.deepEqual(fs.readdirSync(root), ["result.json"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not replace a result that wins at the atomic publication boundary", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-json-race-"));
		const target = path.join(root, "result.json");
		try {
			const writer = createAtomicJsonWriter({
				replaceExisting: false,
				fs: {
					...fs,
					linkSync(source, destination) {
						fs.writeFileSync(target, JSON.stringify({ summary: "real result" }));
						fs.linkSync(source, destination);
					},
				},
			});
			assert.equal(writer(target, { summary: "synthetic failure" }), false);
			assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf-8")), { summary: "real result" });
			assert.deepEqual(fs.readdirSync(root), ["result.json"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails without publishing partial JSON when exclusive publication is unsupported", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-json-unsupported-"));
		try {
			const writer = createAtomicJsonWriter({
				replaceExisting: false,
				fs: { ...fs, linkSync() { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); } },
			});
			assert.throws(() => writer(path.join(root, "result.json"), { success: false }), /unsupported/);
			assert.deepEqual(fs.readdirSync(root), []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("retries transient rename failures before replacing the target", () => {
		const fakeFs = new FakeFs();
		fakeFs.failRenameCodes = ["EPERM", "EBUSY"];
		const waits: number[] = [];
		const writeAtomicJson = createWriter(fakeFs, waits);
		const targetPath = path.join("/tmp", "status.json");

		writeAtomicJson(targetPath, { state: "running" });

		assert.equal(fakeFs.renameCalls, 3);
		assert.deepEqual(waits, [1, 2]);
		assert.deepEqual(fakeFs.madeDirs, [path.dirname(targetPath)]);
		assert.equal(fakeFs.files.get(targetPath), JSON.stringify({ state: "running" }, null, 2));
		assert.equal(fakeFs.files.size, 1);
	});

	it("retries transient directory creation failures before writing", () => {
		const fakeFs = new FakeFs();
		fakeFs.failMkdirCodes = ["EPERM", "EACCES"];
		const waits: number[] = [];
		const writeAtomicJson = createWriter(fakeFs, waits);
		const targetPath = path.join("/tmp", "status.json");

		writeAtomicJson(targetPath, { state: "running" });

		assert.equal(fakeFs.renameCalls, 1);
		assert.deepEqual(waits, [1, 2]);
		assert.deepEqual(fakeFs.madeDirs, [path.dirname(targetPath), path.dirname(targetPath), path.dirname(targetPath)]);
		assert.equal(fakeFs.files.get(targetPath), JSON.stringify({ state: "running" }, null, 2));
	});

	it("writes the temporary descriptor with the requested private mode", () => {
		const fakeFs = new FakeFs();
		const writeAtomicJson = createAtomicJsonWriter({
			fs: fakeFs as any,
			now: () => 12345,
			pid: 678,
			random: () => 0.5,
			mode: 0o600,
		});
		const targetPath = path.join("/tmp", "recovery-descriptor.json");

		writeAtomicJson(targetPath, { sourceRunId: "run" });

		assert.deepEqual([...fakeFs.writeOptions.values()], [{ encoding: "utf-8", mode: 0o600 }]);
	});

	it("uses longer default retries for transient Windows rename locks", () => {
		const fakeFs = new FakeFs();
		fakeFs.failRenameCodes = ["EPERM", "EPERM", "EPERM", "EPERM", "EPERM", "EPERM"];
		const waits: number[] = [];
		const writeAtomicJson = createAtomicJsonWriter({
			fs: fakeFs as any,
			now: () => 12345,
			pid: 678,
			random: () => 0.5,
			retryRenameErrors: true,
			wait: (delayMs) => waits.push(delayMs),
		});

		writeAtomicJson(path.join("/tmp", "status.json"), { state: "running" });

		assert.equal(fakeFs.renameCalls, 7);
		assert.deepEqual(waits, [10, 25, 50, 100, 200, 500]);
	});

	it("throws non-retryable rename failures without retrying", () => {
		const fakeFs = new FakeFs();
		fakeFs.failRenameCodes = ["ENOENT"];
		const waits: number[] = [];
		const writeAtomicJson = createWriter(fakeFs, waits);

		assert.throws(() => writeAtomicJson(path.join("/tmp", "status.json"), { state: "running" }), /ENOENT/);
		assert.equal(fakeFs.renameCalls, 1);
		assert.deepEqual(waits, []);
		assert.equal(fakeFs.files.size, 0);
	});

	it("cleans up the temp file after retryable failures are exhausted", () => {
		const fakeFs = new FakeFs();
		fakeFs.failRenameCodes = ["EPERM", "EPERM", "EPERM", "EPERM"];
		const waits: number[] = [];
		const writeAtomicJson = createWriter(fakeFs, waits);
		const targetPath = path.join("/tmp", "status.json");

		assert.throws(() => writeAtomicJson(targetPath, { state: "running" }), /EPERM/);
		assert.equal(fakeFs.renameCalls, 4);
		assert.deepEqual(waits, [1, 2, 3]);
		assert.equal(fakeFs.files.has(targetPath), false);
		assert.equal(fakeFs.files.size, 0);
	});
});
