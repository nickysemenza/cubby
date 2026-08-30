#!/usr/bin/env node
// Rebuild the gitignored @cubby/recipebridge WASM only when a source it's built
// from is newer than the built binary. "Sources" is recipebridge/ AND every local
// path-dependency cargo resolves it against — notably the ingredient-parser
// working copy a `~/.cargo` `[patch]` redirects to (the local dev loop). `cargo
// metadata` is the source of truth for those paths, so a path patch is picked up
// automatically; with no patch (CI / fresh clone) the parser resolves from a
// pinned git rev and only recipebridge/ is watched — same as before.
//
// cargo does the real incremental compile (kept warm across worktrees by the
// shared CARGO_TARGET_DIR in the root `wasm` script); this script is just the
// staleness gate that skips the ~4s wasm-bindgen/opt when nothing changed. Wired
// into `pnpm dev` (so a local parser edit rebuilds on the next dev start) and the
// .husky post-merge / post-checkout hooks (so a pull that bumps the pinned rev,
// or a branch switch, rebuilds too).

import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ART = join(ROOT, "packages/wasm/recipebridge_bg.wasm");
const PRUNE = new Set(["target", ".git", "node_modules"]);
const WATCH_EXT = [".rs", ".toml", ".lock"];

const newestMtime = (directory: string): number => {
  let newest = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!PRUNE.has(entry.name)) newest = Math.max(newest, newestMtime(path));
    } else if (WATCH_EXT.some((extension) => entry.name.endsWith(extension))) {
      try {
        newest = Math.max(newest, statSync(path).mtimeMs);
      } catch {}
    }
  }
  return newest;
};

export const cargoMetadataSchema = z.object({
  packages: z.array(
    z.object({
      manifest_path: z.string(),
      source: z.string().nullable(),
    }),
  ),
});

const log = (msg: string) => process.stderr.write(`[ensure-wasm] ${msg}\n`);

const build = () =>
  execFileSync("pnpm", ["run", "wasm"], { cwd: ROOT, stdio: "inherit" });

// Source roots whose changes invalidate the WASM: recipebridge/ plus any local
// path dependency. `source === null` in cargo metadata marks a path dep (incl. a
// crate patched to a local path); git/registry deps are immutable, so they're
// never watched. cargo unavailable/offline → fall back to recipebridge/ only.
const sourceRoots = () => {
  const roots = new Set([join(ROOT, "recipebridge")]);
  try {
    const out = execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version=1",
        "--manifest-path",
        join(ROOT, "recipebridge/Cargo.toml"),
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 1 << 26,
      },
    );
    for (const p of cargoMetadataSchema.parse(JSON.parse(out)).packages) {
      if (p.source === null) roots.add(dirname(p.manifest_path));
    }
  } catch {
    log("cargo metadata unavailable — watching recipebridge/ only");
  }
  return [...roots];
};

const main = () => {
  if (!existsSync(ART)) {
    log("no WASM build — building…");
    build();
    return;
  }

  const artMtime = statSync(ART).mtimeMs;
  const stale = sourceRoots().some((r) => newestMtime(r) > artMtime);

  if (!stale) return;

  log("recipebridge or a local path-dep changed — building…");
  build();
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
