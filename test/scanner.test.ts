import { afterEach, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import git from "isomorphic-git";
import { getCommitFileDiff, getCommitFiles, scanAll } from "../src/scanner";

type Signature = {
	name: string;
	email: string;
	timestamp: number;
	timezoneOffset: number;
};

const tempRoots: string[] = [];

afterEach(async () => {
	const roots = tempRoots.splice(0);
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
});

test("scanAll returns a global commit-first list with lazy file stats", async () => {
	const root = await makeTempRoot();
	const alpha = await initRepo(root, "alpha");
	const beta = await initRepo(root, "beta");
	await initRepo(root, "empty");
	const now = Math.floor(Date.now() / 1000);

	await commitFile(alpha, "a.txt", "old\nkeep\n", "alpha first", now - 120);
	await commitFile(alpha, "a.txt", "new\nkeep\nadd\n", "alpha second\n\nbody text", now - 60);
	await commitFile(beta, "b.txt", "beta\n", "beta newest", now - 30);

	const result = await scanAll(root, { limit: 2 });

	expect(result.repoCount).toBe(3);
	expect(result.commits).toHaveLength(2);
	expect(result.commits.map(commit => commit.repoLabel)).toEqual(["beta", "alpha"]);

	const betaCommit = result.commits[0];
	if (betaCommit === undefined) throw new Error("missing beta commit");
	expect(betaCommit.subject).toBe("beta newest");
	expect("files" in betaCommit).toBe(false);
	expect(await getCommitFiles(betaCommit.repoPath, betaCommit.hash)).toEqual([
		{ path: "b.txt", added: 1, deleted: 0, status: "A" },
	]);

	const betaDiff = await getCommitFileDiff(betaCommit.repoPath, betaCommit.hash, "b.txt");
	expect(betaDiff.kind).toBe("ops");
	if (betaDiff.kind !== "ops") throw new Error("expected text diff ops");
	expect(betaDiff.oldLineCount).toBe(0);
	expect(betaDiff.newLineCount).toBe(1);
	expect(betaDiff.ops.every(op => op.kind === "add")).toBe(true);
	expect(betaDiff.ops.map(op => op.line)).toEqual(["beta"]);

	const alphaCommit = result.commits[1];
	if (alphaCommit === undefined) throw new Error("missing alpha commit");
	expect(alphaCommit.subject).toBe("alpha second");
	expect(alphaCommit.body).toBe("body text");
	expect(alphaCommit.shortHash).toHaveLength(7);
	expect("files" in alphaCommit).toBe(false);
	expect(await getCommitFiles(alphaCommit.repoPath, alphaCommit.hash)).toEqual([
		{ path: "a.txt", added: 2, deleted: 1, status: "M" },
	]);
});

test("getCommitFileDiff returns structured ops for a one-line modification", async () => {
	const root = await makeTempRoot();
	const repo = await initRepo(root, "modify");
	const now = Math.floor(Date.now() / 1000);
	const oldLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
	const newLines = [...oldLines];
	newLines[9] = "line 10 changed";

	await commitFile(repo, "story.txt", `${oldLines.join("\n")}\n`, "initial", now - 60);
	const hash = await commitFile(repo, "story.txt", `${newLines.join("\n")}\n`, "modify middle", now);

	const diff = await getCommitFileDiff(repo, hash, "story.txt");

	expect(diff.kind).toBe("ops");
	if (diff.kind !== "ops") throw new Error("expected text diff ops");
	expect(diff.oldLineCount).toBe(20);
	expect(diff.newLineCount).toBe(20);
	expect(diff.ops).toEqual([
		...oldLines.slice(0, 9).map(line => ({ kind: "equal", line })),
		{ kind: "delete", line: "line 10" },
		{ kind: "add", line: "line 10 changed" },
		...oldLines.slice(10).map(line => ({ kind: "equal", line })),
	]);
	expect(diff.ops.filter(op => op.kind === "delete")).toHaveLength(1);
	expect(diff.ops.filter(op => op.kind === "add")).toHaveLength(1);
});

test("getCommitFileDiff returns binary for binary blobs", async () => {
	const root = await makeTempRoot();
	const repo = await initRepo(root, "binary");
	const hash = await commitFile(repo, "asset.bin", new Uint8Array([0, 1, 2, 3]), "binary file", 1_700_000_000);

	const diff = await getCommitFileDiff(repo, hash, "asset.bin");

	expect(diff).toEqual({ kind: "binary" });
});

test("scanAll deduplicates commits by hash, preferring the shortest repoPath", async () => {
	const root = await makeTempRoot();
	const repoA = await initRepo(root, "root");
	const hashA = await commitFile(repoA, "mirror.txt", "content\n", "shared commit", 1_700_000_000);
	const repoB = path.join(root, ".cow", "mirror", "root");

	await fs.mkdir(path.dirname(repoB), { recursive: true });
	await fs.cp(repoA, repoB, { recursive: true });

	const result = await scanAll(root, { limit: 10 });

	expect(result.repoCount).toBe(2);
	expect(result.commits).toHaveLength(1);
	expect(result.commits[0]).toBeDefined();
	expect(result.commits[0]?.repoPath).toBe(repoA);
	expect(result.commits[0]?.hash).toBe(hashA);
});

test("getCommitFiles returns cached empty stats when commit file stats cannot be read", async () => {
	const root = await makeTempRoot();
	const repo = await initRepo(root, "broken");
	const now = Math.floor(Date.now() / 1000);
	const hash = await commitFile(repo, "missing.txt", "content\n", "broken tree", now);

	const originalReadTree = git.readTree;
	let readTreeCalls = 0;
	git.readTree = (async () => {
		readTreeCalls++;
		const err = new Error("Could not find missing object");
		err.name = "NotFoundError";
		(err as Error & { code: string }).code = "NotFoundError";
		throw err;
	}) as typeof git.readTree;

	try {
		const result = await scanAll(root, { limit: 1 });

		expect(result.commits).toHaveLength(1);
		expect(readTreeCalls).toBe(0);
		const commit = result.commits[0];
		if (commit === undefined) throw new Error("missing broken commit");
		expect(commit.hash).toBe(hash);

		expect(await getCommitFiles(commit.repoPath, commit.hash)).toEqual([]);
		expect(await getCommitFiles(commit.repoPath, commit.hash)).toEqual([]);
		expect(readTreeCalls).toBe(1);
	} finally {
		git.readTree = originalReadTree;
	}
});

test("scanAll does not do file-stat work during the initial scan", async () => {
	const root = await makeTempRoot();
	const repos = await Promise.all([initRepo(root, "alpha"), initRepo(root, "beta"), initRepo(root, "gamma")]);
	const now = Math.floor(Date.now() / 1000);

	for (let repoIndex = 0; repoIndex < repos.length; repoIndex++) {
		const repo = repos[repoIndex];
		if (repo === undefined) throw new Error("missing repo");
		await commitFile(repo, `file-${repoIndex}.txt`, `content ${repoIndex}\n`, `commit ${repoIndex}`, now - repoIndex);
	}

	const originalReadTree = git.readTree;
	let readTreeCalls = 0;
	git.readTree = (async (...args) => {
		readTreeCalls++;
		return originalReadTree(...args);
	}) as typeof git.readTree;

	try {
		const result = await scanAll(root, { limit: 3 });

		expect(result.commits).toHaveLength(3);
		expect(readTreeCalls).toBe(0);

		const commit = result.commits[0];
		if (commit === undefined) throw new Error("missing newest commit");
		await getCommitFiles(commit.repoPath, commit.hash);
		expect(readTreeCalls).toBeGreaterThanOrEqual(1);
	} finally {
		git.readTree = originalReadTree;
	}
});

async function makeTempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitmonitor-"));
	tempRoots.push(root);
	return root;
}

async function initRepo(root: string, label: string): Promise<string> {
	const repo = path.join(root, label);
	await fs.mkdir(repo, { recursive: true });
	await git.init({ fs: nodeFs, dir: repo, defaultBranch: "main" });
	return repo;
}

async function commitFile(
	repo: string,
	filePath: string,
	content: string | Uint8Array,
	message: string,
	timestamp: number,
): Promise<string> {
	await fs.mkdir(path.dirname(path.join(repo, filePath)), { recursive: true });
	await fs.writeFile(path.join(repo, filePath), content);
	await git.add({ fs: nodeFs, dir: repo, filepath: filePath });

	const signature: Signature = {
		name: "Test User",
		email: "test@example.com",
		timestamp,
		timezoneOffset: 0,
	};

	return await git.commit({
		fs: nodeFs,
		dir: repo,
		message,
		author: signature,
		committer: signature,
	});
}
