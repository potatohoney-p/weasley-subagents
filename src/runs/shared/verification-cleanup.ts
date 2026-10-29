import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

export interface VerificationTermination {
	method: "windows-taskkill" | "posix-process-group";
	outcome: "group-exited" | "attempted" | "unconfirmed";
	detail: string;
}

const CLEANUP_DEADLINE_MS = 2000;
const GRACE_PERIOD_MS = 1000;

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 2048);
}

function groupIsGone(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

async function cleanupProcessGroup(pid: number): Promise<VerificationTermination> {
	const result = (outcome: VerificationTermination["outcome"], detail: string): VerificationTermination => ({ method: "posix-process-group", outcome, detail });
	const gone = () => result("group-exited", "The owned verification process group no longer exists; processes that escaped the group are not covered.");
	const startedAt = performance.now();
	try {
		process.kill(-pid, "SIGTERM");
	} catch (error) {
		return groupIsGone(error) ? gone() : result("unconfirmed", `Could not terminate the owned verification process group: ${errorMessage(error)}`);
	}
	let escalated = false;
	while (performance.now() - startedAt < CLEANUP_DEADLINE_MS) {
		try {
			process.kill(-pid, 0);
			if (!escalated && performance.now() - startedAt >= GRACE_PERIOD_MS) {
				escalated = true;
				process.kill(-pid, "SIGKILL");
			}
		} catch (error) {
			return groupIsGone(error) ? gone() : result("unconfirmed", `Verification process group cleanup could not be confirmed: ${errorMessage(error)}`);
		}
		await delay(Math.min(50, Math.max(1, CLEANUP_DEADLINE_MS - (performance.now() - startedAt))));
	}
	return result("unconfirmed", "Verification process group cleanup reached its deadline; owned processes may remain.");
}

function cleanupWindowsTree(child: ChildProcess, pid: number): Promise<VerificationTermination> {
	const result = (outcome: VerificationTermination["outcome"], detail: string): VerificationTermination => ({ method: "windows-taskkill", outcome, detail });
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(result("unconfirmed", "The verification shell already exited; its PID will not be reused for tree termination, and descendants may remain."));
	}
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
		return Promise.resolve(result("unconfirmed", "An absolute SystemRoot is unavailable; verification tree termination was not attempted."));
	}
	return new Promise((resolve) => {
		let settled = false;
		let rootClosed = false;
		let helperClosed = false;
		let helperSucceeded = false;
		let helper: ChildProcess | undefined;
		let diagnostic = "";
		const onData = (chunk: string) => { diagnostic = (diagnostic + chunk).slice(0, 2048); };
		const finish = (termination: VerificationTermination) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			child.removeListener("close", onRootClose);
			helper?.stderr?.removeListener("data", onData);
			helper?.stderr?.destroy();
			// The result is now settled; an unkillable helper must not hold the host open.
			if (helper && !helperClosed) helper.unref();
			resolve(termination);
		};
		const maybeFinish = () => {
			if (helperSucceeded && rootClosed) finish(result("attempted", "Tree termination command completed and the verification shell's pipes closed; descendant termination not independently confirmed."));
		};
		const onRootClose = () => { rootClosed = true; maybeFinish(); };
		const onError = (error: Error) => finish(result("unconfirmed", `Verification tree termination failed: ${errorMessage(error)}`));
		const onHelperClose = (code: number | null, signal: NodeJS.Signals | null) => {
			helperClosed = true;
			helper?.removeListener("error", onError);
			if (settled) return;
			if (code !== 0) {
				finish(result("unconfirmed", `Tree termination command exited with ${code === null ? signal ?? "unknown status" : `code ${code}`}${diagnostic.trim() ? `: ${diagnostic.trim()}` : "."}`));
				return;
			}
			helperSucceeded = true;
			maybeFinish();
		};
		const deadline = setTimeout(() => {
			// Only the helper's own handle is used here, never a stale shell PID.
			if (helper && !helperClosed) {
				try { helper.kill("SIGKILL"); } catch { /* Report the bounded cleanup failure below. */ }
			}
			finish(result("unconfirmed", "Verification tree cleanup reached its deadline; descendant termination remains unconfirmed."));
		}, CLEANUP_DEADLINE_MS);
		child.once("close", onRootClose);
		try {
			helper = spawn(path.win32.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "ignore", "pipe"],
			});
			// Keep the error handler until helper close, even after a deadline, so
			// a late spawn/kill error cannot become an unhandled event.
			helper.on("error", onError);
			helper.once("close", onHelperClose);
			helper.stderr?.setEncoding("utf8");
			helper.stderr?.on("data", onData);
		} catch (error) {
			finish(result("unconfirmed", `Could not start verification tree termination: ${errorMessage(error)}`));
		}
	});
}

/** The caller must create an owned process group with detached:true on POSIX. */
export function cleanupVerificationProcess(child: ChildProcess): Promise<VerificationTermination> {
	const method = process.platform === "win32" ? "windows-taskkill" : "posix-process-group";
	const pid = child.pid;
	if (pid === undefined || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
		return Promise.resolve({ method, outcome: "unconfirmed", detail: "A valid owned verification PID is unavailable; cleanup was not attempted." });
	}
	return process.platform === "win32" ? cleanupWindowsTree(child, pid) : cleanupProcessGroup(pid);
}
