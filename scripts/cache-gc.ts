#!/usr/bin/env node
// Frees disk used by cross-worktree build caches: the shared Rust target
// dirs and misc tool output under ~/.cache/cubby/, the Nx daemon/workspace
// cache, and (if present in this checkout) native Apple build output.
//
//   cache-gc.ts                  report disk usage only, no writes
//   cache-gc.ts --clean          delete stray/obsolete cache entries
//   cache-gc.ts --sweep          cargo-sweep the two shared Rust target dirs
//   cache-gc.ts --reset-targets  delete both shared target dirs entirely
//
// Flags combine (`--clean --sweep`, etc). Nothing is ever deleted without an
// explicit flag, and the default report always runs when none is given.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CACHE_DIR = join(homedir(), ".cache/cubby");
export const NX_HOME = join(homedir(), ".nx");
export const NX_WORKSPACE_DATA = join(ROOT, ".nx/workspace-data");
export const NX_DAEMON_LOG = join(NX_WORKSPACE_DATA, "d/daemon.log");

export const APPLE_BUILD_DIRS = [
  join(ROOT, "apps/apple/DerivedData"),
  join(ROOT, "apps/apple/CubbyKit/.build"),
];

// The two shared Rust target dirs (see the `wasm` script in package.json and
// ensure-apple-ffi.ts): keyed by crate directory so --sweep and
// --reset-targets can each operate per-crate.
export const SHARED_TARGETS = [
  { crate: "recipebridge", targetDir: join(CACHE_DIR, "recipebridge-target") },
  { crate: "cubby-ffi", targetDir: join(CACHE_DIR, "cubby-ffi-target") },
];

export type Flags = {
  clean: boolean;
  sweep: boolean;
  resetTargets: boolean;
};

const KNOWN_FLAGS = new Set(["--clean", "--sweep", "--reset-targets"]);
const USAGE = "Usage: cache-gc.ts [--clean] [--sweep] [--reset-targets]";

export const parseFlags = (argv: string[]): Flags => {
  for (const arg of argv) {
    if (!KNOWN_FLAGS.has(arg)) {
      throw new Error(`Unknown flag: ${arg}\n${USAGE}`);
    }
  }
  return {
    clean: argv.includes("--clean"),
    sweep: argv.includes("--sweep"),
    resetTargets: argv.includes("--reset-targets"),
  };
};

// Stray/obsolete entries directly under ~/.cache/cubby/ that --clean removes.
// Deliberately excludes the two live target dirs, openapi-generator-build,
// cargo-pinned, and pinned-cargo-bin — those are live caches, not litter.
export const strayCacheEntries = (entries: string[]): string[] =>
  entries.filter(
    (name) =>
      (name.startsWith("graph-") && name.endsWith(".log")) ||
      name === "graph-cargo-metadata.json" ||
      name === "recipebridge-target-nopatch",
  );

export const listCacheEntries = (dir = CACHE_DIR): string[] =>
  existsSync(dir) ? readdirSync(dir).sort() : [];

export const listNxCacheDirs = (nxHome = NX_HOME): string[] => {
  if (!existsSync(nxHome)) return [];
  return readdirSync(nxHome, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(nxHome, entry.name, "cache"))
    .filter((dir) => existsSync(dir));
};

export const duSizeOf = (path: string): string => {
  if (!existsSync(path)) return "(missing)";
  const out = execFileSync("du", ["-sh", path], { encoding: "utf8" });
  return out.split("\t")[0]?.trim() ?? "?";
};

const printSize = (path: string, label = path) => {
  console.log(`  ${duSizeOf(path).padEnd(8)} ${label}`);
};

const report = () => {
  console.log(`${CACHE_DIR}:`);
  for (const name of listCacheEntries()) {
    printSize(join(CACHE_DIR, name), name);
  }

  console.log("\n~/.nx/*/cache:");
  for (const dir of listNxCacheDirs()) {
    printSize(dir);
  }

  console.log(`\n${NX_WORKSPACE_DATA}:`);
  printSize(NX_WORKSPACE_DATA, "(total)");
  // Observed at 237 MB in the main checkout even though every script sets
  // NX_DAEMON=false, so it gets its own line.
  printSize(NX_DAEMON_LOG, "d/daemon.log");

  const presentAppleDirs = APPLE_BUILD_DIRS.filter((dir) => existsSync(dir));
  if (presentAppleDirs.length > 0) {
    console.log("\nApple build output:");
    for (const dir of presentAppleDirs) {
      printSize(dir);
    }
  }

  console.log("\nActions a flag would take:");
  console.log(
    "  --clean          delete stray/obsolete entries (graph-*.log, graph-cargo-metadata.json, recipebridge-target-nopatch, .nx/workspace-data/d/daemon.log)",
  );
  console.log(
    "  --sweep          cargo-sweep recipebridge-target and cubby-ffi-target down to 6000 MB each",
  );
  console.log(
    "  --reset-targets  delete recipebridge-target and cubby-ffi-target entirely",
  );
};

const removePath = (path: string) => {
  const size = duSizeOf(path);
  rmSync(path, { recursive: true, force: true });
  console.log(`removed ${size.padEnd(8)} ${path}`);
};

const clean = () => {
  for (const name of strayCacheEntries(listCacheEntries())) {
    removePath(join(CACHE_DIR, name));
  }
  if (existsSync(NX_DAEMON_LOG)) {
    removePath(NX_DAEMON_LOG);
  }
};

const cargoSweepAvailable = (): boolean => {
  try {
    execFileSync("cargo", ["sweep", "--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const sweep = () => {
  if (!cargoSweepAvailable()) {
    // Skip rather than exit so other flags in the same invocation still run.
    console.log("cargo install cargo-sweep");
    return;
  }
  for (const { crate, targetDir } of SHARED_TARGETS) {
    // cargo-sweep operates on a *project* directory, not an arbitrary target
    // dir: it locates the target dir to sweep via CARGO_TARGET_DIR (the same
    // env var Cargo itself reads), so cwd is the crate and CARGO_TARGET_DIR
    // points at the shared dir.
    execFileSync("cargo", ["sweep", "--maxsize", "6000"], {
      cwd: join(ROOT, crate),
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
      stdio: "inherit",
    });
  }
};

const resetTargets = () => {
  for (const { targetDir } of SHARED_TARGETS) {
    console.log(`freeing ${duSizeOf(targetDir).padEnd(8)} ${targetDir}`);
  }
  for (const { targetDir } of SHARED_TARGETS) {
    rmSync(targetDir, { recursive: true, force: true });
  }
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let flags: Flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (!flags.clean && !flags.sweep && !flags.resetTargets) {
    report();
  } else {
    if (flags.clean) clean();
    if (flags.sweep) sweep();
    if (flags.resetTargets) resetTargets();
  }
}
