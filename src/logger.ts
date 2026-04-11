/**
 * Minimal structured logger.
 *
 * Outputs JSON lines to stderr. Each entry includes timestamp, level, pid, message,
 * and any structured context. Levels: error > warn > info > debug.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

let threshold: Level = "info";

export function setLevel(level: Level): void {
	threshold = level;
}

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
	if (LEVELS[level] > LEVELS[threshold]) return;
	const entry: Record<string, unknown> = {
		ts: new Date().toISOString(),
		level,
		pid: process.pid,
		msg: message,
	};
	if (context) {
		for (const [k, v] of Object.entries(context)) {
			entry[k] = v;
		}
	}
	process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export function error(message: string, context?: Record<string, unknown>): void {
	emit("error", message, context);
}

export function warn(message: string, context?: Record<string, unknown>): void {
	emit("warn", message, context);
}

export function info(message: string, context?: Record<string, unknown>): void {
	emit("info", message, context);
}

export function debug(message: string, context?: Record<string, unknown>): void {
	emit("debug", message, context);
}
