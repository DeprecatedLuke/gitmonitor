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

	const alphaCommit = result.commits[1];
	if (alphaCommit === undefined) throw new Error("missing alpha commit");
	expect(alphaCommit.subject).toBe("alpha second");
	expect(alphaCommit.body).toBe("body text");
	expect(alphaCommit.shortHash).toHaveLength(7);
	expect("files" in alphaCommit).toBe(false);
	expect(await getCommitFiles(alphaCommit.repoPath, alphaCommit.hash)).toEqual([
		{ path: "a.txt", added: 2, deleted: 1, status: "M" },
	]);

	const diff = await getCommitFileDiff(alphaCommit.repoPath, alphaCommit.hash, "a.txt");
	expect(diff).toContain("--- a/a.txt");
	expect(diff).toContain("+++ b/a.txt");
	expect(diff).toContain("-old");
	expect(diff).toContain("+new");
	expect(diff).toContain("+add");
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

	const originalWalk = git.walk;
	let walkCalls = 0;
	git.walk = (async () => {
		walkCalls++;
		const err = new Error("Could not find missing object");
		err.name = "NotFoundError";
		(err as Error & { code: string }).code = "NotFoundError";
		throw err;
	}) as typeof git.walk;

	try {
		const result = await scanAll(root, { limit: 1 });

		expect(result.commits).toHaveLength(1);
		expect(walkCalls).toBe(0);
		const commit = result.commits[0];
		if (commit === undefined) throw new Error("missing broken commit");
		expect(commit.hash).toBe(hash);

		expect(await getCommitFiles(commit.repoPath, commit.hash)).toEqual([]);
		expect(await getCommitFiles(commit.repoPath, commit.hash)).toEqual([]);
		expect(walkCalls).toBe(1);
	} finally {
		git.walk = originalWalk;
	}
});

test("scanAll does not do file-stat work during the initial scan", async () => {
	const root = await makeTempRoot();
	const repos = await Promise.all([initRepo(root, "alpha"), initRepo(root, "beta"), initRepo(root, "gamma")]);
	const now = Math.floor(Date.now() / 1000);

	for (let repoIndex = 0; repoIndex < repos.length; repoIndex++) {
		const repo = repos[repoIndex];
		for (let commitIndex = 0; commitIndex < 5; commitIndex++) {
			await commitFile(
				repo,
				`file-${repoIndex}.txt`,
				`repo ${repoIndex} commit ${commitIndex}\n`,
				`repo ${repoIndex} commit ${commitIndex}`,
				now - repoIndex * 10 - (5 - commitIndex),
			);
		}
	}

	const originalWalk = git.walk;
	let walkCalls = 0;
	git.walk = (async () => {
		walkCalls++;
		throw new Error("scanAll should not walk trees");
	}) as typeof git.walk;

	try {
		const start = performance.now();
		const result = await scanAll(root, { limit: 20 });
		const elapsedMs = performance.now() - start;

		expect(result.repoCount).toBe(3);
		expect(result.commits).toHaveLength(15);
		expect(walkCalls).toBe(0);
		expect(elapsedMs).toBeLessThan(500);
	} finally {
		git.walk = originalWalk;
	}
});

async function makeTempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitmonitor-scanner-"));
	tempRoots.push(root);
	return root;
}

async function initRepo(root: string, name: string): Promise<string> {
	const dir = path.join(root, name);
	await fs.mkdir(dir, { recursive: true });
	await git.init({ fs: nodeFs, dir });
	return dir;
}

async function commitFile(
	dir: string,
	filepath: string,
	contents: string,
	message: string,
	timestamp: number,
): Promise<string> {
	await Bun.write(path.join(dir, filepath), contents);
	await git.add({ fs: nodeFs, dir, filepath });
	const signature = makeSignature(timestamp);
	return await git.commit({ fs: nodeFs, dir, message, author: signature, committer: signature });
}

function makeSignature(timestamp: number): Signature {
	return {
		name: "Test Author",
		email: "test@example.com",
		timestamp,
		timezoneOffset: 0,
	};
}
