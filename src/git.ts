import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import * as logger from "./logger";

// ── Data model ──────────────────────────────────────────────────────────────────

export type Commit = {
	hash: string;
	subject: string;
	date: string;
	author: string;
};

export type FileChange = {
	path: string;
	added: number;
	deleted: number;
	status: string;
};

export type RepoInfo = {
	/** Absolute path to repo root */
	path: string;
	/** Path relative to the scan root */
	relativePath: string;
	/** Current branch name or detached HEAD hash */
	branch: string;
	/** Last N commits */
	commits: Commit[];
	/** Uncommitted changes (staged + unstaged + untracked) */
	changes: FileChange[];
};

// ── Constants ───────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".bun-install", ".git"]);
const MAX_DEPTH = 10;

// ── Discovery ───────────────────────────────────────────────────────────────────

export async function discoverRepos(rootDir: string): Promise<string[]> {
	const root = path.resolve(rootDir);
	const repos: string[] = [];

	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > MAX_DEPTH) return;

		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch (err) {
			logger.debug("readdir failed", { dir, error: String(err) });
			return;
		}

		let hasGit = false;
		const subdirs: string[] = [];

		for (const entry of entries) {
			if (entry.name === ".git") {
				// .git can be a directory (normal repo) or a file (submodule/worktree)
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

		// Continue recursing into subdirs to find nested repos
		await Promise.all(subdirs.map(sub => walk(sub, depth + 1)));
	}

	await walk(root, 0);
	repos.sort();
	return repos;
}

// ── Repo info ───────────────────────────────────────────────────────────────────

async function getBranch(repoPath: string): Promise<string> {
	const result = await $`git rev-parse --abbrev-ref HEAD`.cwd(repoPath).quiet().nothrow();
	const branch = result.text().trim();

	if (result.exitCode !== 0) {
		// Empty repo — no HEAD at all
		return "(empty)";
	}

	if (branch === "HEAD") {
		// Detached HEAD — use short hash instead
		const hashResult = await $`git rev-parse --short HEAD`.cwd(repoPath).quiet().nothrow();
		if (hashResult.exitCode !== 0) return "(empty)";
		return hashResult.text().trim();
	}

	return branch;
}

const MIN_COMMITS = 3;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const FETCH_LIMIT = 50;

/** Fetch commits: all within last 24h, but at least 3. */
async function getCommits(repoPath: string): Promise<Commit[]> {
	const result = await $`git log --format=%h%x00%s%x00%ar%x00%an%x00%at -n ${FETCH_LIMIT}`
		.cwd(repoPath)
		.quiet()
		.nothrow();
	if (result.exitCode !== 0) return [];

	const raw = result.text().trim();
	if (!raw) return [];

	const cutoff = Date.now() - RECENT_WINDOW_MS;
	const commits: Commit[] = [];

	for (const line of raw.split("\n")) {
		const [hash, subject, date, author, epochStr] = line.split("\0");
		const epoch = parseInt(epochStr, 10) * 1000;
		if (commits.length >= MIN_COMMITS && epoch < cutoff) break;
		commits.push({ hash, subject, date, author });
	}

	return commits;
}

/** Parse `git diff --numstat` output into a map of path → { added, deleted }. */
function parseNumstat(text: string): Map<string, { added: number; deleted: number }> {
	const map = new Map<string, { added: number; deleted: number }>();
	if (!text.trim()) return map;

	for (const line of text.trim().split("\n")) {
		// Format: ADDED\tDELETED\tPATH  (binary files show "-" for counts)
		const [addedStr, deletedStr, ...pathParts] = line.split("\t");
		const filePath = pathParts.join("\t"); // handle paths with tabs (unlikely but safe)
		const added = addedStr === "-" ? 0 : parseInt(addedStr, 10) || 0;
		const deleted = deletedStr === "-" ? 0 : parseInt(deletedStr, 10) || 0;
		map.set(filePath, { added, deleted });
	}
	return map;
}

async function getChanges(repoPath: string): Promise<FileChange[]> {
	// Run all three commands in parallel
	const [statusResult, diffUnstaged, diffStaged] = await Promise.all([
		$`git status --porcelain=v2`.cwd(repoPath).quiet().nothrow(),
		$`git diff --numstat`.cwd(repoPath).quiet().nothrow(),
		$`git diff --cached --numstat`.cwd(repoPath).quiet().nothrow(),
	]);

	if (statusResult.exitCode !== 0) return [];

	const raw = statusResult.text().trim();
	if (!raw) return [];

	const unstagedStats = parseNumstat(diffUnstaged.exitCode === 0 ? diffUnstaged.text() : "");
	const stagedStats = parseNumstat(diffStaged.exitCode === 0 ? diffStaged.text() : "");

	const changes: FileChange[] = [];

	for (const line of raw.split("\n")) {
		if (line.startsWith("1 ")) {
			// Ordinary changed entry: 1 XY sub mH mI mW hH hI path
			const parts = line.split(" ");
			const xy = parts[1];
			const filePath = parts.slice(8).join(" ");
			const staged = stagedStats.get(filePath);
			const unstaged = unstagedStats.get(filePath);
			const added = (staged?.added ?? 0) + (unstaged?.added ?? 0);
			const deleted = (staged?.deleted ?? 0) + (unstaged?.deleted ?? 0);

			// Determine status: prefer staged status letter if present, else unstaged
			const statusChar = xy[0] !== "." ? xy[0] : xy[1];
			changes.push({ path: filePath, added, deleted, status: statusChar });
		} else if (line.startsWith("2 ")) {
			// Renamed/copied entry: 2 XY sub mH mI mW hH hI Xscore path\torigPath
			const tabIdx = line.indexOf("\t");
			const beforeTab = line.substring(0, tabIdx);
			const parts = beforeTab.split(" ");
			const xy = parts[1];
			const filePath = parts.slice(9).join(" ");
			const staged = stagedStats.get(filePath);
			const unstaged = unstagedStats.get(filePath);
			const added = (staged?.added ?? 0) + (unstaged?.added ?? 0);
			const deleted = (staged?.deleted ?? 0) + (unstaged?.deleted ?? 0);
			const statusChar = xy[0] !== "." ? xy[0] : xy[1];
			changes.push({ path: filePath, added, deleted, status: statusChar });
		} else if (line.startsWith("? ")) {
			// Untracked: ? path
			const filePath = line.substring(2);
			changes.push({ path: filePath, added: 0, deleted: 0, status: "??" });
		} else if (line.startsWith("u ")) {
			// Unmerged entry: u XY sub m1 m2 m3 mW h1 h2 h3 path
			const parts = line.split(" ");
			const xy = parts[1];
			const filePath = parts.slice(10).join(" ");
			changes.push({ path: filePath, added: 0, deleted: 0, status: xy[0] !== "." ? xy[0] : xy[1] });
		}
		// Ignore header lines (# ...)
	}

	return changes;
}

export async function getRepoInfo(repoPath: string, rootDir: string): Promise<RepoInfo> {
	const absRepo = path.resolve(repoPath);
	const absRoot = path.resolve(rootDir);

	const [branch, commits, changes] = await Promise.all([getBranch(absRepo), getCommits(absRepo), getChanges(absRepo)]);

	const rel = path.relative(absRoot, absRepo);

	return {
		path: absRepo,
		relativePath: rel || ".",
		branch,
		commits,
		changes,
	};
}

// ── Scan all ────────────────────────────────────────────────────────────────────

export async function scanAll(rootDir: string): Promise<RepoInfo[]> {
	const root = path.resolve(rootDir);
	const repoPaths = await discoverRepos(root);
	const infos = await Promise.all(repoPaths.map(rp => getRepoInfo(rp, root)));
	infos.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	return infos;
}

// ── File diff ────────────────────────────────────────────────────────────────────

/**
 * Get the unified diff for a single file in a repo.
 * Combines staged and unstaged diffs. For untracked files, diffs against /dev/null.
 */
export async function getFileDiff(repoPath: string, filePath: string, status: string): Promise<string> {
	const cwd = path.resolve(repoPath);

	if (status === "??") {
		// Untracked file: diff against nothing
		const result = await $`git diff --no-index -- /dev/null ${filePath}`.cwd(cwd).quiet().nothrow();
		// --no-index exits 1 when files differ, which is expected
		return result.text();
	}

	// Get both staged and unstaged diffs
	const [unstaged, staged] = await Promise.all([
		$`git diff -- ${filePath}`.cwd(cwd).quiet().nothrow(),
		$`git diff --cached -- ${filePath}`.cwd(cwd).quiet().nothrow(),
	]);

	const parts: string[] = [];
	const stagedText = staged.text().trim();
	const unstagedText = unstaged.text().trim();

	if (stagedText) {
		parts.push("=== Staged ===");
		parts.push(stagedText);
	}
	if (unstagedText) {
		if (parts.length > 0) parts.push("");
		parts.push("=== Unstaged ===");
		parts.push(unstagedText);
	}

	return parts.join("\n") || "(no diff available)";
}

// ── Commit detail ────────────────────────────────────────────────────────────────

export type CommitDetail = {
	hash: string;
	subject: string;
	body: string;
	author: string;
	date: string;
	files: FileChange[];
};

/**
 * Get full detail for a single commit: message, author, date, and changed files with stats.
 */
export async function getCommitDetail(repoPath: string, hash: string): Promise<CommitDetail> {
	const cwd = path.resolve(repoPath);

	const [infoResult, numstatResult] = await Promise.all([
		$`git show --no-patch --format=%H%x00%s%x00%b%x00%an%x00%ar ${hash}`.cwd(cwd).quiet().nothrow(),
		$`git diff-tree --no-commit-id -r --numstat ${hash}`.cwd(cwd).quiet().nothrow(),
	]);

	let subject = hash;
	let body = "";
	let author = "";
	let date = "";
	let fullHash = hash;

	if (infoResult.exitCode === 0) {
		const parts = infoResult.text().trim().split("\0");
		fullHash = parts[0] ?? hash;
		subject = parts[1] ?? hash;
		body = (parts[2] ?? "").trim();
		author = parts[3] ?? "";
		date = parts[4] ?? "";
	}

	const files: FileChange[] = [];
	if (numstatResult.exitCode === 0) {
		const raw = numstatResult.text().trim();
		if (raw) {
			for (const line of raw.split("\n")) {
				const [addedStr, deletedStr, ...pathParts] = line.split("\t");
				const filePath = pathParts.join("\t");
				const added = addedStr === "-" ? 0 : parseInt(addedStr, 10) || 0;
				const deleted = deletedStr === "-" ? 0 : parseInt(deletedStr, 10) || 0;
				files.push({ path: filePath, added, deleted, status: "M" });
			}
		}
	}

	return { hash: fullHash, subject, body, author, date, files };
}

/**
 * Get the diff for a single file at a specific commit.
 */
export async function getCommitFileDiff(repoPath: string, hash: string, filePath: string): Promise<string> {
	const cwd = path.resolve(repoPath);
	const result = await $`git show ${hash} -- ${filePath}`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) return "(no diff available)";
	return result.text();
}
