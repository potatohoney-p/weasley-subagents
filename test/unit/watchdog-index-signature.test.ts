import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { computeWatchdogRepoChangeSignature } from "../../src/watchdog/change-signature.ts";
import { MainWatchdogRuntime } from "../../src/watchdog/runtime.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/watchdog/settings.ts";

function git(cwd: string, args: string[], input?: string): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", input });
	assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout;
}

function createRepo(t: TestContext, name = "code.txt"): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-index-"));
	t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
	git(repo, ["init"]);
	git(repo, ["config", "user.name", "Watchdog Tests"]);
	git(repo, ["config", "user.email", "watchdog@example.com"]);
	git(repo, ["config", "core.autocrlf", "false"]);
	fs.writeFileSync(path.join(repo, name), "base\n");
	git(repo, ["add", "--", name]);
	git(repo, ["commit", "-m", "initial"]);
	return repo;
}

function stageThenRestore(repo: string, name: string, staged: string, working = "unchanged working file\n"): void {
	fs.writeFileSync(path.join(repo, name), staged);
	git(repo, ["add", "--", name]);
	fs.writeFileSync(path.join(repo, name), working);
}

function signature(repo: string) {
	const value = computeWatchdogRepoChangeSignature(repo);
	assert.ok(value, "expected a complete repository signature");
	return value;
}

function status(repo: string): string {
	return git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
}

describe("watchdog staged change identity", () => {
	for (const name of ["code.txt", "source file 한글.txt"]) {
		it(`detects replaced staged content with unchanged status and worktree: ${name}`, (t) => {
			const repo = createRepo(t, name);
			stageThenRestore(repo, name, "first staged version\n");
			const first = signature(repo);
			const beforeStatus = status(repo);
			stageThenRestore(repo, name, "second staged version\n");
			assert.equal(status(repo), beforeStatus);
			const second = signature(repo);
			assert.deepEqual(second.changedPaths, [name]);
			assert.notEqual(second.key, first.key);
			assert.equal(signature(repo).key, second.key, "repeated reads are stable");
			stageThenRestore(repo, name, "first staged version\n");
			assert.equal(signature(repo).key, first.key, "restoring the index restores the identity");
		});
	}

	it("detects staged additions before the first commit", (t) => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-unborn-"));
		t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
		git(repo, ["init"]);
		stageThenRestore(repo, "new.txt", "first\n");
		const first = signature(repo);
		const beforeStatus = status(repo);
		stageThenRestore(repo, "new.txt", "second\n");
		assert.equal(status(repo), beforeStatus);
		assert.notEqual(signature(repo).key, first.key);
	});

	it("detects staged content changes when the working file is absent", (t) => {
		const repo = createRepo(t);
		stageThenRestore(repo, "code.txt", "first\n");
		fs.unlinkSync(path.join(repo, "code.txt"));
		const first = signature(repo);
		const beforeStatus = status(repo);
		stageThenRestore(repo, "code.txt", "second\n");
		fs.unlinkSync(path.join(repo, "code.txt"));
		assert.equal(status(repo), beforeStatus);
		assert.notEqual(signature(repo).key, first.key);
	});

	it("detects index-only executable mode changes", (t) => {
		const repo = createRepo(t);
		git(repo, ["config", "core.filemode", "false"]);
		stageThenRestore(repo, "code.txt", "staged\n");
		const first = signature(repo);
		const beforeStatus = status(repo);
		const blob = git(repo, ["rev-parse", ":code.txt"]).trim();
		git(repo, ["update-index", "--cacheinfo", `100755,${blob},code.txt`]);
		assert.equal(status(repo), beforeStatus);
		assert.notEqual(signature(repo).key, first.key);
		git(repo, ["update-index", "--cacheinfo", `100644,${blob},code.txt`]);
		assert.equal(signature(repo).key, first.key);
	});

	it("retains both rename paths and detects changed staged rename content", (t) => {
		const repo = createRepo(t);
		const original = Array.from({ length: 50 }, (_, index) => `line ${index}\n`).join("");
		fs.writeFileSync(path.join(repo, "code.txt"), original);
		git(repo, ["commit", "-am", "prepare rename"]);
		git(repo, ["mv", "--", "code.txt", "renamed file.txt"]);
		fs.writeFileSync(path.join(repo, "renamed file.txt"), "fixed working copy\n");
		const first = signature(repo);
		const beforeStatus = status(repo);
		assert.match(beforeStatus, /^RM /);
		stageThenRestore(repo, "renamed file.txt", `${original}additional staged line\n`, "fixed working copy\n");
		assert.equal(status(repo), beforeStatus);
		const second = signature(repo);
		assert.deepEqual(second.changedPaths, ["code.txt", "renamed file.txt"]);
		assert.notEqual(second.key, first.key);
	});

	it("detects each unmerged index stage without changing the conflict worktree", (t) => {
		const repo = createRepo(t);
		const hashes = ["base", "ours", "theirs", "replacement"].map((text) => git(repo, ["hash-object", "-w", "--stdin"], text).trim());
		const setStages = (values: string[]) => git(repo, ["update-index", "--index-info"], [
			`0 ${"0".repeat(hashes[0]!.length)}\tcode.txt`,
			...values.map((hash, index) => `100644 ${hash} ${index + 1}\tcode.txt`),
			"",
		].join("\n"));
		setStages(hashes.slice(0, 3));
		const first = signature(repo);
		const beforeStatus = status(repo);
		assert.match(beforeStatus, /^UU /);
		for (let stage = 0; stage < 3; stage++) {
			const values = hashes.slice(0, 3);
			values[stage] = hashes[3]!;
			setStages(values);
			assert.equal(status(repo), beforeStatus);
			assert.deepEqual(signature(repo).changedPaths, ["code.txt"]);
			assert.notEqual(signature(repo).key, first.key, `stage ${stage + 1} must affect identity`);
		}
	});

	it("preserves tabs and newlines in NUL-delimited paths", { skip: process.platform === "win32" }, (t) => {
		const name = "two\tlines\ncode.txt";
		const repo = createRepo(t, name);
		stageThenRestore(repo, name, "first\n");
		const first = signature(repo);
		stageThenRestore(repo, name, "second\n");
		assert.deepEqual(signature(repo).changedPaths, [name]);
		assert.notEqual(signature(repo).key, first.key);
	});

	it("ignores staged changes under excluded paths without hiding ordinary edits", (t) => {
		const repo = createRepo(t);
		const names = ["tmp/cache.txt", ".weasley-subagents/state.txt", "node_modules/pkg.txt", "nested/node_modules/pkg.txt"];
		for (const name of names) {
			fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
			stageThenRestore(repo, name, "first\n");
		}
		const first = signature(repo);
		assert.deepEqual(first.changedPaths, []);
		for (const name of names) stageThenRestore(repo, name, "second\n");
		assert.equal(signature(repo).key, first.key);
		fs.writeFileSync(path.join(repo, "code.txt"), "ordinary edit\n");
		assert.deepEqual(signature(repo).changedPaths, ["code.txt"]);
		assert.notEqual(signature(repo).key, first.key);
	});

	it("keeps untracked and deleted paths visible", (t) => {
		const repo = createRepo(t);
		fs.unlinkSync(path.join(repo, "code.txt"));
		fs.writeFileSync(path.join(repo, "untracked file.txt"), "one\n");
		const first = signature(repo);
		assert.deepEqual(first.changedPaths, ["code.txt", "untracked file.txt"]);
		fs.writeFileSync(path.join(repo, "untracked file.txt"), "two\n");
		assert.notEqual(signature(repo).key, first.key);
	});

	it("runs an edit-gated review for staged-only changes and skips an unchanged later turn", async (t) => {
		const repo = createRepo(t);
		stageThenRestore(repo, "code.txt", "first\n");
		const reviewed: string[] = [];
		const runtime = new MainWatchdogRuntime({
			cwd: repo,
			reviewChangesOnly: true,
			resolveConfig: () => ({ ok: true, errors: [], sources: [], config: {
				...DEFAULT_WATCHDOG_CONFIG,
				enabled: true,
				main: { ...DEFAULT_WATCHDOG_CONFIG.main, enabled: true },
				lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp, enabled: false },
			} }),
			review: (request) => { reviewed.push(request.delta); return { stopReason: "stop" }; },
		});
		t.after(() => runtime.dispose());
		for (const staged of ["second\n", "third\n", "third\n"]) {
			runtime.handleBeforeAgentStart({ prompt: "Update staged work." }, { cwd: repo });
			stageThenRestore(repo, "code.txt", staged);
			runtime.enqueueDelta("Assistant:\nUpdated the index.");
			await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });
		}
		assert.equal(reviewed.length, 2);
		assert.ok(reviewed.every((delta) => /Changed repo paths:\n- code\.txt/.test(delta)));
		assert.equal(runtime.getSnapshot().status, "idle");
	});
});
