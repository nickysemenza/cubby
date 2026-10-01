#!/usr/bin/env node
// Runs the web app's `tsc` behind two guards for a machine running several
// worktrees at once. Measurements: docs/local-check-performance.md.
//
// Stale incremental state: TS 7 recomputes the declaration signature of every
// changed file, and one exported-shape change invalidates most of the program
// (every router importer references the route tree through its module
// augmentation, and the global `worker-configuration.d.ts` imports the server).
// After a rebase or pull an old .tsbuildinfo therefore costs about twice a
// fresh check, so it is dropped when many of its files changed.
//
// Concurrency: one check holds 5-7 GB of live type data that Go GC tuning
// cannot shrink, so checks across worktrees wait for a slot instead of pushing
// the machine into swap. `CUBBY_TYPECHECK_SLOTS` sets the count (0 disables).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const WEB = resolve(import.meta.dirname, "../apps/web");
const BUILD_INFO = join(WEB, "tsconfig.tsbuildinfo");
// Content hashes of the program's own files when BUILD_INFO was last written.
const INPUTS = join(WEB, "node_modules/.cache/cubby-typecheck-inputs.json");
// Above this many changed files an incremental run measured slower than a fresh
// one; below it, files the cache already re-signed keep cheap body edits.
const STALE_FILES = 100;
const SLOTS = Number(process.env.CUBBY_TYPECHECK_SLOTS ?? 2);
const SLOT_DIR = join(homedir(), ".cache/cubby/typecheck-slots");

const hashOf = (path: string) => {
  try {
    return createHash("sha1").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
};

// The buildinfo's own file list, minus libraries: exactly what tsc tracks.
const ownFiles = () =>
  // SAFETY: tsc writes this file; only the optional `fileNames` array is read.
  (
    JSON.parse(readFileSync(BUILD_INFO, "utf8")) as { fileNames?: string[] }
  ).fileNames?.filter(
    (name) => name.startsWith(".") && !name.includes("/node_modules/"),
  ) ?? [];

const dropStaleBuildInfo = () => {
  if (!existsSync(BUILD_INFO)) return;
  let recorded: Record<string, string> = {};
  try {
    recorded = JSON.parse(readFileSync(INPUTS, "utf8"));
  } catch {
    // No record (e.g. a buildinfo copied from another checkout): all stale.
  }
  const files = ownFiles();
  const changed = files.filter(
    (file) => recorded[file] !== hashOf(join(WEB, file)),
  ).length;
  if (changed <= STALE_FILES) return;
  console.log(
    `typecheck: ${changed} of ${files.length} files changed since the last check; starting fresh`,
  );
  rmSync(BUILD_INFO);
};

const recordInputs = () => {
  if (!existsSync(BUILD_INFO)) return;
  const hashes: Record<string, string> = {};
  for (const file of ownFiles()) {
    const hash = hashOf(join(WEB, file));
    if (hash) hashes[file] = hash;
  }
  mkdirSync(dirname(INPUTS), { recursive: true });
  writeFileSync(INPUTS, JSON.stringify(hashes));
};

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // SAFETY: `process.kill` only throws Node system errors, which carry `code`.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// `mkdir` is atomic, so a slot directory is a lock. A holder that died without
// releasing is reclaimed; a reclaim race only ever admits one extra check.
const tryTake = (slot: string, reclaim = true): boolean => {
  try {
    mkdirSync(slot);
  } catch {
    let owner = 0;
    try {
      owner = Number(readFileSync(join(slot, "pid"), "utf8"));
    } catch {
      // Taken but not yet stamped: treat as held.
    }
    if (!reclaim || !owner || pidAlive(owner)) return false;
    rmSync(slot, { recursive: true, force: true });
    return tryTake(slot, false);
  }
  writeFileSync(join(slot, "pid"), String(process.pid));
  return true;
};

const acquireSlot = async () => {
  if (process.env.CI || !(SLOTS >= 1)) return () => {};
  mkdirSync(SLOT_DIR, { recursive: true });
  let announced = false;
  for (;;) {
    for (let index = 0; index < SLOTS; index++) {
      const slot = join(SLOT_DIR, String(index));
      if (tryTake(slot))
        return () => rmSync(slot, { recursive: true, force: true });
    }
    if (!announced) {
      console.log(
        `typecheck: waiting for one of ${SLOTS} machine-wide slots (CUBBY_TYPECHECK_SLOTS)`,
      );
      announced = true;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
};

const release = await acquireSlot();
process.on("exit", release);
dropStaleBuildInfo();
const child = spawn(
  join(WEB, "node_modules/.bin/tsc"),
  ["--noEmit", "--checkers", "1", ...process.argv.slice(2)],
  { cwd: WEB, stdio: "inherit" },
);
// Native tsc exits 0 when interrupted, so an interrupted run must not record
// its inputs as checked.
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    interrupted = true;
    child.kill(signal);
  });
child.on("exit", (code) => {
  if (interrupted) process.exit(130);
  if (code !== null) recordInputs();
  process.exit(code ?? 1);
});
