import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	AGENT_MEMORY_FILE,
	buildAgentMemoryInjection,
	readMemoryFile,
} from "../../src/agents/agent-memory.ts";

const MAX_BYTES = 16 * 1024;
const tempDirs: string[] = [];

function memoryDir(contents: string | Buffer): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weasley-memory-utf8-"));
	tempDirs.push(dir);
	fs.writeFileSync(path.join(dir, AGENT_MEMORY_FILE), contents);
	return dir;
}

function read(contents: string | Buffer) {
	const result = readMemoryFile(memoryDir(contents));
	assert.ok(result && result !== "unsafe");
	assert.ok(Buffer.byteLength(result.contents, "utf8") <= MAX_BYTES);
	return result;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent memory UTF-8 preview", () => {
	for (const character of ["é", "한", "🙂"]) {
		const width = Buffer.byteLength(character, "utf8");
		for (let retainedBytes = 1; retainedBytes < width; retainedBytes++) {
			it(`omits a split ${width}-byte character with ${retainedBytes} bytes inside the cap`, () => {
				const prefix = "a".repeat(MAX_BYTES - retainedBytes);
				assert.deepEqual(read(prefix + character + "tail"), { contents: prefix, byteCapped: true });
			});
		}

		it(`preserves a complete ${width}-byte character at the exact end of the file`, () => {
			const contents = "a".repeat(MAX_BYTES - width) + character;
			assert.deepEqual(read(contents), { contents, byteCapped: false });
		});

		it(`preserves a complete ${width}-byte character when only later content is capped`, () => {
			const contents = "a".repeat(MAX_BYTES - width) + character;
			assert.deepEqual(read(contents + "tail"), { contents, byteCapped: true });
		});
	}

	for (const [name, bytes] of [
		["overlong", [0xf0, 0x80, 0x80, 0x80]],
		["out-of-range", [0xf4, 0x90, 0x80, 0x80]],
	] as const) {
		it(`preserves replacement decoding for an already-invalid ${name} sequence at the cap`, () => {
			const prefix = "a".repeat(MAX_BYTES - 3);
			const contents = Buffer.concat([Buffer.from(prefix), Buffer.from(bytes)]);
			assert.deepEqual(read(contents), { contents: prefix + "�", byteCapped: true });
		});
	}

	it("preserves a literal byte-order mark in a capped preview", () => {
		const contents = "\ufeff" + "a".repeat(MAX_BYTES - 3);
		assert.deepEqual(read(contents + "tail"), { contents, byteCapped: true });
	});

	it("retains a multilingual prefix across internal filesystem read boundaries", () => {
		const contents = "a".repeat(8191) + "한🙂é\n오늘의 기억";
		assert.deepEqual(read(contents), { contents, byteCapped: false });
	});

	it("keeps repeated Korean memory within the byte cap without adding a replacement character", () => {
		assert.deepEqual(read("한".repeat(MAX_BYTES)), {
			contents: "한".repeat(Math.floor(MAX_BYTES / 3)),
			byteCapped: true,
		});
	});

	it("preserves replacement decoding for malformed source bytes at the real end of a small file", () => {
		assert.deepEqual(read(Buffer.from([0x61, 0xe2, 0x82])), { contents: "a�", byteCapped: false });
	});

	it("keeps replacement decoding for malformed bytes inside a capped prefix", () => {
		const prefix = "a".repeat(MAX_BYTES - 4);
		const contents = Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from("b".repeat(20))]);
		assert.deepEqual(read(contents), { contents: prefix + "�b", byteCapped: true });
	});

	it("does not split a character when replacement decoding requires a second byte cap", () => {
		const contents = Buffer.concat([Buffer.from([0xff]), Buffer.from("a".repeat(MAX_BYTES - 4) + "한tail")]);
		assert.deepEqual(read(contents), { contents: "�" + "a".repeat(MAX_BYTES - 4), byteCapped: true });
	});

	it("still limits memory to 200 lines independently of the byte cap", () => {
		assert.deepEqual(read(Array.from({ length: 201 }, () => "한🙂é").join("\n")), {
			contents: Array.from({ length: 200 }, () => "한🙂é").join("\n"),
			byteCapped: false,
		});
	});

	for (const tools of [["read"], ["read", "edit"]]) {
		it(`injects an uncorrupted byte-capped preview for ${tools.join("/")} agents`, () => {
			const project = memoryDir("");
			const dir = path.join(project, ".pi", "agent-memory", "reviewer");
			fs.mkdirSync(dir, { recursive: true });
			const prefix = "a".repeat(MAX_BYTES - 1);
			fs.writeFileSync(path.join(dir, AGENT_MEMORY_FILE), prefix + "한");
			const injection = buildAgentMemoryInjection({
				name: "reviewer",
				description: "Review changes",
				systemPrompt: "Review changes",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				source: "project",
				filePath: path.join(project, ".pi", "agents", "reviewer.md"),
				tools,
				memory: { scope: "project", path: "reviewer" },
			}, project);
			assert.ok(injection.endsWith(`\n---\n${prefix}\n---`));
			assert.match(injection, /first 200 lines, byte-capped/);
			assert.doesNotMatch(injection, /�/);
		});
	}
});
