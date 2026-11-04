import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChain, serializeChain } from "../../src/agents/chain-serializer.ts";

const header = "---\nname: fenced-workflow\ndescription: Workflow containing Markdown examples\n---\n\n";
const tail = "\n\n## reviewer\noutput: review.md\n\nReview the worker result.";

function parseTask(task: string) {
	return parseChain(`${header}## worker\noutput: implementation.md\n\n${task}${tail}\n`, "project", "/tmp/fenced-workflow.chain.md");
}

const fencedExamples = [
	["backtick fence", "```markdown\n## example-agent\noutput: example.md\n\nExample task\n```"],
	["tilde fence", "~~~markdown\n## example-agent\n~~~"],
	["longer backtick closing fence", "```markdown\n## example-agent\n`````"],
	["longer tilde closing fence", "~~~\n## example-agent\n~~~~~"],
	["shorter backticks inside a longer fence", "````markdown\n```\n## example-agent\n```\n````"],
	["shorter tildes inside a longer fence", "~~~~\n~~~\n## example-agent\n~~~~"],
	["different fence markers inside a fence", "```markdown\n~~~\n## example-agent\n~~~\n```"],
	["closing-like line with non-whitespace suffix", "```\n```still-code\n## example-agent\n```"],
	["closing fence with trailing spaces and tabs", "```\n## example-agent\n``` \t"],
	["one-space-indented fence", " ```markdown\n## example-agent\n ```"],
	["three-space-indented fence", "   ~~~markdown\n## example-agent\n   ~~~"],
	["over-indented closing-like line", "```\n    ```\n## example-agent\n```"],
	["tilde info string containing backticks", "~~~example `code`\n## example-agent\n~~~"],
	["several fenced examples", "```markdown\n## first-example\n```\n\nText between examples.\n\n~~~markdown\n## second-example\n~~~"],
] as const;

describe("Markdown chain fenced tasks", () => {
	for (const [label, example] of fencedExamples) {
		it(`keeps headings in a ${label} inside the owning task`, () => {
			const task = `Implement this example:\n\n${example}\n\nKeep the example intact.`;
			const parsed = parseTask(task);
			assert.deepEqual(parsed.steps.map((step) => step.agent), ["worker", "reviewer"]);
			assert.equal(parsed.steps[0]?.task, task);
			assert.equal(parsed.steps[0]?.output, "implementation.md");
			assert.equal(parsed.steps[1]?.task, "Review the worker result.");
			assert.equal(parsed.steps[1]?.output, "review.md");
			const reparsed = parseChain(serializeChain(parsed), "project", parsed.filePath);
			assert.deepEqual(reparsed.steps, parsed.steps);
		});
	}

	it("does not discover example steps inside a fenced preamble", () => {
		const content = `${header}A workflow example:\n\n\`\`\`markdown\n## example-agent\n\nExample task.\n\`\`\`\n\n## worker\n\nReal task.`;
		const parsed = parseChain(content, "project", "/tmp/example.chain.md");
		assert.deepEqual(parsed.steps.map((step) => step.agent), ["worker"]);
		assert.equal(parsed.steps[0]?.task, "Real task.");
	});

	it("keeps an unclosed fence through the end of the task", () => {
		const task = "Keep this incomplete example:\n\n```markdown\n## example-agent\n\nExample task.";
		const parsed = parseChain(`${header}## worker\n\n${task}`, "project", "/tmp/example.chain.md");
		assert.deepEqual(parsed.steps.map((step) => step.agent), ["worker"]);
		assert.equal(parsed.steps[0]?.task, task);
	});

	it("handles CRLF input without changing the parsed task", () => {
		const content = `${header}## worker\n\n\`\`\`markdown\n## example-agent\n\`\`\`${tail}\n`;
		const lf = parseChain(content, "project", "/tmp/example.chain.md");
		const crlf = parseChain(content.replaceAll("\n", "\r\n"), "project", "/tmp/example.chain.md");
		assert.deepEqual(crlf.steps, lf.steps);
		assert.equal(crlf.steps.length, 2);
	});

	for (const [label, line] of [
		["inline backticks", "Example ```markdown"],
		["two backticks", "``"],
		["four-space indentation", "    ```markdown"],
		["a backtick in a backtick info string", "```invalid `info`"],
	] as const) {
		it(`does not open a fence for ${label}`, () => {
			const task = `An ordinary task.\n\n${line}`;
			const parsed = parseTask(task);
			assert.deepEqual(parsed.steps.map((step) => step.agent), ["worker", "reviewer"]);
			assert.equal(parsed.steps[0]?.task, task);
		});
	}
});
