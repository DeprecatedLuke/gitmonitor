import terminalKit from "terminal-kit";
import * as logger from "./logger";
import type { CommitEntry, FileDiffStat, ScanResult } from "./scanner";
import { getCommitFileDiff, getCommitFiles } from "./scanner";

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

const EMPTY_MESSAGE = "No git repositories with commits found";
const SCROLL_LINES = 3;
const REFRESH_MS = 5000;
const IDENTITY_SEPARATOR = "\u0000";

// --- Line model ---

type Line =
	| { kind: "commit"; commitIndex: number; text: string }
	| { kind: "file"; commitIndex: number; fileIndex: number; text: string }
	| { kind: "diff"; commitIndex: number; fileIndex: number; text: string }
	| { kind: "empty"; text: string }
	| { kind: "message"; text: string };

type ViewState = {
	scan: ScanResult;
	cursor: number;
	scroll: number;
	/** commit indexes whose file list is shown */
	expandedCommits: Set<number>;
	/** Cache of file stats by commit hash */
	filesCache: Map<string, FileDiffStat[]>;
	/** commit hashes whose file list is loading */
	filesLoading: Set<string>;
	/** "<commitIndex>:<fileIndex>" whose diff is shown */
	expandedFiles: Set<string>;
	/** Cache of diff text by the same "<commitIndex>:<fileIndex>" key */
	diffCache: Map<string, string>;
};

type LineContext = {
	commitIndex: number;
	fileIndex?: number;
	insideFile: boolean;
};

// --- ANSI-aware text helpers ---

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

function truncateRow(s: string, width: number): string {
	if (width <= 0) return "";
	if (visibleLength(s) <= width) return s;
	if (width === 1) return "…";
	return `${truncateAnsi(s, width - 1)}…`;
}

// --- Line building ---

function fileKey(commitIndex: number, fileIndex: number): string {
	return `${commitIndex}:${fileIndex}`;
}

function parseFileKey(key: string): { commitIndex: number; fileIndex: number } | null {
	const separator = key.indexOf(":");
	if (separator < 1 || separator === key.length - 1) return null;

	const commitIndex = Number.parseInt(key.slice(0, separator), 10);
	const fileIndex = Number.parseInt(key.slice(separator + 1), 10);
	if (!Number.isInteger(commitIndex) || !Number.isInteger(fileIndex)) return null;
	if (commitIndex < 0 || fileIndex < 0) return null;

	return { commitIndex, fileIndex };
}

function identityKey(hash: string, path: string): string {
	return `${hash}${IDENTITY_SEPARATOR}${path}`;
}

function centerDimMessage(text: string, width: number): string {
	const padding = " ".repeat(Math.max(0, Math.floor((width - text.length) / 2)));
	return `${padding}${DIM}${text}${RESET}`;
}

function colorDiffLine(raw: string): string {
	if (raw === "Binary file differs") return `${DIM}${raw}${RESET}`;
	if (raw.startsWith("+++") || raw.startsWith("---")) return `${BOLD}${raw}${RESET}`;
	if (raw.startsWith("@@ ")) return `${CYAN}${raw}${RESET}`;
	if (raw.startsWith("+")) return `${GREEN}${raw}${RESET}`;
	if (raw.startsWith("-")) return `${RED}${raw}${RESET}`;
	return raw;
}

function formatCommitLine(commit: CommitEntry, expanded: boolean): string {
	const arrow = expanded ? "▼" : "▶";
	return ` ${arrow} ${BOLD}${commit.repoLabel}${RESET}/${YELLOW}${commit.shortHash}${RESET}${DIM} - ${RESET}${commit.subject}`;
}

function formatFileLine(file: FileDiffStat, expanded: boolean): string {
	const arrow = expanded ? "▼" : "▶";
	const parts: string[] = [];
	if (file.added > 0) parts.push(`${GREEN}+${file.added}${RESET}`);
	if (file.deleted > 0) parts.push(`${RED}-${file.deleted}${RESET}`);
	const stats = parts.length > 0 ? ` ${parts.join(" ")}` : "";
	return `    ${arrow} ${file.path}${stats}`;
}

function buildLines(state: ViewState, width: number): Line[] {
	if (state.scan.commits.length === 0) {
		return [{ kind: "message", text: centerDimMessage(EMPTY_MESSAGE, width) }];
	}

	const lines: Line[] = [];
	for (let commitIndex = 0; commitIndex < state.scan.commits.length; commitIndex++) {
		const commit = state.scan.commits[commitIndex];
		const commitExpanded = state.expandedCommits.has(commitIndex);
		lines.push({
			kind: "commit",
			commitIndex,
			text: formatCommitLine(commit, commitExpanded),
		});

		if (!commitExpanded) continue;

		const files = state.filesCache.get(commit.hash);
		if (files === undefined) {
			lines.push({ kind: "message", text: `    ${DIM}Loading files…${RESET}` });
			continue;
		}

		if (files.length === 0) {
			lines.push({ kind: "message", text: `    ${DIM}(no file changes)${RESET}` });
			continue;
		}

		for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
			const file = files[fileIndex];
			const key = fileKey(commitIndex, fileIndex);
			const fileExpanded = state.expandedFiles.has(key);
			lines.push({
				kind: "file",
				commitIndex,
				fileIndex,
				text: formatFileLine(file, fileExpanded),
			});

			if (!fileExpanded) continue;

			const diffText = state.diffCache.get(key);
			if (diffText === undefined) {
				lines.push({ kind: "message", text: `      ${DIM}Loading diff…${RESET}` });
				continue;
			}

			for (const raw of diffText.split("\n")) {
				lines.push({
					kind: "diff",
					commitIndex,
					fileIndex,
					text: `      ${colorDiffLine(raw)}`,
				});
			}
		}
	}

	return lines;
}

function lineContext(lines: Line[], lineIndex: number): LineContext | null {
	const line = lines[lineIndex];
	if (!line) return null;

	if (line.kind === "commit") {
		return { commitIndex: line.commitIndex, insideFile: false };
	}
	if (line.kind === "file" || line.kind === "diff") {
		return { commitIndex: line.commitIndex, fileIndex: line.fileIndex, insideFile: true };
	}

	for (let i = lineIndex - 1; i >= 0; i--) {
		const previous = lines[i];
		if (previous.kind === "file") {
			return { commitIndex: previous.commitIndex, fileIndex: previous.fileIndex, insideFile: true };
		}
		if (previous.kind === "commit") {
			return { commitIndex: previous.commitIndex, insideFile: false };
		}
	}

	return null;
}

function cursorCommitHash(state: ViewState, lines: Line[]): string | undefined {
	const context = lineContext(lines, state.cursor);
	if (!context) return undefined;
	return state.scan.commits[context.commitIndex]?.hash;
}

// --- Rendering ---

function statusLine(state: ViewState, lineCount: number): string {
	const repoCount = state.scan.repoCount;
	const commitCount = state.scan.commits.length;
	const cursor = Math.min(state.cursor + 1, lineCount);
	return ` ${INVERSE} gitmonitor ${RESET} ${DIM}${repoCount} repos · ${commitCount} commits · ${cursor}/${lineCount} · q:quit r:refresh${RESET}`;
}

function render(state: ViewState, lines: Line[]): void {
	const w = term.width;
	const h = term.height;

	if (w < 40 || h < 4) {
		term.clear();
		term.moveTo(1, 1);
		term.styleReset();
		term("Terminal too small");
		return;
	}

	const viewHeight = h - 1;
	const emptyScan = state.scan.commits.length === 0;

	for (let row = 0; row < viewHeight; row++) {
		const lineIndex = state.scroll + row;
		term.moveTo(1, row + 1);
		term.styleReset();
		term.eraseLine();

		if (lineIndex >= lines.length) continue;

		const line = lines[lineIndex];
		const content = truncateRow(line.text, w);
		const isCursor = !emptyScan && lineIndex === state.cursor;

		if (isCursor) {
			term(INVERSE + content + RESET);
		} else {
			term(content);
		}
	}

	term.moveTo(1, h);
	term.styleReset();
	term.eraseLine();
	term(truncateRow(statusLine(state, lines.length), w));
}

// --- Scroll management ---

function viewHeight(): number {
	return Math.max(1, term.height - 1);
}

function ensureCursorVisible(state: ViewState, height: number, lineCount: number): void {
	if (state.cursor < state.scroll) {
		state.scroll = state.cursor;
	} else if (state.cursor >= state.scroll + height) {
		state.scroll = state.cursor - height + 1;
	}

	const maxScroll = Math.max(0, lineCount - height);
	state.scroll = Math.max(0, Math.min(state.scroll, maxScroll));
}

function clampCursorAndScroll(state: ViewState, lines: Line[]): void {
	const height = viewHeight();
	const maxCursor = Math.max(0, lines.length - 1);
	state.cursor = Math.max(0, Math.min(state.cursor, maxCursor));
	ensureCursorVisible(state, height, lines.length);
}

function moveCursor(state: ViewState, lines: Line[], delta: number): void {
	const maxCursor = Math.max(0, lines.length - 1);
	state.cursor = Math.max(0, Math.min(state.cursor + delta, maxCursor));
	ensureCursorVisible(state, viewHeight(), lines.length);
}

// --- Refresh state remapping ---

function collectExpandedCommitHashes(state: ViewState): Set<string> {
	const hashes = new Set<string>();
	for (const commitIndex of state.expandedCommits) {
		const commit = state.scan.commits[commitIndex];
		if (commit) hashes.add(commit.hash);
	}
	return hashes;
}

function collectExpandedFileIdentities(state: ViewState): Set<string> {
	const identities = new Set<string>();
	for (const key of state.expandedFiles) {
		const parsed = parseFileKey(key);
		if (!parsed) continue;
		const commit = state.scan.commits[parsed.commitIndex];
		const files = commit === undefined ? undefined : state.filesCache.get(commit.hash);
		const file = files?.[parsed.fileIndex];
		if (commit && file) identities.add(identityKey(commit.hash, file.path));
	}
	return identities;
}

function collectDiffCacheByIdentity(state: ViewState): Map<string, string> {
	const cache = new Map<string, string>();
	for (const [key, diffText] of state.diffCache) {
		const parsed = parseFileKey(key);
		if (!parsed) continue;
		const commit = state.scan.commits[parsed.commitIndex];
		const files = commit === undefined ? undefined : state.filesCache.get(commit.hash);
		const file = files?.[parsed.fileIndex];
		if (commit && file) cache.set(identityKey(commit.hash, file.path), diffText);
	}
	return cache;
}

function remapStateForScan(state: ViewState, nextScan: ScanResult): void {
	const expandedCommitHashes = collectExpandedCommitHashes(state);
	const expandedFileIdentities = collectExpandedFileIdentities(state);
	const cacheByIdentity = collectDiffCacheByIdentity(state);
	const nextCommitHashes = new Set(nextScan.commits.map(commit => commit.hash));
	const nextFilesCache = new Map<string, FileDiffStat[]>();
	const nextFilesLoading = new Set<string>();

	for (const [hash, files] of state.filesCache) {
		if (nextCommitHashes.has(hash)) nextFilesCache.set(hash, files);
	}
	for (const hash of state.filesLoading) {
		if (nextCommitHashes.has(hash)) nextFilesLoading.add(hash);
	}

	state.scan = nextScan;
	state.expandedCommits = new Set<number>();
	state.filesCache = nextFilesCache;
	state.filesLoading = nextFilesLoading;
	state.expandedFiles = new Set<string>();
	state.diffCache = new Map<string, string>();

	for (let commitIndex = 0; commitIndex < state.scan.commits.length; commitIndex++) {
		const commit = state.scan.commits[commitIndex];
		if (expandedCommitHashes.has(commit.hash)) {
			state.expandedCommits.add(commitIndex);
		}

		const files = state.filesCache.get(commit.hash) ?? [];
		for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
			const file = files[fileIndex];
			const identity = identityKey(commit.hash, file.path);
			const key = fileKey(commitIndex, fileIndex);

			if (expandedFileIdentities.has(identity)) {
				state.expandedCommits.add(commitIndex);
				state.expandedFiles.add(key);
			}

			if (cacheByIdentity.has(identity)) {
				state.diffCache.set(key, cacheByIdentity.get(identity) ?? "");
			}
		}
	}
}

function findCommitLine(lines: Line[], commitIndex: number): number {
	return lines.findIndex(line => line.kind === "commit" && line.commitIndex === commitIndex);
}

function restoreCursorAfterRefresh(
	state: ViewState,
	lines: Line[],
	hash: string | undefined,
	fallbackCursor: number,
): void {
	if (hash) {
		const commitIndex = state.scan.commits.findIndex(commit => commit.hash === hash);
		if (commitIndex >= 0) {
			const lineIndex = findCommitLine(lines, commitIndex);
			if (lineIndex >= 0) {
				state.cursor = lineIndex;
				return;
			}
		}
	}

	state.cursor = fallbackCursor;
}

// --- Main entry point ---

export async function startTui(initial: ScanResult, onRefresh: () => Promise<ScanResult>): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();

	const state: ViewState = {
		scan: initial,
		cursor: 0,
		scroll: 0,
		expandedCommits: new Set(),
		expandedFiles: new Set(),
		diffCache: new Map(),
		filesCache: new Map(),
		filesLoading: new Set(),
	};

	const loadingDiffs = new Set<string>();
	let lines = buildLines(state, term.width);
	let refreshTimer: NodeJS.Timeout | undefined;
	let refreshing = false;

	function fullRender(): void {
		lines = buildLines(state, term.width);
		clampCursorAndScroll(state, lines);
		render(state, lines);
	}

	async function loadFilesForCommit(commitIndex: number): Promise<void> {
		const commit = state.scan.commits[commitIndex];
		if (!commit || state.filesCache.has(commit.hash) || state.filesLoading.has(commit.hash)) return;

		state.filesLoading.add(commit.hash);
		let shouldRender = false;
		try {
			const files = await getCommitFiles(commit.repoPath, commit.hash);
			const currentIndex = state.scan.commits.findIndex(current => current.hash === commit.hash);
			if (currentIndex !== -1) {
				state.filesCache.set(commit.hash, files);
				shouldRender = state.expandedCommits.has(currentIndex);
			}
		} catch (err) {
			logger.error("File list load failed", {
				repoPath: commit.repoPath,
				hash: commit.hash,
				error: String(err),
			});
			const currentIndex = state.scan.commits.findIndex(current => current.hash === commit.hash);
			if (currentIndex !== -1) {
				state.filesCache.set(commit.hash, []);
				shouldRender = state.expandedCommits.has(currentIndex);
			}
		} finally {
			state.filesLoading.delete(commit.hash);
		}

		if (shouldRender) fullRender();
	}

	function startMissingFileLoads(): void {
		for (const commitIndex of state.expandedCommits) {
			void loadFilesForCommit(commitIndex);
		}
	}

	function collapseCommit(commitIndex: number): void {
		state.expandedCommits.delete(commitIndex);
		for (const key of [...state.expandedFiles]) {
			const parsed = parseFileKey(key);
			if (parsed?.commitIndex === commitIndex) state.expandedFiles.delete(key);
		}
	}

	function collapseFile(commitIndex: number, fileIndex: number): void {
		state.expandedFiles.delete(fileKey(commitIndex, fileIndex));
	}

	async function loadDiffForKey(key: string): Promise<void> {
		if (loadingDiffs.has(key) || state.diffCache.has(key)) return;

		const parsed = parseFileKey(key);
		if (!parsed) return;
		const commit = state.scan.commits[parsed.commitIndex];
		const files = commit === undefined ? undefined : state.filesCache.get(commit.hash);
		const file = files?.[parsed.fileIndex];
		if (!commit || !file) return;

		loadingDiffs.add(key);
		try {
			const diffText = await getCommitFileDiff(commit.repoPath, commit.hash, file.path);
			const currentCommit = state.scan.commits[parsed.commitIndex];
			const currentFiles = currentCommit === undefined ? undefined : state.filesCache.get(currentCommit.hash);
			const currentFile = currentFiles?.[parsed.fileIndex];
			if (state.expandedFiles.has(key) && currentCommit?.hash === commit.hash && currentFile?.path === file.path) {
				state.diffCache.set(key, diffText);
				fullRender();
			}
		} catch (err) {
			logger.error("Diff load failed", {
				repoPath: commit.repoPath,
				hash: commit.hash,
				filePath: file.path,
				error: String(err),
			});
			if (state.expandedFiles.has(key)) {
				state.expandedFiles.delete(key);
				fullRender();
			}
		} finally {
			loadingDiffs.delete(key);
		}
	}

	function startMissingDiffLoads(): void {
		for (const key of state.expandedFiles) {
			if (!state.diffCache.has(key)) {
				void loadDiffForKey(key);
			}
		}
	}

	function toggleCommit(commitIndex: number): void {
		let shouldLoad = false;
		if (state.expandedCommits.has(commitIndex)) {
			collapseCommit(commitIndex);
		} else {
			state.expandedCommits.add(commitIndex);
			shouldLoad = true;
		}
		fullRender();
		if (shouldLoad) void loadFilesForCommit(commitIndex);
	}

	function toggleFile(commitIndex: number, fileIndex: number): void {
		const key = fileKey(commitIndex, fileIndex);
		if (state.expandedFiles.has(key)) {
			state.expandedFiles.delete(key);
			fullRender();
			return;
		}

		state.expandedFiles.add(key);
		fullRender();
		void loadDiffForKey(key);
	}

	async function handleForward(): Promise<void> {
		const line = lines[state.cursor];
		if (!line) return;

		if (line.kind === "commit") {
			toggleCommit(line.commitIndex);
			return;
		}

		if (line.kind === "file") {
			toggleFile(line.commitIndex, line.fileIndex);
		}
	}

	function handleBack(): void {
		const line = lines[state.cursor];
		const context = lineContext(lines, state.cursor);
		if (!line || !context) return;

		if ((line.kind === "diff" || line.kind === "message") && context.insideFile && context.fileIndex !== undefined) {
			collapseFile(context.commitIndex, context.fileIndex);
			fullRender();
			return;
		}

		if (state.expandedCommits.has(context.commitIndex)) {
			collapseCommit(context.commitIndex);
			fullRender();
		}
	}

	async function refreshScan(kind: "manual" | "auto"): Promise<void> {
		if (refreshing) return;
		refreshing = true;
		const hash = cursorCommitHash(state, lines);
		const fallbackCursor = state.cursor;

		try {
			const refreshed = await onRefresh();
			remapStateForScan(state, refreshed);
			lines = buildLines(state, term.width);
			restoreCursorAfterRefresh(state, lines, hash, fallbackCursor);
			clampCursorAndScroll(state, lines);
			render(state, lines);
			startMissingFileLoads();
			startMissingDiffLoads();
		} catch (err) {
			logger.error(kind === "auto" ? "Auto-refresh failed" : "Refresh failed", { error: String(err) });
		} finally {
			refreshing = false;
		}
	}

	function cleanup(): void {
		if (refreshTimer) clearInterval(refreshTimer);
		term.styleReset();
		term.fullscreen(false);
		term.hideCursor(false);
		term.grabInput(false);
	}

	// Setup terminal
	term.fullscreen(true);
	term.hideCursor();
	term.grabInput({ mouse: "button" });
	fullRender();

	// --- Keyboard input ---

	term.on("key", async (name: string) => {
		switch (name) {
			case "q":
			case "CTRL_C":
				cleanup();
				term.processExit(0);
				resolve();
				return;
			case "UP":
			case "k":
				moveCursor(state, lines, -1);
				render(state, lines);
				return;
			case "DOWN":
			case "j":
				moveCursor(state, lines, 1);
				render(state, lines);
				return;
			case "PAGE_UP":
				moveCursor(state, lines, -viewHeight());
				render(state, lines);
				return;
			case "PAGE_DOWN":
				moveCursor(state, lines, viewHeight());
				render(state, lines);
				return;
			case "RIGHT":
			case "l":
			case "ENTER":
				await handleForward();
				return;
			case "LEFT":
			case "h":
			case "ESCAPE":
				handleBack();
				return;
			case "r":
				await refreshScan("manual");
				return;
			default:
				return;
		}
	});

	// --- Mouse input ---

	term.on("mouse", async (name: string, data: { x: number; y: number }) => {
		const height = viewHeight();

		switch (name) {
			case "MOUSE_WHEEL_UP":
				moveCursor(state, lines, -SCROLL_LINES);
				render(state, lines);
				return;
			case "MOUSE_WHEEL_DOWN":
				moveCursor(state, lines, SCROLL_LINES);
				render(state, lines);
				return;
			case "MOUSE_LEFT_BUTTON_PRESSED": {
				if (data.y < 1 || data.y > height) return;
				const lineIndex = state.scroll + (data.y - 1);
				if (lineIndex < 0 || lineIndex >= lines.length) return;
				state.cursor = lineIndex;
				ensureCursorVisible(state, height, lines.length);
				render(state, lines);
				await handleForward();
				return;
			}
			case "MOUSE_RIGHT_BUTTON_PRESSED":
				handleBack();
				return;
			default:
				return;
		}
	});

	term.on("resize", () => {
		fullRender();
	});

	refreshTimer = setInterval(() => {
		void refreshScan("auto");
	}, REFRESH_MS);

	return promise;
}
