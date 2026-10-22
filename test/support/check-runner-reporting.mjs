// Exercise the process-isolated Node test reporter transport without project code.
// Node issue #64833: force exit can discard buffered child-to-parent verdicts.
// The forced-exit cases diagnose the installed runtime; natural exit must retain
// every passing/failing verdict. No signals are sent to any process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DefaultSerializer, deserialize } from "node:v8";

const dir = mkdtempSync(join(tmpdir(), "test-report-pipe-"));
const fixture = join(dir, "fixture.test.mjs");
const count = 32;
writeFileSync(fixture, `import { test, after } from "node:test";
import { writeFileSync } from "node:fs";
const completed = [];
setTimeout(() => process.exit(99), 8000).unref();
process.on("exit", code => writeFileSync(process.env.REPORT_EXIT, JSON.stringify({ code, completed, buffered: process.stdout.writableLength })));
after(() => writeFileSync(process.env.REPORT_DONE, "completed"));
for (let i = 0; i < ${count}; i++) test("report-" + i + "-" + "x".repeat(4000), () => {
  completed.push(i);
  if (i === ${count - 1} && process.env.REPORT_FAIL === "1") throw new Error("final test failure");
});
`);

for (const failLast of [false, true]) {
  for (const forceExit of [true, false]) {
    const id = `${forceExit}-${failLast}`;
    const donePath = join(dir, `${id}.done`);
    const exitPath = join(dir, `${id}.exit.json`);
    const child = spawn(process.execPath, [...(forceExit ? ["--test-force-exit"] : []), fixture], {
      // This is the same serializer selected for an isolated --test worker.
      env: { ...process.env, NODE_TEST_CONTEXT: "child-v8", REPORT_DONE: donePath,
        REPORT_EXIT: exitPath, REPORT_FAIL: failLast ? "1" : "0" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const chunks = [];
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    // Gate only this fixture's reader. The exit marker proves all bodies ran
    // before we read any verdicts. Windows writes may block before that marker;
    // always release after 2s, independently of child progress.
    const deadline = Date.now() + 2000;
    while (!existsSync(exitPath) && Date.now() < deadline) await delay(5);
    const markerBeforeRead = existsSync(exitPath);
    const bodiesFinishedBeforeRead = existsSync(donePath);
    child.stdout.on("data", chunk => chunks.push(chunk));
    const status = await closed;
    const output = Buffer.concat(chunks);
    const serializer = new DefaultSerializer();
    serializer.writeHeader();
    const headerLength = serializer.releaseBuffer().length;
    const events = [];
    let offset = 0;
    while (offset + headerLength + 4 <= output.length) {
      const size = output.readUInt32BE(offset + headerLength);
      const start = offset + headerLength + 4;
      if (start + size > output.length) break;
      events.push(deserialize(output.subarray(start, start + size)));
      offset = start + size;
    }
    const exit = JSON.parse(readFileSync(exitPath, "utf8"));
    const verdicts = events.filter(event =>
      (event.type === "test:pass" || event.type === "test:fail") && event.data.details?.type === "test");
    const failures = verdicts.filter(event => event.type === "test:fail").length;
    const evidence = { node: process.version, platform: process.platform, forceExit, failLast,
      ...status, markerBeforeRead, bodiesFinishedBeforeRead,
      readerRelease: markerBeforeRead ? "exit-marker" : "deadline",
      completed: exit.completed.length, reported: verdicts.length,
      failures, bufferedAtExit: exit.buffered, incompleteBytes: output.length - offset };
    console.log("[runner-reporting] " + JSON.stringify(evidence));
    writeFileSync(join(dir, `${id}.evidence.json`), JSON.stringify(evidence, null, 2));
    assert.equal(stderr, "");
    assert.equal(status.code, failLast ? 1 : 0);
    assert.equal(status.signal, null);
    const expectedIds = Array.from({ length: count }, (_, index) => index);
    assert.deepEqual(exit.completed, expectedIds);
    if (!forceExit) {
      assert.equal(verdicts.length, count, "natural exit retains every verdict");
      assert.deepEqual(verdicts.map(event => Number(/^report-(\d+)-/.exec(event.data.name)?.[1])).sort((a, b) => a - b),
        expectedIds, "each registered test has exactly one verdict");
      assert.equal(failures, failLast ? 1 : 0, "natural exit retains the last failure");
      assert.equal(output.length - offset, 0, "natural exit leaves no partial event");
    }
  }
}
