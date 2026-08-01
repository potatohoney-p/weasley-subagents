import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPiArguments, PACKAGE_VERSION, parseArguments, runCli } from "../../install.mjs";

describe("Weasley Subagents installer", () => {
	it("pins installation to the released package version", () => {
		assert.deepEqual(buildPiArguments(parseArguments([])), ["install", `npm:weasley-subagents@${PACKAGE_VERSION}`]);
	});

	it("delegates removal to Pi without deleting user paths", () => {
		const calls: unknown[][] = [];
		const status = runCli({
			argv: ["--remove", "--project"],
			platform: "linux",
			spawn(command, args, options) {
				calls.push([command, args, options]);
				return { status: 0 } as never;
			},
		});
		assert.equal(status, 0);
		assert.deepEqual(calls[0]?.[0], "pi");
		assert.deepEqual(calls[0]?.[1], ["remove", "npm:weasley-subagents", "-l"]);
		assert.equal((calls[0]?.[2] as { shell?: boolean }).shell, false);
	});

	it("rejects unknown options before spawning", () => {
		assert.throws(() => parseArguments(["--delete-anything"]), /Unknown option/);
	});
});
