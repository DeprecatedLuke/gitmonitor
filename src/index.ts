#!/usr/bin/env bun
import * as path from "node:path";
import * as logger from "./logger";
import { scanAll } from "./git";
import { startTui } from "./tui";

const rootDir = path.resolve(process.argv[2] ?? ".");

logger.info("scanning", { rootDir });

const repos = await scanAll(rootDir);
logger.info("discovered repos", { count: repos.length });

await startTui(repos, () => scanAll(rootDir));
