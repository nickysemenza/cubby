import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { readJsonFile } from "nx/src/utils/fileutils";

const source = resolve(import.meta.dirname, "..");
const manifest = readJsonFile<{
  scripts: Record<string, string>;
  packageManager: string;
}>(join(source, "package.json"));

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "cubby-git-hooks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${join(source, "node_modules", ".bin")}:${process.env.PATH}`,
  };
  const git = (...args: string[]) =>
    spawnSync("git", args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
  const ok = (...args: string[]) => {
    const result = git(...args);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  ok("init", "--initial-branch=main");
  ok("config", "user.name", "Hook Fixture");
  ok("config", "user.email", "hooks@example.invalid");
  write(".gitignore", "node_modules\n");
  write(
    "package.json",
    JSON.stringify({
      private: true,
      type: "module",
      packageManager: manifest.packageManager,
      scripts: manifest.scripts,
    }),
  );
  for (const path of [
    ".lintstagedrc.json",
    ".oxlintrc.json",
    ".oxfmtrc.json",
    "apps/web/src/server/db/schema.ts",
    // The lint plugin reads canonical fragments and all generated table groups.
    "apps/web/src/server/db/schema-primitives.ts",
    ...globSync("apps/web/src/server/db/*tables.ts", { cwd: source }),
    ...globSync("apps/web/src/server/db/generated/*table*.gen.ts", {
      cwd: source,
    }),
    "scripts/check-outward-text.ts",
    "packages/shared/src/shortcode-alphabet.ts",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(source, path), join(root, path));
  }
  for (const directory of [
    "tools/oxlint",
    // check-outward-text.ts reads the shortcode prefixes from these.
    "packages/schemas/src/entity-definitions",
  ])
    cpSync(join(source, directory), join(root, directory), { recursive: true });
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, ".husky"));
  for (const entry of readdirSync(join(source, ".husky"), {
    withFileTypes: true,
  })) {
    if (entry.isFile())
      cpSync(
        join(source, ".husky", entry.name),
        join(root, ".husky", entry.name),
      );
  }
  write("example file.ts", "export const value = 1;\n");
  ok("add", ".");
  ok("-c", "core.hooksPath=/dev/null", "commit", "-m", "Fixture baseline");
  // Exercise the real prepare lifecycle command, including its installed dispatchers.
  cpSync(
    join(source, "scripts/install-git-hooks.ts"),
    join(root, "scripts/install-git-hooks.ts"),
  );
  const installed = spawnSync("sh", ["-c", manifest.scripts.prepare!], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  return { root, git, ok, write };
}

test("pre-commit runs lint-staged on the staged files", (t) => {
  const { git, ok, write } = fixture(t);
  const path = "example file.ts";
  write(path, "export const value: any = 2;\n");
  ok("add", "--", path);
  const rejected = git("commit", "-m", "Fixture lint");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr + rejected.stdout, /oxlint/);

  write(path, "export const value = 2;\n");
  ok("add", "--", path);
  ok("commit", "-m", "Fixture valid");
  assert.equal(ok("show", `HEAD:${path}`), "export const value = 2;\n");
});

test("commit messages naming a live entity code are rejected", (t) => {
  const { git, ok, write } = fixture(t);
  write("notes.md", "# Fixture\n");
  ok("add", "--", "notes.md");
  // The documented example body is the one code a message may name.
  ok("commit", "-m", "Explain PRD-4K7M lookups");
  write("notes.md", "# Fixture 2\n");
  ok("add", "--", "notes.md");
  const rejected = git("commit", "-m", "Fix PUR-7Q2M reconciliation");
  assert.notEqual(rejected.status, 0);
  assert.match(
    rejected.stderr + rejected.stdout,
    /live entity codes: PUR-7Q2M/,
  );
  assert.equal(
    ok("log", "--format=%s", "-1").trim(),
    "Explain PRD-4K7M lookups",
  );
});

test("a fresh linked worktree cannot silently commit without dependencies", (t) => {
  const { root, git, ok } = fixture(t);
  const linked = join(root, "linked");
  ok("worktree", "add", "-b", "linked-fixture", linked);
  writeFileSync(join(linked, "example file.ts"), "export const value = 3;\n");
  ok("-C", linked, "add", "--", "example file.ts");
  assert.equal(existsSync(join(linked, "node_modules")), false);
  const rejected = git(
    "-C",
    linked,
    "commit",
    "-m",
    "Fixture unprepared worktree",
  );
  assert.notEqual(rejected.status, 0, rejected.stderr + rejected.stdout);
  assert.match(
    rejected.stderr + rejected.stdout,
    /pnpm install --frozen-lockfile/,
  );
  symlinkSync(
    join(source, "node_modules"),
    join(linked, "node_modules"),
    "dir",
  );
  ok("-C", linked, "commit", "-m", "Fixture prepared worktree");
  assert.equal(
    ok("-C", linked, "show", "HEAD:example file.ts"),
    "export const value = 3;\n",
  );
});

test("formatting a partial stage preserves unstaged edits", (t) => {
  const { ok, write } = fixture(t);
  write("example file.ts", "export const value=3\n");
  ok("add", "--", "example file.ts");
  write(
    "example file.ts",
    "export const value=3\nexport const unstaged = 4;\n",
  );
  ok("commit", "-m", "Fixture partial stage");
  assert.equal(ok("show", "HEAD:example file.ts"), "export const value = 3;\n");
  assert.match(
    ok("diff", "--", "example file.ts"),
    /export const unstaged = 4/,
  );
});
