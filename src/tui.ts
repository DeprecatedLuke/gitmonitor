import terminalKit from "terminal-kit";
import type { RepoInfo } from "./git";
import { getCommitDetail, getCommitFileDiff, getFileDiff } from "./git";
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
	/** Index into RepoInfo.commits, set on commit lines */
	commitIndex?: number;
	/** Commit hash, set on file lines within commit detail view */
	commitHash?: string;
};

// --- Diff view state ---

type DiffView = {
	repoIndex: number;
	lines: Line[];
	cursor: number;
	scroll: number;
	/** Which mode to return to */
	previousMode: "list" | "detail" | "commitView";
};

type CommitView = {
	repoIndex: number;
	commitIndex: number;
	lines: Line[];
	cursor: number;
	scroll: number;
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
	commitView: CommitView | null;
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
				for (let ci = 0; ci < repo.commits.length; ci++) {
					const commit = repo.commits[ci];
					const hash = `${YELLOW}${commit.hash}${RESET}`;
					const subject = commit.subject;
					const date = `${DIM}${commit.date}${RESET}`;
					lines.push({
						type: "commit",
						repoIndex: i,
						commitIndex: ci,
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
		for (let ci = 0; ci < repo.commits.length; ci++) {
			const commit = repo.commits[ci];
			const hash = `${YELLOW}${commit.hash}${RESET}`;
			const author = `${MAGENTA}${commit.author}${RESET}`;
			const date = `${DIM}${commit.date}${RESET}`;
			lines.push({
				type: "commit",
				repoIndex: state.detailRepo,
				commitIndex: ci,
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

function buildCommitDetailLines(
	repoIndex: number,
	detail: {
		hash: string;
		subject: string;
		body: string;
		author: string;
		date: string;
		files: { path: string; added: number; deleted: number; status: string }[];
	},
): Line[] {
	const lines: Line[] = [];
	lines.push({
		type: "header",
		repoIndex,
		text: ` ${BOLD}${YELLOW}${detail.hash.slice(0, 7)}${RESET} ${detail.subject}`,
	});
	lines.push({ type: "empty", repoIndex, text: "" });
	lines.push({
		type: "message",
		repoIndex,
		text: ` ${MAGENTA}${detail.author}${RESET}  ${DIM}${detail.date}${RESET}`,
	});
	if (detail.body) {
		lines.push({ type: "empty", repoIndex, text: "" });
		for (const bodyLine of detail.body.split("\n")) {
			lines.push({ type: "message", repoIndex, text: ` ${DIM}${bodyLine}${RESET}` });
		}
	}
	lines.push({ type: "empty", repoIndex, text: "" });
	lines.push({ type: "section", repoIndex, text: ` ${BOLD}Files (${detail.files.length}):${RESET}` });
	for (let fi = 0; fi < detail.files.length; fi++) {
		const f = detail.files[fi];
		const parts: string[] = [];
		if (f.added > 0) parts.push(`${GREEN}+${f.added}${RESET}`);
		if (f.deleted > 0) parts.push(`${RED}-${f.deleted}${RESET}`);
		const diffStr = parts.length > 0 ? `  ${parts.join(" ")}` : "";
		lines.push({
			type: "change",
			repoIndex,
			changeIndex: fi,
			commitHash: detail.hash,
			text: `   ${f.path}${diffStr}`,
		});
	}
	return lines;
}

function buildLines(state: ViewState): Line[] {
	if (state.diffView) return state.diffView.lines;
	if (state.commitView) return state.commitView.lines;
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
	if (state.commitView) return "commit";
	if (state.detailRepo >= 0) return "detail";
	return "list";
}

/** Get the active cursor/scroll for the current view. */
function activeView(state: ViewState): { cursor: number; scroll: number } {
	if (state.diffView) return state.diffView;
	if (state.commitView) return state.commitView;
	return state;
}

function render(state: ViewState, lines: Line[]): void {
	const w = term.width;
	const h = term.height;
	const { scroll, cursor } = activeView(state);

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
			content = `${truncateAnsi(content, w - 1)}…`;
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
	const view = activeView(state);
	if (view.cursor < view.scroll) {
		view.scroll = view.cursor;
	} else if (view.cursor >= view.scroll + viewHeight) {
		view.scroll = view.cursor - viewHeight + 1;
	}
}

// --- Input handling ---

function repoIndexForLine(lines: Line[], lineIndex: number): number {
	if (lineIndex < 0 || lineIndex >= lines.length) return -1;
	return lines[lineIndex].repoIndex;
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
		commitView: null,
	};

	let lines = buildLines(state);

	function fullRender(): void {
		lines = buildLines(state);
		const viewHeight = term.height - 1;
		const view = activeView(state);
		if (lines.length === 0) {
			view.cursor = 0;
			view.scroll = 0;
		} else {
			view.cursor = Math.max(0, Math.min(view.cursor, lines.length - 1));
		}
		ensureCursorVisible(state, viewHeight);
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

	async function openDiff(ri: number, filePath: string, status: string): Promise<void> {
		const repo = state.repos[ri];
		if (!repo) return;
		const diffText = await getFileDiff(repo.path, filePath, status);
		const diffLines = buildDiffLines(ri, filePath, diffText);
		let previousMode: DiffView["previousMode"] = "list";
		if (state.commitView) previousMode = "commitView";
		else if (state.detailRepo >= 0) previousMode = "detail";
		state.diffView = { repoIndex: ri, lines: diffLines, cursor: 0, scroll: 0, previousMode };
		lines = diffLines;
		render(state, lines);
	}

	async function openCommitFileDiff(ri: number, hash: string, filePath: string): Promise<void> {
		const repo = state.repos[ri];
		if (!repo) return;
		const diffText = await getCommitFileDiff(repo.path, hash, filePath);
		const diffLines = buildDiffLines(ri, filePath, diffText);
		state.diffView = { repoIndex: ri, lines: diffLines, cursor: 0, scroll: 0, previousMode: "commitView" };
		lines = diffLines;
		render(state, lines);
	}

	async function openCommit(ri: number, ci: number): Promise<void> {
		const repo = state.repos[ri];
		if (!repo || ci < 0 || ci >= repo.commits.length) return;
		const commit = repo.commits[ci];
		const detail = await getCommitDetail(repo.path, commit.hash);
		const commitLines = buildCommitDetailLines(ri, detail);
		const previousMode: CommitView["previousMode"] = state.detailRepo >= 0 ? "detail" : "list";
		state.commitView = { repoIndex: ri, commitIndex: ci, lines: commitLines, cursor: 0, scroll: 0, previousMode };
		lines = commitLines;
		render(state, lines);
	}

	function closeDiff(): void {
		if (!state.diffView) return;
		const prev = state.diffView.previousMode;
		state.diffView = null;
		if (prev === "commitView") {
			// Return to commit view — lines are still there
			if (state.commitView) {
				lines = state.commitView.lines;
				render(state, lines);
				return;
			}
		}
		fullRender();
	}

	function closeCommit(): void {
		if (!state.commitView) return;
		state.commitView = null;
		fullRender();
	}

	// Setup terminal
	term.fullscreen(true);
	term.hideCursor();
	term.grabInput({ mouse: false as never });

	if (!handleEmpty()) {
		fullRender();
	}

	term.on("key", async (name: string) => {
		const viewHeight = term.height - 1;
		const view = activeView(state);

		// --- Universal keys ---
		switch (name) {
			case "q":
			case "CTRL_C":
				cleanup();
				term.processExit(0);
				resolve();
				return;
			case "UP":
			case "k":
				if (view.cursor > 0) {
					view.cursor--;
					ensureCursorVisible(state, viewHeight);
					render(state, lines);
				}
				return;
			case "DOWN":
			case "j":
				if (view.cursor < lines.length - 1) {
					view.cursor++;
					ensureCursorVisible(state, viewHeight);
					render(state, lines);
				}
				return;
			case "PAGE_UP":
				view.cursor = Math.max(0, view.cursor - viewHeight);
				ensureCursorVisible(state, viewHeight);
				render(state, lines);
				return;
			case "PAGE_DOWN":
				view.cursor = Math.min(lines.length - 1, view.cursor + viewHeight);
				ensureCursorVisible(state, viewHeight);
				render(state, lines);
				return;
		}

		// --- Diff view: only LEFT to close ---
		if (state.diffView) {
			if (name === "LEFT" || name === "h" || name === "ESCAPE") {
				closeDiff();
			}
			return;
		}

		// --- Commit view: LEFT to close, RIGHT on file to open diff ---
		if (state.commitView) {
			switch (name) {
				case "LEFT":
				case "h":
				case "ESCAPE":
					closeCommit();
					return;
				case "RIGHT":
				case "l":
				case "ENTER": {
					const line = lines[state.commitView.cursor];
					if (line?.type === "change" && line.commitHash) {
						const repo = state.repos[line.repoIndex];
						if (repo) {
							// Find the file path from the line text (strip ANSI + leading spaces)
							const filePath = line.text
								.replace(/\x1b\[[0-9;]*m/g, "")
								.trim()
								.split("  ")[0];
							await openCommitFileDiff(line.repoIndex, line.commitHash, filePath);
						}
					}
					return;
				}
			}
			return;
		}

		// --- List / detail view ---
		switch (name) {
			case "RIGHT":
			case "l":
			case "ENTER": {
				const line = lines[state.cursor];
				if (!line) return;

				// On a change line — open diff
				if (line.type === "change" && line.changeIndex !== undefined) {
					const repo = state.repos[line.repoIndex];
					if (repo) {
						const change = repo.changes[line.changeIndex];
						if (change) await openDiff(line.repoIndex, change.path, change.status);
					}
					return;
				}

				// On a commit line — open commit detail
				if (line.type === "commit" && line.commitIndex !== undefined) {
					await openCommit(line.repoIndex, line.commitIndex);
					return;
				}

				// On a header line — expand or enter detail
				if (line.type === "header") {
					const ri = line.repoIndex;
					if (state.detailRepo >= 0) return; // already in detail
					if (state.expanded.has(ri)) {
						state.detailRepo = ri;
						state.cursor = 0;
						state.scroll = 0;
					} else {
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
					state.commitView = null;
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
