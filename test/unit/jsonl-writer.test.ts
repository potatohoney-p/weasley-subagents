import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createJsonlWriter, type DrainableSource, type JsonlWriteStream } from "../../src/shared/jsonl-writer.ts";

class MockSource implements DrainableSource {
	paused = 0;
	resumed = 0;
	pause(): void {
		this.paused++;
	}
	resume(): void {
		this.resumed++;
	}
}

class MockStream implements JsonlWriteStream {
	writes: string[] = [];
	ended = false;
	private drainHandler?: () => void;
	private errorHandler?: (error: Error) => void;
	private readonly writeResults: boolean[];
	constructor(writeResults: boolean[] = []) {
		this.writeResults = writeResults;
	}
	write(chunk: string): boolean {
		this.writes.push(chunk);
		if (this.writeResults.length === 0) return true;
		return this.writeResults.shift() ?? true;
	}
	once(event: "drain", listener: () => void): JsonlWriteStream {
		if (event === "drain") this.drainHandler = listener;
		return this;
	}
	on(event: "error", listener: (error: Error) => void): JsonlWriteStream {
		this.errorHandler = listener;
		return this;
	}
	emitError(): void { this.errorHandler?.(new Error("sink failed")); }
	end(callback?: () => void): void {
		this.ended = true;
		callback?.();
	}
	emitDrain(): void {
		this.drainHandler?.();
	}
}

describe("createJsonlWriter", () => {
	it("writes lines with trailing newline", () => {
		const source = new MockSource();
		const stream = new MockStream();
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
		});
		writer.writeLine('{"type":"a"}');
		writer.writeLine('{"type":"b"}');
		assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
	});

	it("pauses on backpressure and resumes on drain", () => {
		const source = new MockSource();
		const stream = new MockStream([false, true]);
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
		});
		writer.writeLine('{"type":"a"}');
		assert.equal(source.paused, 1);
		assert.equal(source.resumed, 0);
		stream.emitDrain();
		assert.equal(source.resumed, 1);
		writer.writeLine('{"type":"b"}');
		assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
	});

	it("closes stream once", async () => {
		const source = new MockSource();
		const stream = new MockStream();
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
		});
		await writer.close();
		assert.equal(stream.ended, true);
		await writer.close();
		assert.equal(stream.ended, true);
	});

	it("returns no-op writer when file path is undefined", async () => {
		const source = new MockSource();
		const writer = createJsonlWriter(undefined, source);
		writer.writeLine('{"type":"a"}');
		await writer.close();
		assert.equal(source.paused, 0);
		assert.equal(source.resumed, 0);
	});

	it("stops writing when maxBytes exceeded without pausing source", () => {
		const source = new MockSource();
		const stream = new MockStream();
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
			maxBytes: 30,
		});
		writer.writeLine('{"type":"a"}');
		writer.writeLine('{"type":"b"}');
		writer.writeLine('{"type":"c"}');
		assert.equal(stream.writes.length, 2);
		assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
		assert.equal(source.paused, 0);
	});

	it("allows writes up to exactly maxBytes", () => {
		const source = new MockSource();
		const stream = new MockStream();
		const line = '{"x":"a"}';
		const lineBytes = Buffer.byteLength(`${line}\n`, "utf-8");
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
			maxBytes: lineBytes * 2,
		});
		writer.writeLine(line);
		writer.writeLine(line);
		writer.writeLine(line);
		assert.equal(stream.writes.length, 2);
	});
});


describe("optional JSONL sink failures", () => {
	it("survives asynchronous open failure and settles close", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jsonl-error-"));
		try {
			const source = new MockSource();
			const writer = createJsonlWriter(join(dir, "missing", "events.jsonl"), source);
			writer.writeLine("{}");
			await writer.close();
			writer.writeLine("ignored");
			await writer.close();
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("releases failed sink backpressure once and ignores late drain and writes", async () => {
		const source = new MockSource();
		const stream = new MockStream([false]);
		const writer = createJsonlWriter("unused", source, { createWriteStream: () => stream });
		writer.writeLine("first");
		assert.equal(source.paused, 1);
		stream.emitError();
		stream.emitError();
		stream.emitDrain();
		writer.writeLine("ignored");
		await writer.close();
		assert.equal(source.resumed, 1);
		assert.deepEqual(stream.writes, ["first\n"]);
	});

	it("settles all concurrent close callers when flush fails", async () => {
		const source = new MockSource();
		const stream = new MockStream();
		let endCalls = 0;
		stream.end = () => { endCalls++; };
		const writer = createJsonlWriter("unused", source, { createWriteStream: () => stream });
		const first = writer.close();
		const second = writer.close();
		assert.equal(first, second);
		stream.emitError();
		await Promise.all([first, second]);
		assert.equal(endCalls, 1);
	});

	it("does not pause after a synchronous stream error during write", async () => {
		const source = new MockSource();
		const stream = new MockStream();
		stream.write = () => { stream.emitError(); return false; };
		const writer = createJsonlWriter("unused", source, { createWriteStream: () => stream });
		writer.writeLine("first");
		await writer.close();
		assert.equal(source.paused, 0);
		assert.equal(source.resumed, 0);
	});

	it("releases backpressure on early close without resuming twice on late drain", async () => {
		const source = new MockSource();
		const stream = new MockStream([false]);
		const writer = createJsonlWriter("unused", source, { createWriteStream: () => stream });
		writer.writeLine("first");
		await writer.close();
		stream.emitDrain();
		assert.equal(source.resumed, 1);
		assert.equal(stream.ended, true);
	});

	it("retains successful append and complete flush semantics", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jsonl-success-"));
		try {
			const path = join(dir, "events.jsonl");
			for (const line of ["한 🪄", "second"]) {
				const writer = createJsonlWriter(path, new MockSource());
				writer.writeLine(line);
				await writer.close();
			}
			assert.equal(readFileSync(path, "utf8"), "한 🪄\nsecond\n");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});
