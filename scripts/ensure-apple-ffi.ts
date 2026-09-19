#!/usr/bin/env node
// Entry point for the cubby-ffi xcframework + UniFFI Swift shim. Nx caches
// both (project.json `apple-ffi`), keyed by the Rust content fingerprint, so a
// fresh worktree with unchanged Rust restores them instead of recompiling the
// path crates for three targets. build-rust.sh stays the builder.
//
//   ensure-apple-ffi.ts                ensure the artifacts are current
//   ensure-apple-ffi.ts --fingerprint  print the cache key (Nx runtime input)
//   ensure-apple-ffi.ts --build        the Nx target's command
//
// With the daemon off Nx re-copies outputs on every cache hit, which would
// touch the shim's mtime and cascade a CubbyFFI → CubbyKit → App recompile
// on every `pnpm apple sim`. So the fingerprint is also written inside the
// xcframework (it restores with the cache) and a matching marker short-circuits
// before Nx is involved.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  command,
  rustFingerprint,
  runNxTarget,
} from "./rust-fingerprint.ts";

const XCFRAMEWORK = join(
  ROOT,
  "apps/apple/CubbyKit/Frameworks/CubbyFFI.xcframework",
);
const SHIM = join(ROOT, "apps/apple/CubbyKit/Sources/CubbyFFI/cubby_ffi.swift");
const MARKER = join(XCFRAMEWORK, ".fingerprint");
const PROFILE = process.env.CUBBY_FFI_PROFILE ?? "release";
const TARGETS = process.env.CUBBY_FFI_TARGETS ?? "all";

if (!["all", "sim", "device", "mac"].includes(TARGETS)) {
  throw new Error(
    `CUBBY_FFI_TARGETS must be one of all|sim|device|mac, got ${TARGETS}`,
  );
}

const fingerprint = () =>
  rustFingerprint(resolve(ROOT, "cubby-ffi/Cargo.toml"), [
    command("xcodebuild", ["-version"]),
    command("uname", ["-m"]),
    `profile=${PROFILE}`,
    `targets=${TARGETS}`,
  ]);

const isCurrent = (key: string) =>
  existsSync(SHIM) &&
  existsSync(MARKER) &&
  readFileSync(MARKER, "utf8").trim() === key;

const build = (key: string) => {
  execFileSync(
    join(ROOT, "apps/apple/scripts/build-rust.sh"),
    ["--profile", PROFILE, "--targets", TARGETS],
    { cwd: ROOT, stdio: "inherit" },
  );
  writeFileSync(MARKER, `${key}\n`);
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const mode = process.argv[2];
  if (mode === "--fingerprint") {
    console.log(fingerprint());
  } else if (mode === "--build") {
    build(fingerprint());
  } else if (isCurrent(fingerprint())) {
    console.log("ensure-apple-ffi: CubbyFFI.xcframework is current");
  } else {
    runNxTarget("apple-ffi");
  }
}
