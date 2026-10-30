interface CompletionDataLike {
	id?: unknown;
	agent?: unknown;
	timestamp?: unknown;
	sessionId?: unknown;
	taskIndex?: unknown;
	totalTasks?: unknown;
	success?: unknown;
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	return Number.isFinite(value) ? value : undefined;
}

export function buildCompletionKey(data: CompletionDataLike, fallback: string): string {
	const sessionId = asNonEmptyString(data.sessionId) ?? null;
	const id = asNonEmptyString(data.id);
	// Encode field boundaries and missing values explicitly: delimiters and
	// sentinel words can legitimately occur inside session, run, or agent names.
	if (id) return JSON.stringify(["id", sessionId, id]);
	const agent = asNonEmptyString(data.agent) ?? null;
	const timestamp = asFiniteNumber(data.timestamp);
	const taskIndex = asFiniteNumber(data.taskIndex);
	const totalTasks = asFiniteNumber(data.totalTasks);
	const success = typeof data.success === "boolean" ? data.success : null;
	return JSON.stringify([
		"meta",
		sessionId,
		agent,
		timestamp ?? null,
		taskIndex ?? null,
		totalTasks ?? null,
		success,
		fallback,
	]);
}

function pruneSeenMap(seen: Map<string, number>, now: number, ttlMs: number): void {
	for (const [key, ts] of seen.entries()) {
		if (now - ts > ttlMs) seen.delete(key);
	}
}

export function markSeenWithTtl(seen: Map<string, number>, key: string, now: number, ttlMs: number): boolean {
	pruneSeenMap(seen, now, ttlMs);
	if (seen.has(key)) return true;
	seen.set(key, now);
	return false;
}
