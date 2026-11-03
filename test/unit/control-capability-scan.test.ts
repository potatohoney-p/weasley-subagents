import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	steerCapabilityPath, writeSteerAck, writeSteerCapability, watchAsyncControlInbox,
	type ControlChannelFs, type ControlChannelTimers,
} from "../../src/runs/background/control-channel.ts";

describe("control capability scan failure isolation", () => {
	for (const code of ["EIO", "EACCES", "ENOENT"]) {
		it(`delivers acknowledgements while the capability scan fails with ${code}, then recovers`, () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-capability-scan-"));
			let dispose: (() => void) | undefined;
			try {
				writeSteerCapability(root, { index: 0, pid: 42, readyAt: 100, supported: true });
				const capabilityPath = steerCapabilityPath(root, 0);
				const original = fs.readFileSync(capabilityPath, "utf8");
				const capabilityDir = path.dirname(capabilityPath);
				let failScan = true;
				let scanFailures = 0;
				let onWatch = () => {};
				let onPoll = () => {};
				const fsImpl = {
					...fs,
					readdirSync: ((target: fs.PathLike, ...args: unknown[]) => {
						if (String(target) === capabilityDir && failScan) {
							scanFailures++;
							throw Object.assign(new Error("injected capability scan failure"), { code });
						}
						return (fs.readdirSync as Function)(target, ...args);
					}) as typeof fs.readdirSync,
					watch: ((_target: fs.PathLike, cb: () => void) => {
						onWatch = cb;
						return { on() {}, close() {} };
					}) as unknown as typeof fs.watch,
				} satisfies ControlChannelFs;
				const timers = {
					setInterval: ((cb: () => void) => { onPoll = cb; return { unref() {} }; }) as unknown as typeof setInterval,
					clearInterval: (() => {}) as typeof clearInterval,
				} satisfies ControlChannelTimers;
				const acks: string[] = [];
				const capabilities: number[] = [];
				const ack = (requestId: string) => writeSteerAck(root, { requestId, index: 0, ts: 101, state: "delivered", message: "accepted" });
				ack("startup");
				dispose = watchAsyncControlInbox(root, {
					onInterrupt() {}, onSteerAck: item => acks.push(item.requestId),
					onSteerCapability: item => capabilities.push(item.index), fs: fsImpl, timers,
				});
				assert.deepEqual(acks, ["startup"]);
				ack("native-watch"); onWatch();
				ack("poll"); onPoll();
				assert.deepEqual(acks, ["startup", "native-watch", "poll"]);
				assert.equal(scanFailures, 3);
				assert.deepEqual(capabilities, []);
				assert.equal(fs.readFileSync(capabilityPath, "utf8"), original);
				failScan = false; onPoll();
				assert.deepEqual(capabilities, [0]);
				assert.deepEqual(acks, ["startup", "native-watch", "poll"], "consumed acknowledgements are not replayed");
				dispose(); dispose = undefined;
				ack("after-dispose"); onWatch(); onPoll();
				assert.equal(acks.length, 3);
			} finally { dispose?.(); fs.rmSync(root, { recursive: true, force: true }); }
		});
	}
});
