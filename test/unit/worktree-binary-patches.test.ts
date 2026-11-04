import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { writeParallelHandoffGroup } from "../../src/runs/shared/parallel-handoff.ts";
import { cleanupWorktrees, createWorktrees, diffWorktrees, type WorktreeSetup } from "../../src/runs/shared/worktree.ts";

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

const original = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
const changed = Buffer.from(original);
changed.fill(0x7f, 512, 768);

function fixture(run: (root: string, repo: string, setSetup: (setup: WorktreeSetup) => void) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "weasley-binary-patch-"));
	const repo = path.join(root, "repo");
	let setup: WorktreeSetup | undefined;
	try {
		fs.mkdirSync(repo);
		git(repo, "init");
		git(repo, "config", "user.name", "Worktree Tests");
		git(repo, "config", "user.email", "tests@example.com");
		git(repo, "config", "core.autocrlf", "false");
		git(repo, "config", "core.abbrev", "4");
		fs.writeFileSync(path.join(repo, "asset.bin"), original);
		fs.writeFileSync(path.join(repo, "notes.txt"), "original\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-m", "fixture base");
		run(root, repo, (value) => { setup = value; });
	} finally {
		if (setup) cleanupWorktrees(setup);
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("binary worktree patch recovery", () => {
	for (const operation of ["add", "modify", "delete", "commit", "rename"] as const) {
		it(`recovers a binary ${operation} from its patch after worktree cleanup`, () => {
			fixture((root, repo, setSetup) => {
				const setup = createWorktrees(repo, operation, 1, { baseDir: path.join(root, "worktrees") });
				setSetup(setup);
				const worktree = setup.worktrees[0]!;
				const destination = "new asset 한글.bin";
				if (operation === "add") fs.writeFileSync(path.join(worktree.path, destination), changed);
				else if (operation === "delete") fs.unlinkSync(path.join(worktree.path, "asset.bin"));
				else if (operation === "rename") fs.renameSync(path.join(worktree.path, "asset.bin"), path.join(worktree.path, destination));
				else fs.writeFileSync(path.join(worktree.path, "asset.bin"), changed);
				if (operation === "commit") {
					git(worktree.path, "add", "-A");
					git(worktree.path, "commit", "-m", "worker binary change");
				}

				const [diff] = diffWorktrees(setup, ["asset-worker"], path.join(root, "patches"));
				assert.ok(diff);
				assert.equal(diff.error, undefined);
				assert.equal(diff.filesChanged, 1);
				assert.equal(diff.insertions, 0);
				assert.equal(diff.deletions, 0);
				assert.equal(cleanupWorktrees(setup).state, "complete");
				assert.equal(fs.existsSync(worktree.path), false);
				assert.deepEqual(fs.readFileSync(path.join(repo, "asset.bin")), original);

				// The worktree is gone. Only the retained patch may recover its changes.
				git(repo, "apply", "--check", diff.patchPath);
				git(repo, "apply", diff.patchPath);
				if (operation === "delete" || operation === "rename") assert.equal(fs.existsSync(path.join(repo, "asset.bin")), false);
				else assert.deepEqual(fs.readFileSync(path.join(repo, "asset.bin")), operation === "add" ? original : changed);
				if (operation === "add" || operation === "rename") assert.deepEqual(fs.readFileSync(path.join(repo, destination)), operation === "add" ? changed : original);
				assert.equal(fs.readFileSync(path.join(repo, "notes.txt"), "utf-8"), "original\n");
			});
		});
	}

	for (const helper of ["textconv", "external diff"] as const) {
		it(`recovers binary content without using a display-only ${helper} helper`, () => {
			fixture((root, repo, setSetup) => {
				if (helper === "textconv") {
					fs.writeFileSync(path.join(repo, ".gitattributes"), "*.bin diff=fixture\n");
					git(repo, "add", ".gitattributes");
					git(repo, "commit", "-m", "fixture diff attributes");
					git(repo, "config", "diff.fixture.textconv", "git hash-object");
				} else {
					git(repo, "config", "diff.external", "git --version");
				}
				const setup = createWorktrees(repo, "helper", 1, { baseDir: path.join(root, "worktrees") });
				setSetup(setup);
				fs.writeFileSync(path.join(setup.worktrees[0]!.path, "asset.bin"), changed);
				const [diff] = diffWorktrees(setup, ["worker"], path.join(root, "patches"));
				assert.ok(diff);
				assert.equal(diff.error, undefined);
				assert.equal(diff.filesChanged, 1);
				assert.equal(cleanupWorktrees(setup).state, "complete");
				git(repo, "apply", "--check", diff.patchPath);
				git(repo, "apply", diff.patchPath);
				assert.deepEqual(fs.readFileSync(path.join(repo, "asset.bin")), changed);
			});
		});
	}

	it("recovers a binary patch larger than the subprocess stdout buffer", () => {
		fixture((root, repo, setSetup) => {
			const setup = createWorktrees(repo, "large", 1, { baseDir: path.join(root, "worktrees") });
			setSetup(setup);
			const payload = Buffer.alloc(1024 * 1024);
			let seed = 123456789;
			for (let index = 0; index < payload.length; index++) {
				seed ^= seed << 13;
				seed ^= seed >>> 17;
				seed ^= seed << 5;
				payload[index] = seed & 0xff;
			}
			fs.writeFileSync(path.join(setup.worktrees[0]!.path, "asset.bin"), payload);
			const [diff] = diffWorktrees(setup, ["worker"], path.join(root, "patches"));
			assert.ok(diff);
			assert.equal(diff.error, undefined);
			assert.equal(diff.filesChanged, 1);
			assert.ok(fs.statSync(diff.patchPath).size > 1024 * 1024);
			assert.equal(cleanupWorktrees(setup).state, "complete");
			git(repo, "apply", "--check", diff.patchPath);
			git(repo, "apply", diff.patchPath);
			assert.deepEqual(fs.readFileSync(path.join(repo, "asset.bin")), payload);
		});
	});

	it("keeps mixed text/binary sibling patches independently recoverable through the handoff manifest", () => {
		fixture((root, repo, setSetup) => {
			const setup = createWorktrees(repo, "siblings", 2, { baseDir: path.join(root, "worktrees") });
			setSetup(setup);
			for (const worktree of setup.worktrees) {
				fs.writeFileSync(path.join(worktree.path, "asset.bin"), worktree.index === 0 ? changed : Buffer.from([0, 1, 0xff, 0x80]));
				fs.writeFileSync(path.join(worktree.path, "notes.txt"), `worker ${worktree.index}\n`);
			}
			const diffs = diffWorktrees(setup, ["first", "second"], path.join(root, "patches"));
			assert.equal(diffs.length, 2);
			assert.ok(diffs.every((diff) => !diff.error && diff.filesChanged === 2 && diff.insertions === 1 && diff.deletions === 1));
			const cleanup = cleanupWorktrees(setup);
			assert.equal(cleanup.state, "complete");
			const reference = writeParallelHandoffGroup({
				manifestPath: path.join(root, "handoff.json"), runId: "siblings", mode: "parallel", source: "foreground",
				cwd: repo, stepIndex: 0, flatStartIndex: 0, setup, diffs, cleanup,
				results: ["first", "second"].map((agent) => ({ agent, status: "completed", summary: "Updated assets" })),
			});
			assert.equal(reference.changedPatches, 2);
			assert.equal(reference.cleanupState, "complete");
			const manifest = JSON.parse(fs.readFileSync(reference.path, "utf-8"));
			for (const [index, child] of manifest.groups[0].children.entries()) {
				const restored = path.join(root, `restored-${index}`);
				git(root, "clone", "--config", "core.autocrlf=false", "--no-local", repo, restored);
				git(restored, "apply", "--check", child.patch.path);
				git(restored, "apply", child.patch.path);
				assert.deepEqual(fs.readFileSync(path.join(restored, "asset.bin")), index === 0 ? changed : Buffer.from([0, 1, 0xff, 0x80]));
				assert.equal(fs.readFileSync(path.join(restored, "notes.txt"), "utf-8"), `worker ${index}\n`);
			}
		});
	});

	it("keeps an unchanged binary worktree patch empty", () => {
		fixture((root, repo, setSetup) => {
			const setup = createWorktrees(repo, "unchanged", 1, { baseDir: path.join(root, "worktrees") });
			setSetup(setup);
			const [diff] = diffWorktrees(setup, ["worker"], path.join(root, "patches"));
			assert.ok(diff);
			assert.equal(diff.error, undefined);
			assert.equal(diff.filesChanged, 0);
			assert.equal(fs.readFileSync(diff.patchPath, "utf-8"), "");
		});
	});
});
