#!/usr/bin/env node
// Nx owns artifact storage and eviction. This existing entrypoint supplies the
// Rust inputs outside Nx's workspace: Cargo resolution, local path dependencies,
// compiler configuration and tool versions. A metadata failure must fail closed;
// restoring an old package would hide an incompatible local parser checkout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRUNE = new Set(["target", ".git", "node_modules"]);

// Include assets consumed by include_str!/include_bytes!, additions and deletions.
// Checkout paths and mtimes aren't inputs: identical worktrees share one artifact.
export const sourceDigest = (directory: string): string => {
  const hash = createHash("sha256");
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    if (PRUNE.has(entry.name)) continue;
    const path = join(directory, entry.name);
    const digest = entry.isDirectory()
      ? sourceDigest(path)
      : createHash("sha256").update(readFileSync(path)).digest("hex");
    hash.update(JSON.stringify([entry.name, digest]));
  }
  return hash.digest("hex");
};

export const sourceInputs = (roots: string[], workspace: string): string =>
  JSON.stringify(
    roots
      .map((root): [string, string] => [
        root.replaceAll(workspace, "<workspace>"),
        sourceDigest(root),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );

export const cargoMetadataSchema = z.object({
  packages: z.array(
    z.object({
      manifest_path: z.string(),
      source: z.string().nullable(),
    }),
  ),
});

const command = (program: string, args: string[]) =>
  execFileSync(program, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 1 << 26,
  });

const fingerprint = () => {
  const metadata = command("cargo", [
    "metadata",
    "--format-version=1",
    "--manifest-path",
    join(ROOT, "recipebridge/Cargo.toml"),
  ]);
  const roots = new Set(
    cargoMetadataSchema
      .parse(JSON.parse(metadata))
      .packages.filter((pkg) => pkg.source === null)
      .map((pkg) => dirname(pkg.manifest_path)),
  );
  const hash = createHash("sha256");
  const add = (value: string) =>
    hash.update(value.replaceAll(ROOT, "<workspace>"));
  add(metadata);
  add(sourceInputs([...roots], ROOT));
  // Cargo reads configuration from the invocation directory's ancestors and
  // CARGO_HOME. Preserve that behavior, including explicit local dev overrides.
  const configDirectories = new Set([
    process.env.CARGO_HOME ?? join(homedir(), ".cargo"),
  ]);
  for (let path = ROOT; ; path = dirname(path)) {
    configDirectories.add(join(path, ".cargo"));
    if (dirname(path) === path) break;
  }
  for (const directory of configDirectories) {
    for (const name of ["config", "config.toml"]) {
      const path = join(directory, name);
      if (existsSync(path)) add(readFileSync(path, "utf8"));
    }
  }
  add(command("rustc", ["-vV"]));
  add(command("wasm-pack", ["--version"]));
  // wasm-pack can provision its own optimizer when none is installed on PATH.
  try {
    add(command("wasm-opt", ["--version"]));
  } catch {
    add("wasm-pack-managed optimizer");
  }
  add(
    JSON.stringify(
      Object.entries(process.env)
        .filter(([name]) => /^(CARGO_|RUST|WASM_|CC$|CFLAGS$|AR$)/u.test(name))
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  return hash.digest("hex");
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "--fingerprint") {
    console.log(fingerprint());
  } else {
    execFileSync(
      process.execPath,
      [
        fileURLToPath(import.meta.resolve("nx/bin/nx.js")),
        "run",
        "cubby-checks:wasm",
      ],
      {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, NX_DAEMON: "false" },
      },
    );
  }
}
