import * as fs from "node:fs";

export interface DrainableSource {
	pause(): void;
	resume(): void;
}

export interface JsonlWriteStream {
	write(chunk: string): boolean;
	once(event: "drain", listener: () => void): JsonlWriteStream;
	on(event: "error", listener: (error: Error) => void): JsonlWriteStream;
	end(callback?: () => void): void;
}

const DEFAULT_MAX_JSONL_BYTES = 50 * 1024 * 1024;

interface JsonlWriterDeps {
	createWriteStream?: (filePath: string) => JsonlWriteStream;
	maxBytes?: number;
}

interface JsonlWriter {
	writeLine(line: string): void;
	close(): Promise<void>;
}

export function createJsonlWriter(
	filePath: string | undefined,
	source: DrainableSource,
	deps: JsonlWriterDeps = {},
): JsonlWriter {
	if (!filePath) {
		return {
			writeLine() {},
			async close() {},
		};
	}

	const createWriteStream = deps.createWriteStream ?? ((targetPath: string) => fs.createWriteStream(targetPath, { flags: "a" }));
	let stream: JsonlWriteStream | undefined;
	try {
		stream = createWriteStream(filePath);
	} catch {
		return {
			writeLine() {},
			async close() {},
		};
	}

	let backpressured = false;
	let closed = false;
	let failed = false;
	let closePromise: Promise<void> | undefined;
	let resolveClose: (() => void) | undefined;
	const releaseBackpressure = () => {
		if (!backpressured) return;
		backpressured = false;
		source.resume();
	};
	const fail = () => {
		failed = true;
		releaseBackpressure();
		resolveClose?.();
	};
	// Artifact output is best effort; an asynchronous filesystem failure must
	// not crash the runner or strand the child stdout waiting for drain.
	stream.on("error", fail);
	let bytesWritten = 0;
	const maxBytes = deps.maxBytes ?? DEFAULT_MAX_JSONL_BYTES;

	return {
		writeLine(line: string) {
			if (!stream || closed || failed || !line.trim()) return;
			const chunk = `${line}\n`;
			const chunkBytes = Buffer.byteLength(chunk, "utf-8");
			if (bytesWritten + chunkBytes > maxBytes) return;
			try {
				const ok = stream.write(chunk);
				if (failed) return;
				bytesWritten += chunkBytes;
				if (!ok && !backpressured) {
					backpressured = true;
					source.pause();
					stream.once("drain", () => {
						releaseBackpressure();
					});
				}
			} catch {
				fail();
			}
		},
		close() {
			if (closePromise) return closePromise;
			closed = true;
			releaseBackpressure();
			if (!stream || failed) return Promise.resolve();
			const current = stream;
			closePromise = new Promise<void>((resolve) => {
				resolveClose = resolve;
				try {
					current.end(resolve);
				} catch {
					fail();
				}
			});
			return closePromise;
		},
	};
}
