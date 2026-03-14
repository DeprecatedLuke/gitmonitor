import terminalKit from "terminal-kit";
import type { RepoInfo } from "./git";
import { getFileDiff } from "./git";
import * as logger from "./logger";

const term = terminalKit.terminal;

// --- ANSI escape codes ---

const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const INVERSE = "\x1b[7m";
const RESET = "\x1b[0m";
const MAGENTA = "\x1b[35m";

// --- Line model ---

type LineType = "header" | "section" | "commit" | "change" | "empty" | "message" | "diff";

type Line = {
	type: LineType;
	repoIndex: number;
	text: string;
	/** Index into RepoInfo.changes, set on change lines */
	changeIndex?: number;
};

// --- Diff view state ---

type DiffView = {
	repoIndex: number;
	changeIndex: number;
	lines: Line[];
	cursor: number;
	scroll: number;
	/** Which mode to return to */
	previousMode: "list" | "detail";
};

// --- View state ---

type ViewState = {
	repos: RepoInfo[];
	cursor: number;
	scroll: number;
	expanded: Set<number>;
	detailRepo: number;
	diffView: DiffView | null;
};

// --- Line building ---

function statusColor(status: string): string {
	switch (status) {
		case "M":
			return YELLOW;
		case "A":
			return GREEN;
		case "D":
			return RED;
		case "??":
			return DIM;
		default:
			return RESET;
	}
}

/** Color a single diff line based on its prefix. */
function colorDiffLine(raw: string): string {
	if (raw.startsWith("+++") || raw.startsWith("---")) return `${BOLD}${raw}${RESET}`;
	if (raw.startsWith("+")) return `${GREEN}${raw}${RESET}`;
	if (raw.startsWith("-")) return `${RED}${raw}${RESET}`;
	if (raw.startsWith("@@")) return `${CYAN}${raw}${RESET}`;
	if (raw.startsWith("===")) return `${BOLD}${YELLOW}${raw}${RESET}`;
	if (raw.startsWith("diff ")) return `${BOLD}${raw}${RESET}`;
	return raw;
}

function buildChangeLines(repo: RepoInfo, repoIndex: number): Line[] {
	const lines: Line[] = [];
	for (let ci = 0; ci < repo.changes.length; ci++) {
		const change = repo.changes[ci];
		const sc = statusColor(change.status);
		const statusStr = `${sc}${change.status.padEnd(2)}${RESET}`;
		let diffStr = "";
		if (change.added > 0 || change.deleted > 0) {
			const parts: string[] = [];
			if (change.added > 0) parts.push(`${GREEN}+${change.added}${RESET}`);
			if (change.deleted > 0) parts.push(`${RED}-${change.deleted}${RESET}`);
			diffStr = `  ${parts.join(" ")}`;
		}
		lines.push({
			type: "change",
			repoIndex,
			changeIndex: ci,
			text: `     ${statusStr} ${change.path}${diffStr}`,
		});
	}
	return lines;
}

function buildListLines(state: ViewState): Line[] {
	const lines: Line[] = [];

	for (let i = 0; i < state.repos.length; i++) {
		const repo = state.repos[i];
		const expanded = state.expanded.has(i);
		const arrow = expanded ? "▼" : "▶";
		const header = ` ${arrow} ${BOLD}${repo.relativePath}/${RESET}${DIM}(${CYAN}${repo.branch}${RESET}${DIM})${RESET}`;
		lines.push({ type: "header", repoIndex: i, text: header });

		if (expanded) {
			// Commits section
			lines.push({ type: "section", repoIndex: i, text: `   Commits:` });
			if (repo.commits.length === 0) {
				lines.push({ type: "message", repoIndex: i, text: `     ${DIM}No commits yet${RESET}` });
			} else {
				for (const commit of repo.commits) {
					const hash = `${YELLOW}${commit.hash}${RESET}`;
					const subject = commit.subject;
					const date = `${DIM}${commit.date}${RESET}`;
					lines.push({
						type: "commit",
						repoIndex: i,
						text: `     ${hash} ${subject}  ${date}`,
					});
				}
			}

			// Changes section
			if (repo.changes.length === 0) {
				lines.push({ type: "message", repoIndex: i, text: `   ${DIM}No uncommitted changes${RESET}` });
			} else {
				lines.push({
					type: "section",
					repoIndex: i,
					text: `   Changes (${repo.changes.length} file${repo.changes.length === 1 ? "" : "s"}):`,
				});
				lines.push(...buildChangeLines(repo, i));
			}

			// Blank separator after expanded repo
			lines.push({ type: "empty", repoIndex: i, text: "" });
		}
	}

	return lines;
}

function buildDetailLines(state: ViewState): Line[] {
	const repo = state.repos[state.detailRepo];
	if (!repo) return [];

	const lines: Line[] = [];

	lines.push({
		type: "header",
		repoIndex: state.detailRepo,
		text: ` ${BOLD}${repo.relativePath}/${RESET}${DIM}(${CYAN}${repo.branch}${RESET}${DIM})${RESET}`,
	});
	lines.push({
		type: "message",
		repoIndex: state.detailRepo,
		text: ` ${DIM}Path: ${repo.path}${RESET}`,
	});
	lines.push({ type: "empty", repoIndex: state.detailRepo, text: "" });

	// All commits
	lines.push({ type: "section", repoIndex: state.detailRepo, text: ` ${BOLD}Commits:${RESET}` });
	if (repo.commits.length === 0) {
		lines.push({ type: "message", repoIndex: state.detailRepo, text: `   ${DIM}No commits yet${RESET}` });
	} else {
		for (const commit of repo.commits) {
			const hash = `${YELLOW}${commit.hash}${RESET}`;
			const author = `${MAGENTA}${commit.author}${RESET}`;
			const date = `${DIM}${commit.date}${RESET}`;
			lines.push({
				type: "commit",
				repoIndex: state.detailRepo,
				text: `   ${hash} ${commit.subject}  ${author}  ${date}`,
			});
		}
	}

	lines.push({ type: "empty", repoIndex: state.detailRepo, text: "" });

	// All changes
	lines.push({ type: "section", repoIndex: state.detailRepo, text: ` ${BOLD}Changes:${RESET}` });
	if (repo.changes.length === 0) {
		lines.push({ type: "message", repoIndex: state.detailRepo, text: `   ${DIM}No uncommitted changes${RESET}` });
	} else {
		lines.push(...buildChangeLines(repo, state.detailRepo));
	}

	return lines;
}

function buildDiffLines(repoIndex: number, filePath: string, diffText: string): Line[] {
	const lines: Line[] = [];
	lines.push({
		type: "header",
		repoIndex,
		text: ` ${BOLD}${filePath}${RESET}`,
	});
	lines.push({ type: "empty", repoIndex, text: "" });

	for (const raw of diffText.split("\n")) {
		lines.push({ type: "diff", repoIndex, text: ` ${colorDiffLine(raw)}` });
	}
	return lines;
}

function buildLines(state: ViewState): Line[] {
	if (state.diffView) return state.diffView.lines;
	if (state.detailRepo >= 0) return buildDetailLines(state);
	return buildListLines(state);
}

// --- Rendering ---

/** Strip ANSI escape sequences to get the visible character count. */
function visibleLength(s: string): number {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Truncate a string with ANSI codes to fit within maxWidth visible chars. */
function truncateAnsi(s: string, maxWidth: number): string {
	let visible = 0;
	let i = 0;
	while (i < s.length && visible < maxWidth) {
		if (s[i] === "\x1b") {
			// Skip entire escape sequence
			const end = s.indexOf("m", i);
			if (end !== -1) {
				i = end + 1;
				continue;
			}
		}
		visible++;
		i++;
	}
	// Append RESET so we don't bleed styles
	return s.slice(0, i) + RESET;
}

function getMode(state: ViewState): string {
	if (state.diffView) return "diff";
	if (state.detailRepo >= 0) return "detail";
	return "list";
}

function render(state: ViewState, lines: Line[]): void {
	const w = term.width;
	const h = term.height;
	const scroll = state.diffView ? state.diffView.scroll : state.scroll;
	const cursor = state.diffView ? state.diffView.cursor : state.cursor;

	if (w < 40 || h < 10) {
		term.clear();
		term.moveTo(1, 1);
		term.styleReset();
		term("Terminal too small");
		return;
	}

	// Status bar takes 1 line at the bottom
	const viewHeight = h - 1;

	for (let row = 0; row < viewHeight; row++) {
		const lineIndex = scroll + row;
		term.moveTo(1, row + 1);
		term.styleReset();
		term.eraseLine();

		if (lineIndex >= lines.length) continue;

		const line = lines[lineIndex];
		const isCursor = lineIndex === cursor;

		let content = line.text;
		// Truncate to terminal width
		if (visibleLength(content) > w) {
			content = truncateAnsi(content, w - 1) + "…";
		}

		if (isCursor) {
			term(INVERSE + content + RESET);
		} else {
			term(content);
		}
	}

	// Status bar
	term.moveTo(1, h);
	term.styleReset();
	term.eraseLine();
	const repoCount = state.repos.length;
	const lineInfo = `${cursor + 1}/${lines.length}`;
	const mode = getMode(state);
	const statusText = ` ${INVERSE} gitmonitor ${RESET} ${DIM}${repoCount} repo${repoCount === 1 ? "" : "s"} | ${mode} | ${lineInfo} | q:quit r:refresh${RESET}`;
	if (visibleLength(statusText) > w) {
		term(truncateAnsi(statusText, w));
	} else {
		term(statusText);
	}
}

// --- Scroll management ---

function ensureCursorVisible(state: ViewState, viewHeight: number): void {
	if (state.diffView) {
		if (state.diffView.cursor < state.diffView.scroll) {
			state.diffView.scroll = state.diffView.cursor;
		} else if (state.diffView.cursor >= state.diffView.scroll + viewHeight) {
			state.diffView.scroll = state.diffView.cursor - viewHeight + 1;
		}
		return;
	}
	if (state.cursor < state.scroll) {
		state.scroll = state.cursor;
	} else if (state.cursor >= state.scroll + viewHeight) {
		state.scroll = state.cursor - viewHeight + 1;
	}
}

// --- Input handling ---

function repoIndexForLine(lines: Line[], lineIndex: number): number {
	if (lineIndex < 0 || lineIndex >= lines.length) return -1;
	return lines[lineIndex].repoIndex;
}

function isHeaderLine(lines: Line[], lineIndex: number): boolean {
	if (lineIndex < 0 || lineIndex >= lines.length) return false;
	return lines[lineIndex].type === "header";
}

function isChangeLine(lines: Line[], lineIndex: number): boolean {
	if (lineIndex < 0 || lineIndex >= lines.length) return false;
	return lines[lineIndex].type === "change";
}

// --- Main entry point ---

export async function startTui(repos: RepoInfo[], onRefresh: () => Promise<RepoInfo[]>): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();

	const state: ViewState = {
		repos,
		cursor: 0,
		scroll: 0,
		expanded: new Set(),
		detailRepo: -1,
		diffView: null,
	};

	let lines = buildLines(state);

	function fullRender(): void {
		lines = buildLines(state);
		const viewHeight = term.height - 1;
		if (state.diffView) {
			if (state.diffView.lines.length === 0) {
				state.diffView.cursor = 0;
				state.diffView.scroll = 0;
			} else {
				state.diffView.cursor = Math.max(0, Math.min(state.diffView.cursor, state.diffView.lines.length - 1));
			}
			ensureCursorVisible(state, viewHeight);
		} else {
			// Clamp cursor
			if (lines.length === 0) {
				state.cursor = 0;
				state.scroll = 0;
			} else {
				state.cursor = Math.max(0, Math.min(state.cursor, lines.length - 1));
			}
			ensureCursorVisible(state, viewHeight);
		}
		render(state, lines);
	}

	function handleEmpty(): boolean {
		if (state.repos.length === 0) {
			term.clear();
			term.moveTo(1, 1);
			term.styleReset();
			term(`${DIM}No git repositories found${RESET}`);
			term.moveTo(1, term.height);
			term(`${INVERSE} gitmonitor ${RESET} ${DIM}q:quit r:refresh${RESET}`);
			return true;
		}
		return false;
	}

	let refreshTimer: NodeJS.Timeout | undefined;

	function cleanup(): void {
		if (refreshTimer) clearInterval(refreshTimer);
		term.styleReset();
		term.fullscreen(false);
		term.hideCursor(false);
		term.grabInput(false);
	}

	async function openDiff(ri: number, ci: number): Promise<void> {
		const repo = state.repos[ri];
		if (!repo || ci < 0 || ci >= repo.changes.length) return;

		const change = repo.changes[ci];
		const diffText = await getFileDiff(repo.path, change.path, change.status);
		const diffLines = buildDiffLines(ri, change.path, diffText);

		state.diffView = {
			repoIndex: ri,
			changeIndex: ci,
			lines: diffLines,
			cursor: 0,
			scroll: 0,
			previousMode: state.detailRepo >= 0 ? "detail" : "list",
		};
		lines = diffLines;
		render(state, lines);
	}

	function closeDiff(): void {
		if (!state.diffView) return;
		const prev = state.diffView.previousMode;
		const ri = state.diffView.repoIndex;
		state.diffView = null;

		if (prev === "detail") {
			state.detailRepo = ri;
		}
		// Rebuild and restore cursor to the change line
		fullRender();
	}

	// Setup terminal
	term.fullscreen(true);
	term.hideCursor();
	term.grabInput({ mouse: false });

	if (!handleEmpty()) {
		fullRender();
	}

	term.on("key", async (name: string) => {
		const viewHeight = term.height - 1;

		// --- Diff view handles its own keys ---
		if (state.diffView) {
			switch (name) {
				case "q":
				case "CTRL_C":
					cleanup();
					term.processExit(0);
					resolve();
					return;
				case "UP":
				case "k":
					if (state.diffView.cursor > 0) {
						state.diffView.cursor--;
						ensureCursorVisible(state, viewHeight);
						render(state, lines);
					}
					return;
				case "DOWN":
				case "j":
					if (state.diffView.cursor < state.diffView.lines.length - 1) {
						state.diffView.cursor++;
						ensureCursorVisible(state, viewHeight);
						render(state, lines);
					}
					return;
				case "LEFT":
				case "h":
				case "ESCAPE":
					closeDiff();
					return;
				default:
					return;
			}
		}

		// --- List / detail view ---
		switch (name) {
			case "q":
			case "CTRL_C": {
				cleanup();
				term.processExit(0);
				resolve();
				return;
			}

			case "UP":
			case "k": {
				if (state.cursor > 0) {
					state.cursor--;
					ensureCursorVisible(state, viewHeight);
					render(state, lines);
				}
				return;
			}

			case "DOWN":
			case "j": {
				if (state.cursor < lines.length - 1) {
					state.cursor++;
					ensureCursorVisible(state, viewHeight);
					render(state, lines);
				}
				return;
			}

			case "RIGHT":
			case "l":
			case "ENTER": {
				// On a change line — open diff
				if (isChangeLine(lines, state.cursor)) {
					const line = lines[state.cursor];
					if (line.changeIndex !== undefined) {
						await openDiff(line.repoIndex, line.changeIndex);
					}
					return;
				}
				// On a header line — expand or enter detail
				if (isHeaderLine(lines, state.cursor)) {
					const ri = repoIndexForLine(lines, state.cursor);
					if (ri < 0) return;

					if (state.detailRepo >= 0) {
						// Already in detail, no-op on header
						return;
					}

					if (state.expanded.has(ri)) {
						// Already expanded — enter detail view
						state.detailRepo = ri;
						state.cursor = 0;
						state.scroll = 0;
					} else {
						// Expand
						state.expanded.add(ri);
					}
					fullRender();
				}
				return;
			}

			case "LEFT":
			case "h":
			case "ESCAPE": {
				if (state.detailRepo >= 0) {
					const prevRepo = state.detailRepo;
					state.detailRepo = -1;
					state.cursor = 0;
					state.scroll = 0;
					fullRender();
					// Restore cursor to the header of the repo we were viewing
					for (let li = 0; li < lines.length; li++) {
						if (lines[li].type === "header" && lines[li].repoIndex === prevRepo) {
							state.cursor = li;
							ensureCursorVisible(state, viewHeight);
							render(state, lines);
							break;
						}
					}
					return;
				}
				// In list view — collapse current repo if on its lines
				const ri = repoIndexForLine(lines, state.cursor);
				if (ri >= 0 && state.expanded.has(ri)) {
					state.expanded.delete(ri);
					fullRender();
				}
				return;
			}

			case "r": {
				try {
					const refreshed = await onRefresh();
					state.repos = refreshed;
					state.detailRepo = -1;
					state.diffView = null;
					if (!handleEmpty()) {
						fullRender();
					}
				} catch (err) {
					logger.error("Refresh failed", { error: String(err) });
				}
				return;
			}

			default:
				return;
		}
	});

	term.on("resize", (_width: number, _height: number) => {
		if (!handleEmpty()) {
			fullRender();
		}
	});

	// Auto-refresh every 5 seconds
	refreshTimer = setInterval(async () => {
		try {
			const refreshed = await onRefresh();
			state.repos = refreshed;
			// Don't reset view mode on auto-refresh — just update data in place
			if (!handleEmpty()) {
				fullRender();
			}
		} catch (err) {
			logger.error("Auto-refresh failed", { error: String(err) });
		}
	}, 5000);

	return promise;
}
