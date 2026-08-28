#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCKFILE = join(ROOT, "pnpm-lock.yaml");
const INSTALLED_LOCKFILE = join(ROOT, "node_modules/.pnpm/lock.yaml");
const worktreeOnly = process.argv.includes("--worktree-only");

const run = (command: string, args: readonly string[]) =>
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: ["ignore", 2, 2],
  });

const gitPath = (kind: string) =>
  execFileSync("git", ["rev-parse", "--path-format=absolute", kind], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

const isLinkedWorktree = () => {
  try {
    // Keep this pre-install implementation aligned with
    // apps/web/tooling/git-worktree.ts, which cannot be imported before install.
    return (
      normalize(gitPath("--git-dir")) !== normalize(gitPath("--git-common-dir"))
    );
  } catch {
    return false;
  }
};

const dependenciesAreCurrent = () =>
  existsSync(INSTALLED_LOCKFILE) &&
  readFileSync(LOCKFILE).equals(readFileSync(INSTALLED_LOCKFILE));

if (worktreeOnly && !isLinkedWorktree()) process.exit(0);

if (!dependenciesAreCurrent()) {
  process.stderr.write("[agent-setup] installing workspace dependencies…\n");
  run("pnpm", ["install", "--frozen-lockfile"]);
}

run("node", ["scripts/ensure-wasm.ts"]);
