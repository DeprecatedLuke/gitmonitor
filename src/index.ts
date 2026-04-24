#!/usr/bin/env bun
import * as path from "node:path";
import * as logger from "./logger";
import { scanAll } from "./scanner";
import { startTui } from "./tui";

const args = process.argv.slice(2);
let rootArg = ".";
let limit = 50;
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--limit" || a === "-n") {
		const next = args[++i];
		const parsed = Number.parseInt(next ?? "", 10);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			logger.error("invalid --limit", { value: next });
			process.exit(2);
		}
		limit = parsed;
	} else if (!a.startsWith("-")) {
		rootArg = a;
	} else {
		logger.error("unknown argument", { arg: a });
		process.exit(2);
	}
}

const rootDir = path.resolve(rootArg);
logger.info("scanning", { rootDir, limit });

const initial = await scanAll(rootDir, { limit });
logger.info("scan complete", { repos: initial.repoCount, commits: initial.commits.length });

await startTui(initial, () => scanAll(rootDir, { limit }));
