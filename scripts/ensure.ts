#!/usr/bin/env node
// One artifact entrypoint; Nx owns cached generation/builds and restoration.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, matchesGlob, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { walkFiles } from "./lib/tree-digest.ts";
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

const nxInsideTask = process.env.NX_TASK_TARGET_PROJECT !== undefined;

/**
 * Local fast path for a default-mode ensure: skips starting Nx when nothing
 * the target's Nx key or outputs could depend on changed since a verified run.
 * The key over-approximates the target's declared file inputs (each glob's
 * literal directory; exclusions ignored) by stat, with ctime and inode so any
 * write invalidates, and content-hashes outputs, which a cache hit re-restores
 * with new inodes but identical bytes. An input kind it cannot model disables
 * the fast path. The marker is written only when the key was unchanged across
 * the Nx run, so it never records a state Nx did not hash.
 */
async function ensureWithMarker(
  name: "wasm" | "generate",
  runtimeInputs: Record<string, string>,
  ensure: () => Promise<void> | void,
) {
  const markerPath = join(ROOT, "node_modules/.cache/cubby", `ensure-${name}`);
  const { parseJson } = await import("nx/src/utils/json.js");
  const config = parseJson(readFileSync(join(ROOT, "project.json"), "utf8"))
    .targets[name];
  const key = (): string | undefined => {
    const hash = createHash("sha256");
    const literalDirectory = (pattern: string) => {
      const parts = pattern.split("/");
      const glob = parts.findIndex((part) => /[*?{[]/u.test(part));
      return join(ROOT, ...(glob === -1 ? parts : parts.slice(0, glob)));
    };
    const outputs: string[] = config.outputs.map((output: string) =>
      output.replace("{workspaceRoot}/", ""),
    );
    const roots = ["project.json", "nx.json", "scripts/ensure.ts", ...outputs];
    for (const input of config.inputs) {
      if (typeof input === "string") {
        if (input.startsWith("!")) continue;
        if (!input.startsWith("{workspaceRoot}/")) return undefined;
        roots.push(input.replace("{workspaceRoot}/", ""));
      } else if ("runtime" in input && input.runtime in runtimeInputs) {
        hash.update(`${input.runtime}\0${runtimeInputs[input.runtime]}\0`);
      } else if (
        !("externalDependencies" in input) ||
        input.externalDependencies.length > 0
      )
        return undefined;
    }
    const files = new Set(
      roots.flatMap((root) =>
        walkFiles(literalDirectory(root), {
          skip: (entry) => ["node_modules", ".git", "target"].includes(entry),
          includeSymlinks: true,
        }),
      ),
    );
    for (const file of [...files].sort()) {
      const path = relative(ROOT, file);
      const isOutput = outputs.some((output) =>
        /[*?{[]/u.test(output)
          ? matchesGlob(path, output)
          : path === output || path.startsWith(`${output}/`),
      );
      const stat = lstatSync(file, { bigint: true });
      // A link's own stat says nothing about the bytes behind it.
      if (stat.isSymbolicLink()) return undefined;
      hash.update(`${path}\0`);
      if (isOutput && stat.isFile()) hash.update(readFileSync(file));
      else
        hash.update(
          [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino, stat.mode].join(),
        );
      hash.update("\0");
    }
    return hash.digest("hex");
  };
  const before = key();
  if (
    before !== undefined &&
    existsSync(markerPath) &&
    readFileSync(markerPath, "utf8") === before
  ) {
    console.log(`${name}: inputs and outputs unchanged since last ensure`);
    return;
  }
  await ensure();
  if (before !== undefined && key() === before) {
    mkdirSync(join(markerPath, ".."), { recursive: true });
    writeFileSync(markerPath, before);
  }
}

if (target === "generate") {
  if (
    mode === "--postinstall" &&
    !existsSync(join(ROOT, "apps/web/node_modules"))
  ) {
    console.log("generate: skipped (filtered install without apps/web)");
  } else {
    const ensure = async () => {
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
    };
    if (mode === undefined && !nxInsideTask)
      await ensureWithMarker(
        "generate",
        { "node --version": command("node", ["--version"]) },
        ensure,
      );
    else await ensure();
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
  const fingerprint = () => {
    const tools = [
      command("wasm-pack", ["--version"]),
      readFileSync(fileURLToPath(import.meta.url), "utf8"),
    ];
    try {
      tools.push(command("wasm-opt", ["--version"]));
    } catch {
      tools.push("wasm-pack-managed optimizer");
    }
    return rustFingerprint(join(ROOT, "Cargo.toml"), tools);
  };
  if (mode === "--fingerprint") console.log(fingerprint());
  else if (mode === "--build") {
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
  } else if (nxInsideTask) runNxTarget("wasm");
  else
    await ensureWithMarker(
      "wasm",
      { "node scripts/ensure.ts wasm --fingerprint": fingerprint() },
      () => runNxTarget("wasm"),
    );
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
