#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const metadata = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8").replace(/^\uFEFF/, ""));
export const PACKAGE_NAME = metadata.name;
export const PACKAGE_VERSION = metadata.version;

export function parseArguments(argv) {
	const known = new Set(["--help", "-h", "--version", "-v", "--remove", "-r", "--project", "-l"]);
	const unknown = argv.filter((arg) => !known.has(arg));
	if (unknown.length > 0) throw new Error(`Unknown option: ${unknown[0]}`);
	return {
		help: argv.some((arg) => arg === "--help" || arg === "-h"),
		version: argv.some((arg) => arg === "--version" || arg === "-v"),
		remove: argv.some((arg) => arg === "--remove" || arg === "-r"),
		project: argv.some((arg) => arg === "--project" || arg === "-l"),
	};
}

export function buildPiArguments(options) {
	const source = options.remove ? `npm:${PACKAGE_NAME}` : `npm:${PACKAGE_NAME}@${PACKAGE_VERSION}`;
	return [options.remove ? "remove" : "install", source, ...(options.project ? ["-l"] : [])];
}

export function runCli({ argv = process.argv.slice(2), spawn = spawnSync, platform = process.platform } = {}) {
	let options;
	try {
		options = parseArguments(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (options.help) {
		console.log(`Weasley Subagents ${PACKAGE_VERSION}

Usage:
  npx ${PACKAGE_NAME}              Install this exact released version
  npx ${PACKAGE_NAME} --remove     Remove the managed npm package
  npx ${PACKAGE_NAME} --project    Manage the current project's Pi settings

Removal is delegated to Pi's package manager. User configuration and run
artifacts are intentionally left untouched.`);
		return 0;
	}
	if (options.version) {
		console.log(PACKAGE_VERSION);
		return 0;
	}
	const command = platform === "win32" ? "pi.cmd" : "pi";
	const result = spawn(command, buildPiArguments(options), { stdio: "inherit", shell: false });
	if (result.error) {
		console.error(`Could not run Pi (${result.error.message}). Install @earendil-works/pi-coding-agent first.`);
		return 1;
	}
	return result.status ?? 1;
}

const invokedPath = process.argv[1] ? fileURLToPath(new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`)) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) process.exitCode = runCli();
