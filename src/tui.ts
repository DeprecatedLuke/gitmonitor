import terminalKit from "terminal-kit";
import * as logger from "./logger";
import type { CommitEntry, DiffLine, FileDiff, FileDiffStat, ScanResult } from "./scanner";
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
const HUNK_CONTEXT = 3;
const PREFIX_WIDTH = 32;
const TIME_WIDTH = 6;
// --- Line model ---

type Line =
	| { kind: "commit"; commitIndex: number; text: string }
	| { kind: "file"; commitIndex: number; fileIndex: number; text: string }
	| { kind: "diff"; commitIndex: number; fileIndex: number; text: string }
	| { kind: "empty"; text: string }
	| { kind: "message"; text: string };

type FileExpansionMode = "hunks" | "full";

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
	/** "<commitHash>:<filePath>" expanded rendering mode */
	expandedFiles: Map<string, FileExpansionMode>;
	/** Cache of structured file diffs by the same "<commitHash>:<filePath>" key */
	diffCache: Map<string, FileDiff>;
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

function fileKey(commitHash: string, filePath: string): string {
	return `${commitHash}:${filePath}`;
}

function parseFileKey(key: string): { hash: string; path: string } | null {
	const separator = key.indexOf(":");
	if (separator < 1 || separator === key.length - 1) return null;

	return { hash: key.slice(0, separator), path: key.slice(separator + 1) };
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
	const coloredPrefix = `${BOLD}${commit.repoLabel}${RESET}/${YELLOW}${commit.shortHash}${RESET}`;
	const prefixLength = visibleLength(coloredPrefix);
	const paddedPrefix =
		prefixLength > PREFIX_WIDTH
			? `${truncateAnsi(coloredPrefix, PREFIX_WIDTH - 1)}…`
			: `${coloredPrefix}${" ".repeat(PREFIX_WIDTH - prefixLength)}`;
	const paddedTime = commit.dateRelative.padStart(TIME_WIDTH, " ");

	return ` ${arrow} ${DIM}${paddedTime}${RESET}  ${paddedPrefix}  ${commit.subject}`;
}

function formatFileLine(file: FileDiffStat, expanded: boolean): string {
	const arrow = expanded ? "▼" : "▶";
	const parts: string[] = [];
	if (file.added > 0) parts.push(`${GREEN}+${file.added}${RESET}`);
	if (file.deleted > 0) parts.push(`${RED}-${file.deleted}${RESET}`);
	const stats = parts.length > 0 ? ` ${parts.join(" ")}` : "";
	return `    ${arrow} ${file.path}${stats}`;
}

type DiffRenderLine = { kind: "diff"; text: string } | { kind: "message"; text: string };

type HunkRange = {
	start: number;
	end: number;
};

function diffMessage(text: string): DiffRenderLine {
	return { kind: "message", text: `      ${DIM}${text}${RESET}` };
}

function diffContent(raw: string): DiffRenderLine {
	return { kind: "diff", text: `      ${colorDiffLine(raw)}` };
}

function unreachable(value: unknown): never {
	throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

function prefixedDiffLine(op: DiffLine): string {
	switch (op.kind) {
		case "equal":
			return ` ${op.line}`;
		case "add":
			return `+${op.line}`;
		case "delete":
			return `-${op.line}`;
	}

	return unreachable(op);
}

function hunkRanges(ops: DiffLine[]): HunkRange[] {
	const ranges: HunkRange[] = [];

	for (let index = 0; index < ops.length; index++) {
		if (ops[index].kind === "equal") continue;

		const start = Math.max(0, index - HUNK_CONTEXT);
		const end = Math.min(ops.length - 1, index + HUNK_CONTEXT);
		const last = ranges.at(-1);

		if (last && start <= last.end + 1) {
			last.end = Math.max(last.end, end);
			continue;
		}

		ranges.push({ start, end });
	}

	return ranges;
}

function advanceLineNumbers(op: DiffLine, oldLine: number, newLine: number): { oldLine: number; newLine: number } {
	switch (op.kind) {
		case "equal":
			return { oldLine: oldLine + 1, newLine: newLine + 1 };
		case "add":
			return { oldLine, newLine: newLine + 1 };
		case "delete":
			return { oldLine: oldLine + 1, newLine };
	}

	return unreachable(op);
}

function hunkHeader(ops: DiffLine[], range: HunkRange): string {
	let oldLine = 1;
	let newLine = 1;

	for (let index = 0; index < range.start; index++) {
		const next = advanceLineNumbers(ops[index], oldLine, newLine);
		oldLine = next.oldLine;
		newLine = next.newLine;
	}

	let oldStart: number | undefined;
	let newStart: number | undefined;
	let oldLength = 0;
	let newLength = 0;

	for (let index = range.start; index <= range.end; index++) {
		const op = ops[index];
		if (op.kind !== "add") {
			oldStart ??= oldLine;
			oldLength++;
		}
		if (op.kind !== "delete") {
			newStart ??= newLine;
			newLength++;
		}

		const next = advanceLineNumbers(op, oldLine, newLine);
		oldLine = next.oldLine;
		newLine = next.newLine;
	}

	return `@@ -${oldLength === 0 ? 0 : (oldStart ?? 1)},${oldLength} +${newLength === 0 ? 0 : (newStart ?? 1)},${newLength} @@`;
}

function renderFullDiff(ops: DiffLine[]): DiffRenderLine[] {
	if (ops.length === 0) return [diffMessage("(no textual changes)")];

	return ops.map(op => diffContent(prefixedDiffLine(op)));
}

function renderHunkDiff(ops: DiffLine[]): DiffRenderLine[] {
	const ranges = hunkRanges(ops);
	if (ranges.length === 0) return [diffMessage("(no textual changes)")];

	const rendered: DiffRenderLine[] = [];
	for (const range of ranges) {
		rendered.push(diffContent(hunkHeader(ops, range)));
		for (let index = range.start; index <= range.end; index++) {
			rendered.push(diffContent(prefixedDiffLine(ops[index])));
		}
	}

	return rendered;
}

function renderFileDiff(diff: FileDiff, mode: FileExpansionMode): DiffRenderLine[] {
	switch (diff.kind) {
		case "ops":
			return mode === "full" ? renderFullDiff(diff.ops) : renderHunkDiff(diff.ops);
		case "binary":
			return [diffMessage("Binary file differs")];
		case "oversized":
			return [diffMessage("(diff too large)")];
		case "unavailable":
			return [diffMessage(`(diff unavailable: ${diff.message})`)];
	}

	return unreachable(diff);
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
			const key = fileKey(commit.hash, file.path);
			const fileMode = state.expandedFiles.get(key);
			lines.push({
				kind: "file",
				commitIndex,
				fileIndex,
				text: formatFileLine(file, fileMode !== undefined),
			});

			if (fileMode === undefined) continue;

			const diff = state.diffCache.get(key);
			if (diff === undefined) {
				lines.push({ kind: "message", text: `      ${DIM}Loading diff…${RESET}` });
				continue;
			}

			for (const rendered of renderFileDiff(diff, fileMode)) {
				if (rendered.kind === "diff") {
					lines.push({
						kind: "diff",
						commitIndex,
						fileIndex,
						text: rendered.text,
					});
					continue;
				}

				lines.push({ kind: "message", text: rendered.text });
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

type CursorAnchor =
	| { kind: "commit"; hash: string }
	| { kind: "file"; hash: string; path: string }
	| { kind: "diff"; hash: string; path: string; offset: number };

type FileIdentity = {
	hash: string;
	path: string;
	key: string;
};

function fileIdentityAt(state: ViewState, commitIndex: number, fileIndex: number): FileIdentity | null {
	const commit = state.scan.commits[commitIndex];
	const files = commit === undefined ? undefined : state.filesCache.get(commit.hash);
	const file = files?.[fileIndex];
	if (commit === undefined || file === undefined) return null;

	return { hash: commit.hash, path: file.path, key: fileKey(commit.hash, file.path) };
}

function diffOffset(lines: Line[], lineIndex: number, line: Extract<Line, { kind: "diff" }>): number {
	let offset = 0;

	for (let index = lineIndex - 1; index >= 0; index--) {
		const previous = lines[index];
		if (
			previous.kind === "file" &&
			previous.commitIndex === line.commitIndex &&
			previous.fileIndex === line.fileIndex
		) {
			return offset;
		}
		if (previous.kind === "commit" || previous.kind === "file") break;
		if (
			previous.kind === "diff" &&
			previous.commitIndex === line.commitIndex &&
			previous.fileIndex === line.fileIndex
		) {
			offset++;
		}
	}

	return offset;
}

function cursorAnchor(state: ViewState, lines: Line[]): CursorAnchor | null {
	const line = lines[state.cursor];
	if (line === undefined) return null;

	if (line.kind === "commit") {
		const commit = state.scan.commits[line.commitIndex];
		return commit === undefined ? null : { kind: "commit", hash: commit.hash };
	}

	if (line.kind === "file") {
		const identity = fileIdentityAt(state, line.commitIndex, line.fileIndex);
		return identity === null ? null : { kind: "file", hash: identity.hash, path: identity.path };
	}

	if (line.kind === "diff") {
		const identity = fileIdentityAt(state, line.commitIndex, line.fileIndex);
		return identity === null
			? null
			: { kind: "diff", hash: identity.hash, path: identity.path, offset: diffOffset(lines, state.cursor, line) };
	}

	const context = lineContext(lines, state.cursor);
	const commit = context === null ? undefined : state.scan.commits[context.commitIndex];
	return commit === undefined ? null : { kind: "commit", hash: commit.hash };
}

function lineMatchesFileAnchor(state: ViewState, line: Line, anchor: { hash: string; path: string }): boolean {
	if (line.kind !== "file") return false;
	const identity = fileIdentityAt(state, line.commitIndex, line.fileIndex);
	return identity !== null && identity.hash === anchor.hash && identity.path === anchor.path;
}

function findAnchorLine(state: ViewState, lines: Line[], anchor: CursorAnchor): number | null {
	if (anchor.kind === "commit") {
		return lines.findIndex(line => {
			if (line.kind !== "commit") return false;
			return state.scan.commits[line.commitIndex]?.hash === anchor.hash;
		});
	}

	if (anchor.kind === "file") {
		const fileIndex = lines.findIndex(line => lineMatchesFileAnchor(state, line, anchor));
		return fileIndex === -1 ? null : fileIndex;
	}

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!lineMatchesFileAnchor(state, line, anchor)) continue;

		let offset = 0;
		for (let childIndex = index + 1; childIndex < lines.length; childIndex++) {
			const child = lines[childIndex];
			if (child.kind === "commit" || child.kind === "file") break;
			if (child.kind !== "diff") continue;

			const identity = fileIdentityAt(state, child.commitIndex, child.fileIndex);
			if (identity === null || identity.hash !== anchor.hash || identity.path !== anchor.path) continue;
			if (offset === anchor.offset) return childIndex;
			offset++;
		}

		return null;
	}

	return null;
}

function withAnchoredRefresh(state: ViewState, currentLines: Line[], fn: () => Line[]): Line[] {
	const anchor = cursorAnchor(state, currentLines);
	const viewportOffset = state.cursor - state.scroll;
	const nextLines = fn();
	const matchedIndex = anchor === null ? null : findAnchorLine(state, nextLines, anchor);

	if (matchedIndex !== null && matchedIndex >= 0) {
		state.cursor = matchedIndex;
		const clampedOffset = Math.max(0, Math.min(viewportOffset, viewHeight() - 1));
		state.scroll = Math.max(0, matchedIndex - clampedOffset);
		ensureCursorVisible(state, viewHeight(), nextLines.length);
		return nextLines;
	}

	clampCursorAndScroll(state, nextLines);
	return nextLines;
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

function collectExpandedFileHashes(expandedFiles: Map<string, FileExpansionMode>): Set<string> {
	const hashes = new Set<string>();
	for (const key of expandedFiles.keys()) {
		const parsed = parseFileKey(key);
		if (parsed !== null) hashes.add(parsed.hash);
	}
	return hashes;
}

function remapStateForScan(state: ViewState, nextScan: ScanResult): void {
	const expandedCommitHashes = collectExpandedCommitHashes(state);
	const expandedFileHashes = collectExpandedFileHashes(state.expandedFiles);
	const nextCommitHashes = new Set(nextScan.commits.map(commit => commit.hash));
	const nextFilesCache = new Map<string, FileDiffStat[]>();
	const nextFilesLoading = new Set<string>();
	const nextExpandedFiles = new Map<string, FileExpansionMode>();
	const nextDiffCache = new Map<string, FileDiff>();

	for (const [hash, files] of state.filesCache) {
		if (nextCommitHashes.has(hash)) nextFilesCache.set(hash, files);
	}
	for (const hash of state.filesLoading) {
		if (nextCommitHashes.has(hash)) nextFilesLoading.add(hash);
	}
	for (const [key, mode] of state.expandedFiles) {
		const parsed = parseFileKey(key);
		if (parsed !== null && nextCommitHashes.has(parsed.hash)) nextExpandedFiles.set(key, mode);
	}
	for (const [key, diff] of state.diffCache) {
		const parsed = parseFileKey(key);
		if (parsed !== null && nextCommitHashes.has(parsed.hash)) nextDiffCache.set(key, diff);
	}

	state.scan = nextScan;
	state.expandedCommits = new Set<number>();
	state.filesCache = nextFilesCache;
	state.filesLoading = nextFilesLoading;
	state.expandedFiles = nextExpandedFiles;
	state.diffCache = nextDiffCache;

	for (let commitIndex = 0; commitIndex < state.scan.commits.length; commitIndex++) {
		const commit = state.scan.commits[commitIndex];
		if (expandedCommitHashes.has(commit.hash) || expandedFileHashes.has(commit.hash)) {
			state.expandedCommits.add(commitIndex);
		}
	}
}

// --- Main entry point ---

export async function startTui(initial: ScanResult, onRefresh: () => Promise<ScanResult>): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();

	const state: ViewState = {
		scan: initial,
		cursor: 0,
		scroll: 0,
		expandedCommits: new Set(),
		expandedFiles: new Map(),
		diffCache: new Map(),
		filesCache: new Map(),
		filesLoading: new Set(),
	};

	const diffLoading = new Set<string>();
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
		const commit = state.scan.commits[commitIndex];
		if (commit === undefined) return;

		state.expandedCommits.delete(commitIndex);
		for (const key of [...state.expandedFiles.keys()]) {
			const parsed = parseFileKey(key);
			if (parsed?.hash === commit.hash) state.expandedFiles.delete(key);
		}
	}

	function collapseFile(commitIndex: number, fileIndex: number): void {
		const identity = fileIdentityAt(state, commitIndex, fileIndex);
		if (identity !== null) state.expandedFiles.delete(identity.key);
	}

	async function loadDiffForKey(key: string): Promise<void> {
		if (diffLoading.has(key) || state.diffCache.has(key)) return;

		const parsed = parseFileKey(key);
		if (parsed === null) return;
		const commit = state.scan.commits.find(current => current.hash === parsed.hash);
		const files = commit === undefined ? undefined : state.filesCache.get(commit.hash);
		const file = files?.find(current => current.path === parsed.path);
		if (commit === undefined || file === undefined) return;

		diffLoading.add(key);
		try {
			const diff = await getCommitFileDiff(commit.repoPath, commit.hash, file.path);
			const currentCommit = state.scan.commits.find(current => current.hash === parsed.hash);
			const currentFiles = currentCommit === undefined ? undefined : state.filesCache.get(currentCommit.hash);
			const fileStillVisible = currentFiles?.some(current => current.path === parsed.path) ?? false;
			if (state.expandedFiles.has(key) && currentCommit !== undefined && fileStillVisible) {
				state.diffCache.set(key, diff);
				fullRender();
			}
		} catch (err) {
			const message = String(err);
			logger.error("Diff load failed", {
				repoPath: commit.repoPath,
				hash: commit.hash,
				filePath: file.path,
				error: message,
			});
			if (state.expandedFiles.has(key)) {
				state.diffCache.set(key, { kind: "unavailable", message });
				fullRender();
			}
		} finally {
			diffLoading.delete(key);
		}
	}

	function startMissingDiffLoads(): void {
		for (const key of state.expandedFiles.keys()) {
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

	function cycleFile(commitIndex: number, fileIndex: number): void {
		const identity = fileIdentityAt(state, commitIndex, fileIndex);
		if (identity === null) return;

		const mode = state.expandedFiles.get(identity.key);
		if (mode === undefined) {
			state.expandedFiles.set(identity.key, "hunks");
			fullRender();
			if (!state.diffCache.has(identity.key)) void loadDiffForKey(identity.key);
			return;
		}

		if (mode === "hunks") {
			state.expandedFiles.set(identity.key, "full");
			fullRender();
			return;
		}

		state.expandedFiles.delete(identity.key);
		fullRender();
	}

	async function handleForward(): Promise<void> {
		const line = lines[state.cursor];
		if (!line) return;

		if (line.kind === "commit") {
			toggleCommit(line.commitIndex);
			return;
		}

		if (line.kind === "file") {
			cycleFile(line.commitIndex, line.fileIndex);
		}
	}

	function handleBack(): void {
		const line = lines[state.cursor];
		const context = lineContext(lines, state.cursor);
		if (!line || !context) return;

		if (context.insideFile && context.fileIndex !== undefined) {
			const identity = fileIdentityAt(state, context.commitIndex, context.fileIndex);
			if (identity !== null) {
				const mode = state.expandedFiles.get(identity.key);
				if (mode === "full") {
					state.expandedFiles.set(identity.key, "hunks");
					fullRender();
					return;
				}
				if (mode === "hunks") {
					collapseFile(context.commitIndex, context.fileIndex);
					fullRender();
					return;
				}
			}
		}

		if (state.expandedCommits.has(context.commitIndex)) {
			collapseCommit(context.commitIndex);
			fullRender();
		}
	}

	async function refreshScan(kind: "manual" | "auto"): Promise<void> {
		if (refreshing) return;
		refreshing = true;

		try {
			const refreshed = await onRefresh();
			lines = withAnchoredRefresh(state, lines, () => {
				remapStateForScan(state, refreshed);
				return buildLines(state, term.width);
			});
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
			case "MOUSE_RIGHT_BUTTON_PRESSED": {
				if (data.y >= 1 && data.y <= height) {
					const lineIndex = state.scroll + (data.y - 1);
					const line = lines[lineIndex];
					if (line?.kind === "file") {
						state.cursor = lineIndex;
						ensureCursorVisible(state, height, lines.length);
						await handleForward();
						return;
					}
				}

				handleBack();
				return;
			}
			default:
				return;
		}
	});

	term.on("resize", () => {
		lines = withAnchoredRefresh(state, lines, () => buildLines(state, term.width));
		render(state, lines);
	});

	refreshTimer = setInterval(() => {
		void refreshScan("auto");
	}, REFRESH_MS);

	return promise;
}
