import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import git, { type ReadCommitResult, type TreeEntry } from "isomorphic-git";
import * as logger from "./logger";

export type FileDiffStat = {
	path: string;
	added: number;
	deleted: number;
	/** Single-letter git-ish status: "A" added, "M" modified, "D" deleted, "T" type-changed */
	status: "A" | "M" | "D" | "T";
};

export type CommitEntry = {
	/** Absolute path to repo root (the directory containing .git) */
	repoPath: string;
	/** Path relative to scan root, e.g. "packages/foo"; "." for the root itself */
	repoLabel: string;
	/** Full commit sha */
	hash: string;
	/** 7-char abbrev */
	shortHash: string;
	/** First line of commit message */
	subject: string;
	/** Remainder of commit message (may be "") */
	body: string;
	author: string;
	/** Committer time, seconds since epoch (UTC) */
	epoch: number;
	/** Compact relative time string, e.g. "3m", "2d4h" */
	dateRelative: string;
};

export type ScanOptions = {
	/** Max total commits returned across all repos. Default 50. */
	limit: number;
};

export type ScanResult = {
	commits: CommitEntry[];
	repoCount: number;
};

type CachedCommitEntry = Omit<CommitEntry, "dateRelative" | "repoLabel">;

type RepoCacheEntry = {
	refSignature: string;
	commits: CachedCommitEntry[];
};

type BlobSide = {
	blob: Uint8Array | null;
};

type LineChange = {
	added: number;
	deleted: number;
};

export type DiffLine =
	| { kind: "equal"; line: string }
	| { kind: "add"; line: string }
	| { kind: "delete"; line: string };

export type FileDiff =
	| { kind: "ops"; ops: DiffLine[]; oldLineCount: number; newLineCount: number }
	| { kind: "binary" }
	| { kind: "oversized" }
	| { kind: "unavailable"; message: string };

const SKIP_DIRS = new Set(["node_modules", ".bun-install", ".git"]);
const MAX_DEPTH = 10;
const DEFAULT_LIMIT = 50;
const MAX_DIFF_LINES = 20_000;
const BINARY_SCAN_BYTES = 8192;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;
const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY;
const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false });
const UTF8_ENCODER = new TextEncoder();
const repoCache = new Map<string, RepoCacheEntry>();
const commitCache = new Map<string, CachedCommitEntry>();
const fileStatsCache = new Map<string, FileDiffStat[]>();

/** Discover repos under rootDir and return the globally-sorted top `limit` commits. */
export async function scanAll(rootDir: string, opts: ScanOptions): Promise<ScanResult> {
	const root = path.resolve(rootDir);
	const limit = normalizeLimit(opts.limit);
	const repoPaths = await discoverRepos(root);
	const repoCommits = await Promise.all(repoPaths.map(repoPath => scanRepo(repoPath, limit)));
	const dedupedCommits = new Map<string, CachedCommitEntry>();
	for (const commit of repoCommits.flat()) {
		const current = dedupedCommits.get(commit.hash);
		if (current === undefined) {
			dedupedCommits.set(commit.hash, commit);
			continue;
		}

		if (
			commit.repoPath.length < current.repoPath.length ||
			(commit.repoPath.length === current.repoPath.length && commit.repoPath.localeCompare(current.repoPath) < 0)
		) {
			dedupedCommits.set(commit.hash, commit);
		}
	}

	const commits = [...dedupedCommits.values()]
		.sort(
			(a, b) =>
				b.epoch - a.epoch ||
				repoLabel(root, a.repoPath).localeCompare(repoLabel(root, b.repoPath)) ||
				a.hash.localeCompare(b.hash),
		)
		.slice(0, limit)
		.map(commit => hydrateCommit(root, commit));

	return { commits, repoCount: repoPaths.length };
}

/** Structured diff for a single file in a commit, vs. its first parent (or /dev/null for root). */
export async function getCommitFileDiff(repoPath: string, hash: string, filePath: string): Promise<FileDiff> {
	const dir = path.resolve(repoPath);
	const commit = await git.readCommit({ fs: nodeFs, dir, oid: hash });
	const parentHash = commit.commit.parent[0] ?? null;
	const diffUnavailable = (err: unknown): FileDiff => {
		logger.debug("diff read failed", { repo: repoPath, hash, path: filePath, error: String(err) });
		const message = err instanceof Error && err.message !== "" ? err.message : String(err);
		return { kind: "unavailable", message };
	};

	let oldSide: BlobSide;
	try {
		oldSide = parentHash === null ? { blob: null } : await readBlobSide(dir, parentHash, filePath);
	} catch (err) {
		return diffUnavailable(err);
	}

	let newSide: BlobSide;
	try {
		newSide = await readBlobSide(dir, hash, filePath);
	} catch (err) {
		return diffUnavailable(err);
	}

	if ((oldSide.blob !== null && isBinaryBlob(oldSide.blob)) || (newSide.blob !== null && isBinaryBlob(newSide.blob))) {
		return { kind: "binary" };
	}

	const oldLines = oldSide.blob === null ? [] : splitLines(decodeBlob(oldSide.blob));
	const newLines = newSide.blob === null ? [] : splitLines(decodeBlob(newSide.blob));

	if (oldLines.length > MAX_DIFF_LINES && newLines.length > MAX_DIFF_LINES) {
		return { kind: "oversized" };
	}

	return {
		kind: "ops",
		ops: buildDiffOps(oldLines, newLines),
		oldLineCount: oldLines.length,
		newLineCount: newLines.length,
	};
}

/** Lazy, memoized per (repoPath, hash). Returns [] on object-store failures. */
export async function getCommitFiles(repoPath: string, hash: string): Promise<FileDiffStat[]> {
	const dir = path.resolve(repoPath);
	const cacheKey = `${dir}:${hash}`;
	const cached = fileStatsCache.get(cacheKey);
	if (cached !== undefined) return cached;

	try {
		const commit = await git.readCommit({ fs: nodeFs, dir, oid: hash });
		const files = await readCommitFileStats(dir, commit);
		fileStatsCache.set(cacheKey, files);
		return files;
	} catch (err) {
		logger.debug("commit files failed", { repo: dir, hash, error: String(err) });
		fileStatsCache.set(cacheKey, []);
		return [];
	}
}

async function discoverRepos(rootDir: string): Promise<string[]> {
	const root = path.resolve(rootDir);
	const repos: string[] = [];

	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > MAX_DEPTH) return;

		let entries: nodeFs.Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (err) {
			logger.debug("readdir failed", { dir, error: String(err) });
			return;
		}

		let hasGit = false;
		const subdirs: string[] = [];

		for (const entry of entries) {
			if (entry.name === ".git") {
				hasGit = true;
				continue;
			}
			if (SKIP_DIRS.has(entry.name)) continue;
			if (entry.isDirectory()) {
				subdirs.push(path.join(dir, entry.name));
			}
		}

		if (hasGit) {
			repos.push(dir);
		}

		await Promise.all(subdirs.map(subdir => walk(subdir, depth + 1)));
	}

	await walk(root, 0);
	repos.sort();
	return repos;
}

async function scanRepo(repoPath: string, limit: number): Promise<CachedCommitEntry[]> {
	const headOid = await resolveHead(repoPath);
	if (headOid === null) return [];

	const refSignature = await getRefSignature(repoPath, headOid);
	if (refSignature !== null) {
		const cached = repoCache.get(repoPath);
		if (cached?.refSignature === refSignature) {
			logger.debug("cache hit", { repo: repoPath });
			return cached.commits;
		}
	}

	let logEntries: ReadCommitResult[];
	try {
		logEntries = await git.log({ fs: nodeFs, dir: repoPath, depth: limit, ref: "HEAD" });
	} catch (err) {
		logger.debug("git log failed", { repo: repoPath, error: String(err) });
		return [];
	}

	const commits = logEntries.map(commit => getOrBuildCommit(repoPath, commit));
	if (refSignature !== null) {
		repoCache.set(repoPath, { refSignature, commits });
	}
	return commits;
}

async function resolveHead(repoPath: string): Promise<string | null> {
	try {
		return await git.resolveRef({ fs: nodeFs, dir: repoPath, ref: "HEAD" });
	} catch (err) {
		logger.debug("HEAD resolution failed", { repo: repoPath, error: String(err) });
		return null;
	}
}

async function getRefSignature(repoPath: string, headOid: string): Promise<string | null> {
	try {
		const gitDir = await resolveGitDir(repoPath);
		if (gitDir === null) return null;

		const headPath = path.join(gitDir, "HEAD");
		const headText = await fs.readFile(headPath, "utf8");
		const [headSignature, packedRefsMtimeNs, refsDirMtimeNs] = await Promise.all([
			sha1Text(headText.trim()),
			readMtimeNs(path.join(gitDir, "packed-refs")),
			readMtimeNs(path.join(gitDir, "refs")),
		]);

		return [headSignature, headOid, packedRefsMtimeNs, refsDirMtimeNs].join("|");
	} catch (err) {
		logger.debug("ref signature failed", { repo: repoPath, error: String(err) });
		return null;
	}
}

async function resolveGitDir(repoPath: string): Promise<string | null> {
	const dotGitPath = path.join(repoPath, ".git");
	let dotGitStat: nodeFs.Stats;
	try {
		dotGitStat = await fs.stat(dotGitPath);
	} catch (err) {
		logger.debug("gitdir stat failed", { repo: repoPath, error: String(err) });
		return null;
	}

	if (dotGitStat.isDirectory()) {
		return dotGitPath;
	}
	if (!dotGitStat.isFile()) {
		return null;
	}

	try {
		const content = await fs.readFile(dotGitPath, "utf8");
		const match = /^gitdir:\s*(.+)$/i.exec(content.trim());
		if (match === null) return null;
		const gitDir = path.resolve(repoPath, match[1]!);
		const stat = await fs.stat(gitDir);
		return stat.isDirectory() ? gitDir : null;
	} catch (err) {
		logger.debug("gitdir pointer failed", { repo: repoPath, error: String(err) });
		return null;
	}
}

async function readMtimeNs(targetPath: string): Promise<string> {
	try {
		const stat = await fs.stat(targetPath, { bigint: true });
		return stat.mtimeNs.toString();
	} catch (err) {
		if (errorCode(err) === "ENOENT") return "";
		throw err;
	}
}

async function sha1Text(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-1", UTF8_ENCODER.encode(text));
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function getOrBuildCommit(repoPath: string, commit: ReadCommitResult): CachedCommitEntry {
	const cacheKey = `${repoPath}:${commit.oid}`;
	const cached = commitCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const message = parseCommitMessage(commit.commit.message);
	const entry: CachedCommitEntry = {
		repoPath,
		hash: commit.oid,
		shortHash: commit.oid.slice(0, 7),
		subject: message.subject,
		body: message.body,
		author: commit.commit.author.name,
		epoch: commit.commit.committer.timestamp,
	};
	commitCache.set(cacheKey, entry);
	return entry;
}

function parseCommitMessage(raw: string): { subject: string; body: string } {
	const message = raw.trim();
	if (message === "") return { subject: "", body: "" };

	const lines = message.split(/\r?\n/);
	const subject = lines[0] ?? "";
	const blankIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "");
	const body =
		blankIndex === -1
			? ""
			: lines
					.slice(blankIndex + 1)
					.join("\n")
					.trim();
	return { subject, body };
}

async function readCommitFileStats(repoPath: string, commit: ReadCommitResult): Promise<FileDiffStat[]> {
	const parentHash = commit.commit.parent[0] ?? null;
	const parentTree = parentHash === null ? null : await resolveCommitTree(repoPath, parentHash);
	const currentTree = await resolveCommitTree(repoPath, commit.oid);
	const out: FileDiffStat[] = [];
	await diffTreeStats(repoPath, parentTree, currentTree, "", out);
	out.sort((a, b) => a.path.localeCompare(b.path));
	return out;
}

async function resolveCommitTree(repoPath: string, commitOid: string): Promise<string | null> {
	try {
		const commit = await git.readCommit({ fs: nodeFs, dir: repoPath, oid: commitOid });
		return commit.commit.tree;
	} catch (err) {
		if (isNotFoundError(err)) {
			logger.debug("commit files failed", { repo: repoPath, hash: commitOid, error: String(err) });
			return null;
		}
		throw err;
	}
}

async function diffTreeStats(
	repoPath: string,
	oldTreeOid: string | null,
	newTreeOid: string | null,
	prefix: string,
	out: FileDiffStat[],
): Promise<void> {
	if (oldTreeOid !== null && newTreeOid !== null && oldTreeOid === newTreeOid) return;

	let oldEntries: TreeEntry[];
	let newEntries: TreeEntry[];
	try {
		[oldEntries, newEntries] = await Promise.all([
			readTreeEntries(repoPath, oldTreeOid),
			readTreeEntries(repoPath, newTreeOid),
		]);
	} catch (err) {
		logger.debug("file diff failed", { repo: repoPath, path: prefix, error: String(err) });
		return;
	}

	const oldByName = new Map(oldEntries.map(entry => [entry.path, entry] as const));
	const newByName = new Map(newEntries.map(entry => [entry.path, entry] as const));
	const names = [...new Set([...oldByName.keys(), ...newByName.keys()])].sort((a, b) => a.localeCompare(b));

	for (const name of names) {
		const oldEntry = oldByName.get(name) ?? null;
		const newEntry = newByName.get(name) ?? null;
		if (oldEntry === null && newEntry === null) continue;

		const filePath = prefix === "" ? name : `${prefix}/${name}`;
		try {
			await diffTreeEntry(repoPath, oldEntry, newEntry, filePath, out);
		} catch (err) {
			logger.debug("file diff failed", { repo: repoPath, path: filePath, error: String(err) });
		}
	}
}

async function diffTreeEntry(
	repoPath: string,
	oldEntry: TreeEntry | null,
	newEntry: TreeEntry | null,
	filePath: string,
	out: FileDiffStat[],
): Promise<void> {
	if (oldEntry !== null && newEntry !== null) {
		if (oldEntry.oid === newEntry.oid) return;

		if (oldEntry.type === "tree" && newEntry.type === "tree") {
			await diffTreeStats(repoPath, oldEntry.oid, newEntry.oid, filePath, out);
			return;
		}

		if (oldEntry.type === "blob" && newEntry.type === "blob") {
			const counts = await countBlobLineChanges(repoPath, oldEntry.oid, newEntry.oid);
			out.push({ path: filePath, added: counts.added, deleted: counts.deleted, status: "M" });
			return;
		}

		if (oldEntry.type === "tree" || newEntry.type === "tree") {
			out.push({ path: filePath, added: 0, deleted: 0, status: "T" });
			return;
		}

		out.push({ path: filePath, added: 0, deleted: 0, status: "M" });
		return;
	}

	if (newEntry !== null) {
		if (newEntry.type === "tree") {
			await diffTreeStats(repoPath, null, newEntry.oid, filePath, out);
			return;
		}

		if (newEntry.type === "blob") {
			const blob = await readBlobByOid(repoPath, newEntry.oid);
			const added = blob === null || isBinaryBlob(blob) ? 0 : countTextLines(decodeBlob(blob));
			out.push({ path: filePath, added, deleted: 0, status: "A" });
			return;
		}

		out.push({ path: filePath, added: 0, deleted: 0, status: "A" });
		return;
	}

	if (oldEntry !== null) {
		if (oldEntry.type === "tree") {
			await diffTreeStats(repoPath, oldEntry.oid, null, filePath, out);
			return;
		}

		if (oldEntry.type === "blob") {
			const blob = await readBlobByOid(repoPath, oldEntry.oid);
			const deleted = blob === null || isBinaryBlob(blob) ? 0 : countTextLines(decodeBlob(blob));
			out.push({ path: filePath, added: 0, deleted, status: "D" });
			return;
		}

		out.push({ path: filePath, added: 0, deleted: 0, status: "D" });
	}
}

async function readTreeEntries(repoPath: string, oid: string | null): Promise<TreeEntry[]> {
	if (oid === null) return [];
	try {
		const result = await git.readTree({ fs: nodeFs, dir: repoPath, oid });
		return result.tree;
	} catch (err) {
		if (isNotFoundError(err)) {
			logger.debug("file diff failed", { repo: repoPath, path: oid, error: String(err) });
			return [];
		}
		throw err;
	}
}

async function countBlobLineChanges(
	repoPath: string,
	oldOid: string | null,
	newOid: string | null,
): Promise<LineChange> {
	const [oldBlob, newBlob] = await Promise.all([
		oldOid === null ? null : readBlobByOid(repoPath, oldOid),
		newOid === null ? null : readBlobByOid(repoPath, newOid),
	]);
	if ((oldBlob !== null && isBinaryBlob(oldBlob)) || (newBlob !== null && isBinaryBlob(newBlob))) {
		return { added: 0, deleted: 0 };
	}
	if (oldBlob === null && newBlob === null) {
		return { added: 0, deleted: 0 };
	}
	if (oldBlob === null && newBlob !== null) {
		return { added: countTextLines(decodeBlob(newBlob)), deleted: 0 };
	}
	if (newBlob === null && oldBlob !== null) {
		return { added: 0, deleted: countTextLines(decodeBlob(oldBlob)) };
	}
	if (oldBlob === null || newBlob === null) {
		return { added: 0, deleted: 0 };
	}
	return countLineChanges(decodeBlob(oldBlob), decodeBlob(newBlob));
}

async function readBlobByOid(repoPath: string, oid: string): Promise<Uint8Array | null> {
	try {
		const result = await git.readBlob({ fs: nodeFs, dir: repoPath, oid });
		return result.blob;
	} catch (err) {
		if (isNotFoundError(err)) {
			logger.debug("file diff failed", { repo: repoPath, path: oid, error: String(err) });
			return null;
		}
		throw err;
	}
}

function countLineChanges(oldText: string, newText: string): LineChange {
	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
		return { added: newLines.length, deleted: oldLines.length };
	}

	const lcs = lcsLength(oldLines, newLines);
	return { added: newLines.length - lcs, deleted: oldLines.length - lcs };
}

function lcsLength(a: string[], b: string[]): number {
	return lcsLengths(a, b)[b.length] ?? 0;
}

function lcsLengths(a: string[], b: string[]): Uint32Array {
	let previous = new Uint32Array(b.length + 1);
	let current = new Uint32Array(b.length + 1);

	for (const aLine of a) {
		for (let column = 0; column < b.length; column++) {
			current[column + 1] =
				aLine === b[column] ? previous[column]! + 1 : Math.max(previous[column + 1]!, current[column]!);
		}
		const nextPrevious = previous;
		previous = current;
		current = nextPrevious;
		current.fill(0);
	}

	return previous;
}

function buildDiffOps(oldLines: string[], newLines: string[]): DiffLine[] {
	if (oldLines.length === 0) return newLines.map(line => ({ kind: "add" as const, line }));
	if (newLines.length === 0) return oldLines.map(line => ({ kind: "delete" as const, line }));

	if (oldLines.length === 1) {
		const matchIndex = newLines.indexOf(oldLines[0]!);
		if (matchIndex === -1) {
			return [
				{ kind: "delete" as const, line: oldLines[0]! },
				...newLines.map(line => ({ kind: "add" as const, line })),
			];
		}
		return [
			...newLines.slice(0, matchIndex).map(line => ({ kind: "add" as const, line })),
			{ kind: "equal" as const, line: oldLines[0]! },
			...newLines.slice(matchIndex + 1).map(line => ({ kind: "add" as const, line })),
		];
	}

	if (newLines.length === 1) {
		const matchIndex = oldLines.indexOf(newLines[0]!);
		if (matchIndex === -1) {
			return [
				...oldLines.map(line => ({ kind: "delete" as const, line })),
				{ kind: "add" as const, line: newLines[0]! },
			];
		}
		return [
			...oldLines.slice(0, matchIndex).map(line => ({ kind: "delete" as const, line })),
			{ kind: "equal" as const, line: newLines[0]! },
			...oldLines.slice(matchIndex + 1).map(line => ({ kind: "delete" as const, line })),
		];
	}

	const oldMidpoint = Math.floor(oldLines.length / 2);
	const oldLeft = oldLines.slice(0, oldMidpoint);
	const oldRight = oldLines.slice(oldMidpoint);
	const leftScores = lcsLengths(oldLeft, newLines);
	const rightScores = lcsLengths([...oldRight].reverse(), [...newLines].reverse());
	let splitIndex = 0;
	let bestScore = -1;

	for (let index = 0; index <= newLines.length; index++) {
		const score = (leftScores[index] ?? 0) + (rightScores[newLines.length - index] ?? 0);
		if (score > bestScore) {
			bestScore = score;
			splitIndex = index;
		}
	}

	return [
		...buildDiffOps(oldLeft, newLines.slice(0, splitIndex)),
		...buildDiffOps(oldRight, newLines.slice(splitIndex)),
	];
}

async function readBlobSide(repoPath: string, hash: string, filePath: string): Promise<BlobSide> {
	try {
		const result = await git.readBlob({ fs: nodeFs, dir: repoPath, oid: hash, filepath: filePath });
		return { blob: result.blob };
	} catch (err) {
		if (isNotFoundError(err)) {
			return { blob: null };
		}
		throw err;
	}
}

function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function countTextLines(text: string): number {
	return splitLines(text).length;
}

function isBinaryBlob(blob: Uint8Array): boolean {
	return blob.subarray(0, Math.min(blob.length, BINARY_SCAN_BYTES)).includes(0);
}

function decodeBlob(blob: Uint8Array): string {
	return UTF8_DECODER.decode(blob);
}

function formatRelative(epoch: number): string {
	const elapsed = Math.floor(Date.now() / 1000 - epoch);
	if (elapsed < 1) return "0s";

	let remaining = elapsed;
	const years = Math.floor(remaining / SECONDS_PER_YEAR);
	remaining %= SECONDS_PER_YEAR;
	const months = Math.floor(remaining / SECONDS_PER_MONTH);
	remaining %= SECONDS_PER_MONTH;
	const weeks = Math.floor(remaining / SECONDS_PER_WEEK);
	remaining %= SECONDS_PER_WEEK;
	const days = Math.floor(remaining / SECONDS_PER_DAY);
	remaining %= SECONDS_PER_DAY;
	const hours = Math.floor(remaining / SECONDS_PER_HOUR);
	remaining %= SECONDS_PER_HOUR;
	const minutes = Math.floor(remaining / SECONDS_PER_MINUTE);
	const seconds = remaining % SECONDS_PER_MINUTE;

	const units = [
		{ value: years, suffix: "y" },
		{ value: months, suffix: "mo" },
		{ value: weeks, suffix: "w" },
		{ value: days, suffix: "d" },
		{ value: hours, suffix: "h" },
		{ value: minutes, suffix: "m" },
		{ value: seconds, suffix: "s" },
	];

	for (const [index, unit] of units.entries()) {
		if (unit.value === 0) continue;

		const secondary = units[index + 1];
		const secondaryPart =
			secondary !== undefined && secondary.value > 0 ? `${secondary.value}${secondary.suffix}` : "";
		return `${unit.value}${unit.suffix}${secondaryPart}`;
	}

	return "0s";
}

function hydrateCommit(rootDir: string, commit: CachedCommitEntry): CommitEntry {
	return {
		...commit,
		repoLabel: repoLabel(rootDir, commit.repoPath),
		dateRelative: formatRelative(commit.epoch),
	};
}

function repoLabel(rootDir: string, repoPath: string): string {
	return path.relative(rootDir, repoPath) || ".";
}

function normalizeLimit(limit: number): number {
	if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
	return Math.trunc(limit);
}

function isNotFoundError(err: unknown): boolean {
	if (err instanceof git.Errors.NotFoundError || errorCode(err) === "NotFoundError") return true;
	if (typeof err !== "object" || err === null) return false;

	const candidate = err as { message?: unknown; name?: unknown };
	if (candidate.name === "NotFoundError") return true;
	return typeof candidate.message === "string" && candidate.message.includes("Could not find");
}

function errorCode(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
	const code = (err as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}
