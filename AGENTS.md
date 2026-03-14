# Development Rules

## Code Quality

- No `any` types unless absolutely necessary
- Prefer `export * from "./module"` over named re-export-from blocks, including `export type { ... } from`. In pure `index.ts` barrel files (re-exports only), use star re-exports even for single-specifier cases. If star re-exports create symbol ambiguity, remove the redundant export path instead of keeping duplicate exports.
- **No `private`/`protected`/`public` keyword on class fields or methods** — use ES native `#` private fields for encapsulation; leave members that need external access as bare (no keyword). The only place `private`/`protected`/`public` is allowed is on **constructor parameter properties** (e.g., `constructor(private readonly session: Session)`), where TypeScript requires the keyword for the implicit field declaration.

  ```typescript
  // BAD: TypeScript keyword privacy
  class Foo {
      private bar: string;
      private _baz = 0;
      protected qux(): void { ... }
      public greet(): void { ... }
  }

  // GOOD: ES native # for private, bare for accessible
  class Foo {
      #bar: string;
      #baz = 0;
      qux(): void { ... }
      greet(): void { ... }
  }

  // OK: constructor parameter properties keep the keyword
  class Service {
      constructor(private readonly session: Session) {}
  }
  ```

- **NEVER use `ReturnType<>`** — it obscures types behind indirection. Use the actual type name instead. Look up return types in source or `node_modules` type definitions and reference them directly.

  ```typescript
  // BAD: Indirection through ReturnType
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stmt: ReturnType<Database["prepare"]>;

  // GOOD: Use the actual type
  let timer?: NodeJS.Timeout;
  let stmt: Statement;
  ```

  If a function's return type has no exported name, define a named type alias at the call site — don't use `ReturnType<>`.

- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** — no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- **Use `Promise.withResolvers()`** instead of `new Promise((resolve, reject) => ...)`:

  ```typescript
  // BAD: Verbose, callback nesting
  const promise = new Promise<string>((resolve, reject) => { ... });

  // GOOD: Clean destructuring, typed resolvers
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  ```

## Bun Over Node

This project uses Bun. Use Bun APIs where they provide a cleaner alternative; use `node:fs` for operations Bun doesn't cover.

**NEVER spawn shell commands for operations that have proper APIs** (e.g., `Bun.spawnSync(["mkdir", "-p", dir])` — use `mkdirSync` instead).

### Process Execution

**Prefer Bun Shell** (`$` template literals) for simple commands:

```typescript
import { $ } from "bun";

// Capture output
const result = await $`git status`.cwd(dir).quiet().nothrow();
if (result.exitCode === 0) {
	const text = result.text();
}

// Fire and forget
$`do-stuff ${tmpFile}`.quiet().nothrow();
```

**Use `Bun.spawn`/`Bun.spawnSync`** only when:

- Long-running processes (servers, daemons)
- Streaming stdin/stdout/stderr required
- Process control needed (signals, kill, complex lifecycle)

**Bun Shell methods:**

- `.quiet()` — suppress output (stdout/stderr to null)
- `.nothrow()` — don't throw on non-zero exit
- `.text()` — get stdout as string
- `.cwd(path)` — set working directory

### Sleep

**Prefer** `await Bun.sleep(ms)`
**Avoid** `new Promise((resolve) => setTimeout(resolve, ms))`

### Node Module Imports

**NEVER use named imports from `node:fs` or `node:path`** — always use namespace imports:

```typescript
// BAD: Named imports
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// GOOD: Namespace imports
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// Then use: fs.readdir(), path.join(), etc.
```

**Choosing between `node:fs` and `node:fs/promises`:**

- **Async-only file** → `import * as fs from "node:fs/promises"`
- **Needs both sync and async** → `import * as fs from "node:fs"`, use `fs.promises.xxx` for async

### File I/O

**Prefer Bun file APIs:**

```typescript
// Read
const text = await Bun.file(path).text();
const data = await Bun.file(path).json();

// Write
await Bun.write(path, data);
```

**`Bun.write()` is smart** — it auto-creates parent directories and uses optimal syscalls:

```typescript
// BAD: Redundant mkdir before write
await mkdir(dirname(path), { recursive: true });
await Bun.write(path, data);

// GOOD: Bun.write handles it
await Bun.write(path, data);
```

**Use `node:fs/promises`** for directories (Bun has no native directory APIs):

```typescript
import * as fs from "node:fs/promises";

await fs.mkdir(path, { recursive: true });
await fs.rm(path, { recursive: true, force: true });
const entries = await fs.readdir(path);
```

**Avoid sync APIs** in async flows:

- Don't use `existsSync`/`readFileSync`/`writeFileSync` when async is possible
- Use sync only when required by a synchronous interface

### File I/O Anti-Patterns

**NEVER check `.exists()` before reading** — use try-catch with error code:

```typescript
// BAD: Two syscalls, race condition
if (await Bun.file(path).exists()) {
	return await Bun.file(path).json();
}

// GOOD: One syscall, atomic
try {
	return await Bun.file(path).json();
} catch (err) {
	if (err?.code === "ENOENT") return null;
	throw err;
}
```

**NEVER create multiple handles to the same path.**

**NEVER use `Buffer.from(await Bun.file(x).arrayBuffer())`** — just use `readFile`:

```typescript
import * as fs from "node:fs/promises";
const buffer = await fs.readFile(path);
```

### JSON5 / JSONL

**Use `Bun.JSON5`** — never add `json5` as a dependency:

```typescript
const data = Bun.JSON5.parse(text);
```

**Use `Bun.JSONL`** — never manually split and parse:

```typescript
const entries = Bun.JSONL.parse(text);
```

### Where Bun Wins

| Operation       | Use                                   | Not                             |
| --------------- | ------------------------------------- | ------------------------------- |
| File read/write | `Bun.file()`, `Bun.write()`           | `readFileSync`, `writeFileSync` |
| Spawn process   | `$\`cmd\``, `Bun.spawn()`             | `child_process`                 |
| Sleep           | `Bun.sleep(ms)`                       | `setTimeout` promise            |
| Binary lookup   | `Bun.which("git")`                    | `spawnSync(["which", "git"])`   |
| HTTP server     | `Bun.serve()`                         | `http.createServer()`           |
| SQLite          | `bun:sqlite`                          | `better-sqlite3`                |
| Hashing         | `Bun.hash()`, Web Crypto              | `node:crypto`                   |
| Path resolution | `import.meta.dir`, `import.meta.path` | `fileURLToPath` dance           |
| JSON5 parsing   | `Bun.JSON5.parse()`                   | `json5` package                 |
| JSONL parsing   | `Bun.JSONL.parse()`, `.parseChunk()`  | manual split + `JSON.parse`     |
| String width    | `Bun.stringWidth()`                   | `get-east-asian-width`, custom  |
| Text wrapping   | `Bun.wrapAnsi()`                      | custom ANSI-aware wrappers      |

### Anti-Patterns

- `Bun.spawnSync([...])` for simple commands → use `$\`...\``
- `new Promise((resolve) => setTimeout(resolve, ms))` → use `Bun.sleep(ms)`
- `existsSync/readFileSync/writeFileSync` in async code → use `Bun.file()` APIs
- `import JSON5 from "json5"` → use `Bun.JSON5.parse()`
- `text.split("\n").map(JSON.parse)` for JSONL → use `Bun.JSONL.parse()`
- Custom `visibleWidth()` / `get-east-asian-width` → use `Bun.stringWidth()`
- Custom ANSI-aware text wrapping → use `Bun.wrapAnsi()`

## Commands

| Command        | Description              |
| -------------- | ------------------------ |
| `bun check`    | Biome check + type check |
| `bun lint`     | Biome lint               |
| `bun fmt`      | Biome format             |
| `bun fix`      | Biome --unsafe + format  |

- NEVER commit unless user asks
- Do NOT use `tsc` or `npx tsc` — always use `bun check`

## Testing Guidance

When adding or changing tests, test the contract the system exposes — not the easiest internal detail to assert.

- Every new test must defend one concrete, externally observable contract: behavior, output shape, state transition, error mapping, or a regression-prone parsing boundary. If you cannot name the contract, do not add the test.
- Do not add placeholder tests, tautologies, or assertions that only prove the code executed.
- Prefer contract-level tests over implementation-detail tests. Avoid asserting internal helper wiring, field assignment, singleton identity, incidental ordering, or passthrough option forwarding unless another component depends on that exact detail as a documented contract.
- Do not duplicate coverage across abstraction levels. If an integration test already proves the behavior, delete the narrower unit test that only restates it through mocks.
- For error handling, prefer tests that trigger the real failure path and assert the surfaced error contract over tests that directly instantiate error classes or inspect purely internal metadata.
- Exact strings, ordering, and formatting should only be asserted when downstream code parses or materially depends on the exact bytes. Otherwise assert semantic content.
- Do not add tests for tiny, low-risk changes unless the change affects a real contract or a regression-prone edge case.

## Logging

**NEVER use `console.log`, `console.error`, or `console.warn`** — use the structured logger:

```typescript
import * as logger from "./logger";

logger.error("git fetch failed", { code: 128, repo });
logger.warn("stale lock", { age: 300 });
logger.info("server started", { port: 3000 });
logger.debug("checking repo", { path });
```

The logger writes JSON lines to stderr with timestamp, level, pid, and flattened context. Default level is `info`; call `logger.setLevel("debug")` to include debug output.


## Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only
