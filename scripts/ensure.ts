#!/usr/bin/env node
// One artifact entrypoint; Nx owns cached generation/builds and restoration.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ROOT, command, rustFingerprint } from "./rust-fingerprint.ts";

const usage =
  "Usage: ensure.ts generate [--force|--postinstall] | wasm [--build|--fingerprint] | apple-ffi [--build|--fingerprint]";
const [target, mode, ...extra] = process.argv.slice(2);
const validMode =
  target === "generate"
    ? [undefined, "--force", "--postinstall"].includes(mode)
    : (target === "wasm" || target === "apple-ffi") &&
      [undefined, "--build", "--fingerprint"].includes(mode);
if (!validMode || extra.length > 0) throw new Error(usage);

function runNxTarget(target: string, args: string[] = []) {
  // Enclosing Nx tasks declare their prerequisites; nested Nx is refused.
  if (process.env.NX_TASK_TARGET_PROJECT !== undefined) return;
  let nx: string;
  try {
    nx = fileURLToPath(import.meta.resolve("nx/bin/nx.js"));
  } catch {
    throw new Error(
      `cannot resolve nx; run \`pnpm install --frozen-lockfile\` before ${target}`,
    );
  }
  execFileSync(
    process.execPath,
    [nx, "run", `cubby-checks:${target}`, ...args],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, NX_DAEMON: "false" },
    },
  );
}

if (target === "generate") {
  if (
    mode === "--postinstall" &&
    !existsSync(join(ROOT, "apps/web/node_modules"))
  ) {
    console.log("generate: skipped (filtered install without apps/web)");
  } else {
    runNxTarget("generate", mode === "--force" ? ["--skip-nx-cache"] : []);
    // Cache restoration writes expected files but cannot remove retired outputs.
    const { ARTIFACT_MANIFEST, removeExtraArtifacts } =
      await import("../apps/web/generator/artifacts.ts");
    const manifest = join(ROOT, ARTIFACT_MANIFEST);
    if (existsSync(manifest)) {
      const paths: string[] = JSON.parse(readFileSync(manifest, "utf8"));
      for (const path of await removeExtraArtifacts(
        ROOT,
        paths.map((relativePath) => ({ relativePath })),
      ))
        console.log(`generate: removed stale ${path}`);
    }
  }
} else if (target === "wasm") {
  // wasm-pack accepts only --release; workspace member profiles are ignored.
  // Fingerprinting and building use these same settings.
  process.env.CARGO_TARGET_DIR ??= join(homedir(), ".cache/cubby/cargo-target");
  Object.assign(process.env, {
    CARGO_PROFILE_RELEASE_OPT_LEVEL: "z",
    CARGO_PROFILE_RELEASE_LTO: "true",
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
    CARGO_PROFILE_RELEASE_PANIC: "abort",
    CARGO_PROFILE_RELEASE_INCREMENTAL: "false",
  });
  if (mode === "--fingerprint") {
    const tools = [
      command("wasm-pack", ["--version"]),
      readFileSync(fileURLToPath(import.meta.url), "utf8"),
    ];
    try {
      tools.push(command("wasm-opt", ["--version"]));
    } catch {
      tools.push("wasm-pack-managed optimizer");
    }
    console.log(rustFingerprint(join(ROOT, "Cargo.toml"), tools));
  } else if (mode === "--build") {
    for (const [output, source, flags] of [
      ["worker", "recipebridge", []],
      ["browser", "recipebridge", ["--", "--no-default-features"]],
      ["cookbook", "recipebridge/cookbook", []],
    ] as const) {
      execFileSync(
        "wasm-pack",
        [
          "build",
          "--no-pack",
          "--out-dir",
          join(ROOT, "packages/wasm", output),
          join(ROOT, source),
          ...flags,
        ],
        { cwd: ROOT, stdio: "inherit" },
      );
    }
  } else runNxTarget("wasm");
} else {
  const profile = process.env.CUBBY_FFI_PROFILE ?? "release";
  const targets = process.env.CUBBY_FFI_TARGETS ?? "all";
  if (!["all", "sim", "device", "mac"].includes(targets))
    throw new Error(
      `CUBBY_FFI_TARGETS must be one of all|sim|device|mac, got ${targets}`,
    );
  const key = rustFingerprint(join(ROOT, "Cargo.toml"), [
    command("xcodebuild", ["-version"]),
    command("uname", ["-m"]),
    `profile=${profile}`,
    `targets=${targets}`,
  ]);
  const marker = join(
    ROOT,
    "apps/apple/CubbyKit/Frameworks/CubbyFFI.xcframework/.fingerprint",
  );
  if (mode === "--fingerprint") console.log(key);
  else if (mode === "--build") {
    execFileSync(
      join(ROOT, "apps/apple/scripts/build-rust.sh"),
      ["--profile", profile, "--targets", targets],
      { cwd: ROOT, stdio: "inherit" },
    );
    writeFileSync(marker, `${key}\n`);
  } else if (
    existsSync(
      join(ROOT, "apps/apple/CubbyKit/Sources/CubbyFFI/cubby_ffi.swift"),
    ) &&
    existsSync(marker) &&
    readFileSync(marker, "utf8").trim() === key
  ) {
    // Avoid touching shim mtimes and triggering native recompilation on replay.
    console.log("apple-ffi: CubbyFFI.xcframework is current");
  } else runNxTarget("apple-ffi");
}
