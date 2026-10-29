import * as fs from "node:fs";
import * as path from "node:path";
import type { TokenUsage } from "./types.ts";

function findLatestSessionFile(sessionDir: string): string | null {
	try {
		const files = fs.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => path.join(sessionDir, f));
		if (files.length === 0) return null;
		files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		return files[0] ?? null;
	} catch {
		// Session token lookup is optional metadata.
		return null;
	}
}

export function parseSessionTokens(sessionDir: string): TokenUsage | null {
	const sessionFile = findLatestSessionFile(sessionDir);
	if (!sessionFile) return null;
	try {
		const content = fs.readFileSync(sessionFile, "utf-8");
		let input = 0;
		let output = 0;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				const usage = entry.usage ?? entry.message?.usage;
				if (usage != null) {
					// Persisted metadata is not necessarily SDK-validated. Do not
					// coerce strings or return a plausible partial total on corruption.
					if (typeof usage !== "object" || Array.isArray(usage)) return null;
					const nextInput = usage.inputTokens ?? usage.input ?? 0;
					const nextOutput = usage.outputTokens ?? usage.output ?? 0;
					if (!Number.isSafeInteger(nextInput) || nextInput < 0
						|| !Number.isSafeInteger(nextOutput) || nextOutput < 0) return null;
					input += nextInput;
					output += nextOutput;
					if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)
						|| !Number.isSafeInteger(input + output)) return null;
				}
			} catch {
				// Ignore malformed lines while scanning usage entries.
			}
		}
		return { input, output, total: input + output };
	} catch {
		// Usage extraction should not fail the run.
		return null;
	}
}
