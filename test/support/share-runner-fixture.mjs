// Run the real sharing finalization with fake sessions and a fail-closed CLI.
import * as fs from "node:fs";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

const scenario = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
const record = (event) => fs.appendFileSync(scenario.tracePath, `${JSON.stringify(event)}\n`);
const unexpected = (operation, command, args) => {
	record({ kind: "unexpected-command", operation, command, args });
	throw new Error(`Unexpected subprocess in share fixture: ${operation} ${command}`);
};
childProcess.spawnSync = (command, args) => {
	if (command !== "gh") return unexpected("spawnSync", command, args);
	record({ kind: "command", command, args });
	if (args.length === 2 && args[0] === "auth" && args[1] === "status") {
		return { status: scenario.authStatus ?? 0, stdout: "", stderr: "mock auth result" };
	}
	if (args.length === 3 && args[0] === "gist" && args[1] === "create") {
		return { status: scenario.uploadStatus ?? 0, stdout: "https://gist.github.com/example/abc123\n", stderr: "mock upload failed" };
	}
	return unexpected("spawnSync", command, args);
};
for (const operation of ["spawn", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
	childProcess[operation] = (command, args) => unexpected(operation, command, args);
}
const blockNetwork = (operation) => {
	record({ kind: "unexpected-network", operation });
	throw new Error(`Unexpected network operation in share fixture: ${operation}`);
};
globalThis.fetch = async () => blockNetwork("fetch");
for (const [name, module] of [["http", http], ["https", https]]) {
	for (const operation of ["get", "request"]) module[operation] = () => blockNetwork(`${name}.${operation}`);
}
net.connect = net.createConnection = () => blockNetwork("net.connect");
net.Socket.prototype.connect = () => blockNetwork("net.Socket.connect");
tls.connect = () => blockNetwork("tls.connect");
syncBuiltinESMExports();
record({ kind: "guard-ready" });
if (scenario.viewerTemplate === undefined) delete process.env.WEASLEY_SUBAGENTS_SHARE_VIEWER_URL;
else process.env.WEASLEY_SUBAGENTS_SHARE_VIEWER_URL = scenario.viewerTemplate;
process.argv[2] = scenario.runnerConfigPath;
await import("../../src/runs/background/subagent-runner.ts");
