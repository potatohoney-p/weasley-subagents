import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildShareViewerUrl } from "../../src/runs/background/share-link.ts";

describe("session share viewer", () => {
	it("uses the secret Gist URL when no third-party viewer is configured", () => {
		assert.deepEqual(buildShareViewerUrl("https://gist.github.com/example/abc", "abc", ""), {
			shareUrl: "https://gist.github.com/example/abc",
		});
	});

	it("supports an explicit HTTPS viewer template", () => {
		assert.deepEqual(buildShareViewerUrl("https://gist.github.com/example/abc", "a/b", "https://viewer.example/session/{gistId}"), {
			shareUrl: "https://viewer.example/session/a%2Fb",
		});
	});

	it("rejects unsafe or ambiguous endpoints", () => {
		const unsafe = buildShareViewerUrl("https://gist", "abc", "http://viewer/{gistId}");
		const ambiguous = buildShareViewerUrl("https://gist", "abc", "https://viewer/session");
		assert.match("error" in unsafe ? unsafe.error : "", /HTTPS/);
		assert.match("error" in ambiguous ? ambiguous.error : "", /placeholder/);
	});
});
