#!/usr/bin/env node
// Runs `pnpm generate` only when its inputs changed since the last run, so
// install, build, typecheck and test can all depend on generated output that
// is never committed. The fingerprint covers every tracked or untracked
// (not ignored) file under the generator's input roots; the generated outputs
// are gitignored and so never feed their own key.
//
//   ensure.ts                generate if stale
//   ensure.ts --force        always generate
//   ensure.ts --postinstall  generate if stale, but skip a filtered install
//                            that left out the web app's dependencies
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Every root the generator reads: its own code, the packages the declarations
// and contracts import, the web app (contracts, routes, list sources), the
// preview-fixture builder it loads from apps/web/scripts, and the hand-written
// Swift vocabulary the entity manifest is checked against.
const INPUTS = [
  "scripts/generator",
  "packages",
  "apps/web/src",
  "apps/web/scripts/apple-preview-fixtures.ts",
  "apps/apple/CubbyKit/Sources/CubbyKit/Catalog/EntityManifest.swift",
  "apps/web/tsconfig.json",
  "package.json",
  "pnpm-lock.yaml",
];
const STAMP = join(ROOT, "node_modules/.cache/cubby-generate.fingerprint");
// Written by main.ts: every file the last run produced. A missing one (a
// clean, a deleted Swift file or fixture) forces a run.
const OUTPUTS = join(ROOT, "node_modules/.cache/cubby-generate.outputs");

const fingerprint = () => {
  let listing: string;
  try {
    listing = execFileSync(
      "git",
      ["ls-files", "-z", "-co", "--exclude-standard", "--", ...INPUTS],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    // No git checkout (an exported tarball): nothing to key on, so generate.
    return null;
  }
  const files = listing.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const path = join(ROOT, file);
    // A tracked file deleted in the working tree is still listed.
    if (!existsSync(path)) continue;
    hash.update(file).update("\0").update(readFileSync(path)).update("\0");
  }
  return hash.digest("hex");
};

if (
  process.argv.includes("--postinstall") &&
  !existsSync(join(ROOT, "apps/web/node_modules"))
) {
  console.log("generate: skipped (filtered install without apps/web)");
  process.exit(0);
}

const key = fingerprint();
const current =
  !process.argv.includes("--force") &&
  existsSync(OUTPUTS) &&
  readFileSync(OUTPUTS, "utf8")
    .split("\n")
    .filter(Boolean)
    .every((path) => existsSync(join(ROOT, path))) &&
  key !== null &&
  existsSync(STAMP) &&
  readFileSync(STAMP, "utf8") === key;
if (!current) {
  execFileSync(
    join(ROOT, "node_modules/.bin/tsx"),
    ["--tsconfig", "apps/web/tsconfig.json", "scripts/generator/main.ts"],
    { cwd: ROOT, stdio: "inherit" },
  );
  mkdirSync(dirname(STAMP), { recursive: true });
  if (key !== null) writeFileSync(STAMP, key);
}
