export function buildShareViewerUrl(
	gistUrl: string,
	gistId: string,
	viewerTemplate = process.env.WEASLEY_SUBAGENTS_SHARE_VIEWER_URL,
): { shareUrl: string } | { error: string } {
	const configured = viewerTemplate?.trim();
	if (!configured) return { shareUrl: gistUrl };
	if (!configured.includes("{gistId}")) {
		return { error: "WEASLEY_SUBAGENTS_SHARE_VIEWER_URL must contain the {gistId} placeholder." };
	}
	try {
		const url = new URL(configured.replaceAll("{gistId}", encodeURIComponent(gistId)));
		if (url.protocol !== "https:" || url.username || url.password) {
			return { error: "WEASLEY_SUBAGENTS_SHARE_VIEWER_URL must be an HTTPS URL without embedded credentials." };
		}
		return { shareUrl: url.toString() };
	} catch {
		return { error: "WEASLEY_SUBAGENTS_SHARE_VIEWER_URL is not a valid URL." };
	}
}
