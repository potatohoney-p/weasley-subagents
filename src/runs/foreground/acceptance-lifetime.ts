import type { AcceptanceLedger } from "../../shared/types.ts";
import { acceptanceCleanupWarning, buildSkippedAcceptanceLedger, evaluateAcceptance } from "../shared/acceptance.ts";

interface ForegroundAcceptanceLifetime {
	signal?: AbortSignal;
	deadlineAt?: number;
	timeoutMs?: number;
}

/** Keep verification in the originating run's lifetime after its child exits. */
export async function evaluateForegroundAcceptance(
	input: Parameters<typeof evaluateAcceptance>[0],
	lifetime: ForegroundAcceptanceLifetime,
): Promise<{ acceptance: AcceptanceLedger; interruption?: { message: string; timedOut: boolean } }> {
	const controller = new AbortController();
	let interruption: { message: string; timedOut: boolean } | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const abort = (timedOut: boolean) => {
		if (interruption) return;
		interruption = {
			message: timedOut
				? lifetime.timeoutMs !== undefined ? `Subagent timed out after ${lifetime.timeoutMs}ms.` : "Subagent deadline expired during acceptance verification."
				: "Subagent run cancelled during acceptance verification.",
			timedOut,
		};
		controller.abort();
	};
	const onAbort = () => abort(false);
	const armDeadline = () => {
		if (interruption || lifetime.deadlineAt === undefined) return;
		const remaining = lifetime.deadlineAt - Date.now();
		if (remaining <= 0) abort(true);
		else {
			// Node coerces overflowing delays to 1 ms. Recheck long deadlines instead.
			timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
			timer.unref?.();
		}
	};
	if (lifetime.signal?.aborted) onAbort();
	else lifetime.signal?.addEventListener("abort", onAbort, { once: true });
	armDeadline();
	try {
		const acceptance = interruption
			? buildSkippedAcceptanceLedger(input.acceptance, { id: interruption.timedOut ? "timeout" : "cancelled", message: interruption.message })
			: await evaluateAcceptance({ ...input, signal: controller.signal, abortMessage: "Acceptance verification was interrupted." });
		if (!interruption) return { acceptance };
		const message = [interruption.message, acceptanceCleanupWarning(acceptance)].filter(Boolean).join(" ");
		return {
			acceptance: buildSkippedAcceptanceLedger(input.acceptance, {
				id: interruption.timedOut ? "timeout" : "cancelled",
				message: interruption.message,
				verifyRuns: acceptance.verifyRuns,
			}),
			interruption: { ...interruption, message },
		};
	} finally {
		if (timer) clearTimeout(timer);
		lifetime.signal?.removeEventListener("abort", onAbort);
	}
}
