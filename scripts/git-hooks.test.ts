import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  write(".gitignore", "node_modules/\nremote.git/\n");
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
    "apps/web/src/server/db/generated/entity-columns.gen.ts",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(source, path), join(root, path));
  }
  cpSync(join(source, "tools", "oxlint"), join(root, "tools", "oxlint"), {
    recursive: true,
  });
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir");
  for (const path of ["example file.ts", "unrelated.ts", "deleted.ts"]) {
    write(path, "export const value = 1;\n");
  }
  ok("add", ".");
  ok("-c", "core.hooksPath=/dev/null", "commit", "-m", "Fixture baseline");

  mkdirSync(join(root, ".husky"));
  // Copy only tracked hook entrypoints, not the checkout's installed Husky wrappers.
  for (const entry of readdirSync(join(source, ".husky"), {
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const destination = join(root, ".husky", entry.name);
    cpSync(join(source, ".husky", entry.name), destination);
    chmodSync(destination, 0o755);
  }
  ok("config", "core.hooksPath", ".husky");
  return { root, git, ok, write };
}

test("commit checks the index and preserves partial staging on success and failure", async (t) => {
  for (const scenario of [
    { name: "valid", staged: "export const value = 2;\n", succeeds: true },
    { name: "lint", staged: "export const value: any = 2;\n", succeeds: false },
    { name: "format", staged: "export const value=2\n", succeeds: false },
  ]) {
    await t.test(scenario.name, (t) => {
      const { root, git, ok, write } = fixture(t);
      const path = "example file.ts";
      write(path, scenario.staged);
      ok("add", "--", path);
      const unstaged = `${scenario.staged}// Keep this unstaged.\n`;
      write(path, unstaged);
      // An unrelated invalid working file must not expand the hook's scope.
      write("unrelated.ts", "export const =\n");
      const indexBefore = ok("diff", "--cached", "--binary");
      const worktreeBefore = ok("diff", "--binary");
      const started = performance.now();
      const result = git("commit", "-m", `Fixture ${scenario.name}`);
      t.diagnostic(`Commit hook: ${Math.round(performance.now() - started)}ms`);
      if (scenario.succeeds) {
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.equal(ok("show", `HEAD:${path}`), scenario.staged);
        assert.equal(ok("diff", "--cached"), "");
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr + result.stdout, /oxlint|oxfmt/);
        assert.equal(ok("diff", "--cached", "--binary"), indexBefore);
      }
      assert.equal(ok("diff", "--binary"), worktreeBefore);
      assert.equal(readFileSync(join(root, path), "utf8"), unstaged);
      assert.equal(ok("stash", "list"), "");
    });
  }
});

test("ignored, renamed, deleted, and empty selections stay cheap and pushes run no checks", (t) => {
  const { root, git, ok, write } = fixture(t);
  write("unrelated.ts", "export const =\n");
  write("notes.md", "# Fixture\n");
  ok("add", "--", "notes.md");
  const started = performance.now();
  ok("commit", "-m", "Documentation fixture");
  t.diagnostic(
    `Documentation commit: ${Math.round(performance.now() - started)}ms`,
  );

  write("apps/apple/ignored.ts", "export const =\n");
  ok("add", "--", "apps/apple/ignored.ts");
  ok("commit", "-m", "Ignored fixture");
  ok("mv", "example file.ts", "renamed file.ts");
  ok("commit", "-m", "Rename fixture");
  assert.equal(ok("show", "HEAD:renamed file.ts"), "export const value = 1;\n");
  ok("rm", "deleted.ts");
  ok("commit", "-m", "Deletion fixture");
  ok("commit", "--allow-empty", "-m", "Empty fixture");

  // An invalid staged file and no tracking branch cannot block publication.
  write("renamed file.ts", "export const =\n");
  ok("add", "--", "renamed file.ts");
  write("untracked.ts", "export const =\n");
  const indexBefore = ok("diff", "--cached", "--binary");
  const worktreeBefore = ok("diff", "--binary");
  const remote = join(root, "remote.git");
  ok("init", "--bare", remote);
  const pushed = git("push", remote, "HEAD:refs/heads/main");
  assert.equal(pushed.status, 0, pushed.stderr + pushed.stdout);
  assert.doesNotMatch(
    pushed.stderr + pushed.stdout,
    /lint-staged|oxlint|oxfmt|nx run/,
  );
  assert.equal(
    ok("--git-dir", remote, "rev-parse", "main"),
    ok("rev-parse", "HEAD"),
  );
  assert.equal(ok("diff", "--cached", "--binary"), indexBefore);
  assert.equal(ok("diff", "--binary"), worktreeBefore);
  assert.equal(
    readFileSync(join(root, "untracked.ts"), "utf8"),
    "export const =\n",
  );
});
