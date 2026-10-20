import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, runFileSystemOperationWithRetry, waitForFileSystemRetry } from "./file-system-retry.ts";

type AtomicJsonFs = Pick<typeof fs, "mkdirSync" | "writeFileSync" | "renameSync" | "rmSync"> & Partial<Pick<typeof fs, "linkSync">>;

type AtomicJsonWriterOptions = {
	fs?: AtomicJsonFs;
	now?: () => number;
	pid?: number;
	random?: () => number;
	mode?: number;
	retryRenameErrors?: boolean;
	retryDirectoryErrors?: boolean;
	retryDelaysMs?: readonly number[];
	wait?: (delayMs: number) => void;
	/** Publish without replacing an existing file. Requires same-filesystem hard links. */
	replaceExisting?: boolean;
};

function renameWithRetry(
	fsImpl: AtomicJsonFs,
	sourcePath: string,
	targetPath: string,
	retryDelaysMs: readonly number[],
	wait: (delayMs: number) => void,
): void {
	runFileSystemOperationWithRetry(() => {
		fsImpl.renameSync(sourcePath, targetPath);
	}, { retryDelaysMs, wait });
}

export function createAtomicJsonWriter(options: AtomicJsonWriterOptions = {}): (filePath: string, payload: object) => boolean {
	const fsImpl = options.fs ?? fs;
	const now = options.now ?? Date.now;
	const pid = options.pid ?? process.pid;
	const random = options.random ?? Math.random;
	const mode = options.mode;
	const retryRenameErrors = options.retryRenameErrors ?? process.platform === "win32";
	const retryDirectoryErrors = options.retryDirectoryErrors ?? retryRenameErrors;
	const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
	const renameRetryDelaysMs = retryRenameErrors ? retryDelaysMs : [];
	const directoryRetryDelaysMs = retryDirectoryErrors ? retryDelaysMs : [];
	const wait = options.wait ?? waitForFileSystemRetry;
	return (filePath: string, payload: object): boolean => {
		runFileSystemOperationWithRetry(() => {
			fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
		}, { retryDelaysMs: directoryRetryDelaysMs, wait });
		const tempPath = path.join(
			path.dirname(filePath),
			`.${path.basename(filePath)}.${pid}.${now()}.${random().toString(36).slice(2)}.tmp`,
		);
		try {
			fsImpl.writeFileSync(tempPath, JSON.stringify(payload, null, 2), mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
			if (options.replaceExisting === false) {
				// Linking publishes a complete file atomically and fails if another
				// writer won. A check followed by rename would overwrite that winner.
				if (!fsImpl.linkSync) throw new Error("Atomic JSON publication requires hard-link support.");
				try {
					runFileSystemOperationWithRetry(() => fsImpl.linkSync!(tempPath, filePath), { retryDelaysMs: renameRetryDelaysMs, wait });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
					throw error;
				}
			} else {
				renameWithRetry(fsImpl, tempPath, filePath, renameRetryDelaysMs, wait);
			}
			return true;
		} finally {
			fsImpl.rmSync(tempPath, { force: true });
		}
	};
}

export const writeAtomicJson = createAtomicJsonWriter();
export const writePrivateAtomicJson = createAtomicJsonWriter({ mode: 0o600 });
export const writeAtomicJsonIfAbsent = createAtomicJsonWriter({ replaceExisting: false });
