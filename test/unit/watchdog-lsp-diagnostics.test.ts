import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, mock } from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import {
	WatchdogLspDiagnosticsLedger,
	collectWatchdogLspDiagnostics,
	formatWatchdogLspDiagnosticsBlock,
	watchdogWarningFromLspDiagnostics,
} from "../../src/watchdog/lsp-diagnostics.ts";
import type { WatchdogLspResult } from "../../src/watchdog/types.ts";

function result(diagnostics: WatchdogLspResult["diagnostics"]): WatchdogLspResult {
	return {
		status: "ok",
		provider: "stub-lsp",
		checkedPaths: ["src/file.ts"],
		skippedPaths: [],
		diagnostics,
	};
}

describe("watchdog LSP diagnostics", () => {
	it("formats diagnostics for watchdog review input", () => {
		const block = formatWatchdogLspDiagnosticsBlock(result([{
			path: "src/file.ts",
			line: 2,
			column: 3,
			severity: "error",
			source: "typescript",
			code: "TS2322",
			message: "Type mismatch.",
		}]));

		assert.match(block, /^LSP diagnostics:/);
		assert.match(block, /src\/file\.ts:2:3 error TS2322 typescript: Type mismatch\./);
	});

	it("omits info and hints from watchdog review input", () => {
		const block = formatWatchdogLspDiagnosticsBlock(result([{
			path: "src/file.ts",
			line: 2,
			column: 3,
			severity: "info",
			source: "typescript",
			message: "Helpful note.",
		}, {
			path: "src/file.ts",
			line: 3,
			column: 4,
			severity: "hint",
			source: "typescript",
			message: "Suggestion.",
		}]));

		assert.equal(block, "");
	});

	it("maps errors to blockers and warnings to concerns", () => {
		const blocker = watchdogWarningFromLspDiagnostics(result([{
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "error",
			source: "typescript",
			message: "Cannot find name 'x'.",
		}]));
		assert.equal(blocker?.severity, "blocker");
		assert.equal(blocker?.source, "lsp");

		const concern = watchdogWarningFromLspDiagnostics(result([{
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "warning",
			source: "typescript",
			message: "Unused value.",
		}]));
		assert.equal(concern?.severity, "concern");

		const info = watchdogWarningFromLspDiagnostics(result([{
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "info",
			source: "typescript",
			message: "Helpful note.",
		}]));
		assert.equal(info, undefined);
	});

	for (const failingMethod of ["initialize", "initialized"]) {
		it(`contains an input transport error during ${failingMethod}`, async () => {
			const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-lsp-transport-"));
			const sent: string[] = [];
			const stdout = new PassThrough();
			const child = new EventEmitter() as EventEmitter & { kill(): boolean; stdin: Writable; stdout: PassThrough; stderr: PassThrough };
			Object.assign(child, {
				stdout, stderr: new PassThrough(),
				kill: () => { queueMicrotask(() => child.emit("exit", 1, null)); return true; },
				stdin: new Writable({ write(chunk, _encoding, callback) {
					const request = JSON.parse(String(chunk).split("\r\n\r\n")[1]);
					sent.push(request.method);
					if (request.method === failingMethod) {
						callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
						return;
					}
					callback();
					if (request.method === "initialize") {
						const body = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { capabilities: {} } });
						queueMicrotask(() => stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
					}
				} }),
			});
			const spawn = mock.method(childProcess, "spawn", () => child as never);
			syncBuiltinESMExports();
			try {
				const binDir = path.join(temp, "node_modules", ".bin");
				fs.mkdirSync(path.join(temp, "src"), { recursive: true });
				fs.mkdirSync(binDir, { recursive: true });
				fs.writeFileSync(path.join(temp, "src", "file.ts"), "export const x = 1;");
				fs.writeFileSync(path.join(binDir, "typescript-language-server"), "stub", { mode: 0o755 });
				const diagnostics = await collectWatchdogLspDiagnostics({
					cwd: temp, root: temp, changedPaths: ["src/file.ts"],
					config: { enabled: true, timeoutMs: 5000, maxFiles: 10, maxDiagnostics: 10 },
				});
				assert.equal(diagnostics.status, "failed");
				assert.match(diagnostics.message ?? "", /EPIPE/);
				assert.equal(sent.includes("shutdown"), false, "must not write shutdown into a failed transport");
			} finally {
				spawn.mock.restore();
				syncBuiltinESMExports();
				fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
	}

	it("returns a failed result when the server closes its input pipe after initialization", { skip: process.platform === "win32" ? "The cmd wrapper retains the input pipe handle; use the injected transport-error tests on Windows." : false }, async () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-lsp-pipe-"));
		try {
			const binDir = path.join(temp, "node_modules", ".bin");
			fs.mkdirSync(path.join(temp, "src"), { recursive: true });
			fs.mkdirSync(binDir, { recursive: true });
			fs.writeFileSync(path.join(temp, "src", "file.ts"), "//" + "x".repeat(1024 * 1024));
			const scriptPath = path.join(binDir, "tls-closed-input.js");
			fs.writeFileSync(scriptPath, `
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
  const boundary = input.indexOf('\\r\\n\\r\\n');
  if (boundary < 0) return;
  const length = Number(/Content-Length: (\\d+)/i.exec(input)[1]);
  if (Buffer.byteLength(input.slice(boundary + 4)) < length) return;
  const request = JSON.parse(input.slice(boundary + 4));
  process.stdin.removeAllListeners('data');
  process.stdin.destroy();
  try { require('node:fs').closeSync(0); } catch {}
  const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: {} } });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
});
setTimeout(() => process.exit(0), 10000);
`, "utf-8");
			if (process.platform === "win32") {
				fs.writeFileSync(path.join(binDir, "typescript-language-server.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0\\tls-closed-input.js" %*\r\n`, "utf-8");
			} else {
				fs.writeFileSync(path.join(binDir, "typescript-language-server"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/tls-closed-input.js" "$@"\n`, { encoding: "utf-8", mode: 0o755 });
			}
			const diagnostics = await collectWatchdogLspDiagnostics({
				cwd: temp, root: temp, changedPaths: ["src/file.ts"],
				config: { enabled: true, timeoutMs: 5000, maxFiles: 10, maxDiagnostics: 10 },
			});
			assert.equal(diagnostics.status, "failed");
			assert.match(diagnostics.message ?? "", /EPIPE|pipe|closed|write/i);
		} finally {
			fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});

	it("returns a failed result for malformed language-server JSON", async () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-lsp-"));
		try {
			const binDir = path.join(temp, "node_modules", ".bin");
			fs.mkdirSync(path.join(temp, "src"), { recursive: true });
			fs.mkdirSync(binDir, { recursive: true });
			fs.writeFileSync(path.join(temp, "src", "file.ts"), "export const value = 1;\n", "utf-8");
			const scriptPath = path.join(binDir, "tls-malformed.js");
			fs.writeFileSync(scriptPath, "process.stdout.write('Content-Length: 8\\r\\n\\r\\nnot-json'); setTimeout(() => process.exit(0), 50);\n", "utf-8");
			if (process.platform === "win32") {
				fs.writeFileSync(path.join(binDir, "typescript-language-server.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0\\tls-malformed.js" %*\r\n`, "utf-8");
			} else {
				const commandPath = path.join(binDir, "typescript-language-server");
				fs.writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/tls-malformed.js" "$@"\n`, { encoding: "utf-8", mode: 0o755 });
			}

			const diagnostics = await collectWatchdogLspDiagnostics({
				cwd: temp,
				root: temp,
				changedPaths: ["src/file.ts"],
				config: { enabled: true, timeoutMs: 500, maxFiles: 10, maxDiagnostics: 10 },
			});

			assert.equal(diagnostics.status, "failed");
			assert.match(diagnostics.message ?? "", /Invalid LSP JSON-RPC response/);
		} finally {
			try {
				fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			} catch (error) {
				if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			}
		}
	});

	it("suppresses repeated diagnostic identities until the file clears", () => {
		const ledger = new WatchdogLspDiagnosticsLedger();
		const diagnostic = {
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "warning" as const,
			source: "typescript",
			code: "TS6133",
			message: "Unused value.",
		};

		assert.equal(ledger.reduce(result([diagnostic])).diagnostics.length, 1);
		assert.equal(ledger.reduce(result([{ ...diagnostic, line: 4, column: 9 }])).diagnostics.length, 0);
		assert.equal(ledger.reduce(result([])).diagnostics.length, 0);
		assert.equal(ledger.reduce(result([{ ...diagnostic, line: 8 }])).diagnostics.length, 1);
	});
});
