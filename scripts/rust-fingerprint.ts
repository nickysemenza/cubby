// Content fingerprint for a Rust build whose inputs live outside Nx's
// workspace: Cargo resolution, every local path dependency (including the
// `[patch]` checkouts in ~/.cargo/config.toml), Cargo configuration, the
// compiler, and the build-affecting environment. Used by ensure.ts for both artifacts.
// A metadata failure must fail closed; restoring an old artifact would hide an
// incompatible local parser checkout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { digestFiles, walkFiles } from "./lib/tree-digest.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Cargo.lock is skipped: the resolved graph it encodes is already hashed via
// `cargo metadata` below, and `cargo metadata` rewrites the lock as it runs
// (the ~/.cargo/config.toml patch turns git entries into path ones), so the
// bytes on disk are a side effect of fingerprinting rather than an input.
// .DS_Store and .claude/ are editor/Finder state that can never be a build
// input; Finder rewrites .DS_Store on browse, which would invalidate every
// artifact for nothing, and a per-checkout .claude/ breaks worktree sharing.
const PRUNE = new Set([
  "target",
  ".git",
  "node_modules",
  "Cargo.lock",
  ".DS_Store",
  ".claude",
]);

// Include assets consumed by include_str!/include_bytes!, additions and deletions.
// Checkout paths and mtimes aren't inputs: identical worktrees share one artifact.
// A missing crate root is a broken input, not an empty one: fail loudly.
export const sourceDigest = (directory: string): string => {
  if (!existsSync(directory))
    throw new Error(`Rust source directory not found: ${directory}`);
  return digestFiles(
    directory,
    walkFiles(directory, { skip: (name) => PRUNE.has(name) }),
  );
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

type CargoPackage = {
  id: string;
  name: string;
  manifest_path: string;
  source: string | null;
};
type CargoDependency = {
  pkg: string;
  dep_kinds: { kind: string | null; target: string | null }[];
};
type CargoNode = { id: string; deps: CargoDependency[]; features: string[] };
type CargoMetadata = {
  packages: CargoPackage[];
  workspace_root: string;
  resolve: { nodes: CargoNode[] };
};

// Cargo metadata omits profiles and inherited lints in a virtual workspace.
// Include shared package settings too: member manifests only name inheritance.
// These settings participate in the marker fast path as well as Nx's key.
const workspaceBuildSettings = (manifest: string): string =>
  [
    ...manifest.matchAll(
      /^[\t ]*\[([^\n]+)\][^\n]*\n([\s\S]*?)(?=^[\t ]*\[|(?![\s\S]))/gm,
    ),
  ]
    .filter((section) =>
      /^(?:profile\.|workspace\.(?:package|lints)(?:\.|$))/u.test(
        section[1] ?? "",
      ),
    )
    .map((section) => section[0])
    .join("");

// This runs before workspace dependencies are installed in the native CI jobs.
// SAFETY: Cargo owns the `--format-version=1` output contract and its command
// failure is already fatal in `command`; these are the only fields consumed.
const parseCargoMetadata = (input: string): CargoMetadata =>
  JSON.parse(input) as CargoMetadata;

// Nx hashes a runtime input's stderr with its stdout, so progress output
// (Cargo's crate downloads, rustup's toolchain sync) must stay captured: it
// varies between cold and warm runners. A failure throws with it attached.
export const command = (program: string, args: string[]) =>
  execFileSync(program, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 26,
  });

// `extra` carries the tool versions and flags specific to one artifact
// (wasm-pack, xcodebuild, the cargo profile); everything Cargo itself reads is
// hashed here.
export const rustFingerprint = (
  manifestPath: string,
  packageNames: string[],
  extra: string[],
  features: string[] = [],
): string => {
  const metadataArgs = [
    "metadata",
    "--format-version=1",
    "--manifest-path",
    manifestPath,
    "--no-default-features",
    ...(features.length ? ["--features", features.join(",")] : []),
  ];
  let metadata: string;
  try {
    // A restored graph needs no registry refresh. Locked mode rejects stale
    // manifests and local overrides that require a new resolution; a cold or
    // incomplete cache falls back to Cargo's existing resolver below.
    metadata = command("cargo", [...metadataArgs, "--locked", "--offline"]);
  } catch {
    metadata = command("cargo", metadataArgs);
  }
  const graph = parseCargoMetadata(metadata);
  const nodes = new Map(graph.resolve.nodes.map((node) => [node.id, node]));
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    const node = nodes.get(id);
    if (!node) throw new Error(`Cargo resolution is missing ${id}`);
    for (const dependency of node.deps) {
      // Keep all target conditions: build scripts and proc macros execute on
      // the host, even when the library is cross-compiled.
      if (dependency.dep_kinds.some(({ kind }) => kind !== "dev"))
        visit(dependency.pkg);
    }
  };
  for (const name of packageNames) {
    const pkg = graph.packages.find(
      (pkg) => pkg.name === name && pkg.source === null,
    );
    if (!pkg) throw new Error(`Cargo artifact root not found: ${name}`);
    visit(pkg.id);
  }
  const packages = graph.packages.filter((pkg) => reachable.has(pkg.id));
  const roots = packages
    .filter((pkg) => pkg.source === null)
    .map((pkg) => dirname(pkg.manifest_path));
  const localPaths = packages
    .filter((pkg) => pkg.source === null)
    .map((pkg) => [dirname(pkg.manifest_path), `<local:${pkg.name}>`] as const)
    .sort(([left], [right]) => right.length - left.length);
  const normalize = (value: string) => {
    for (const [path, replacement] of localPaths)
      value = value.replaceAll(path, replacement);
    return value.replaceAll(ROOT, "<workspace>");
  };
  const hash = createHash("sha256");
  const add = (value: string) => hash.update(normalize(value)).update("\0");
  add(readFileSync(fileURLToPath(import.meta.url), "utf8"));
  add(readFileSync(join(ROOT, "scripts/lib/tree-digest.ts"), "utf8"));
  add(JSON.stringify(packages.map(({ id }) => id).sort()));
  add(
    JSON.stringify(
      graph.resolve.nodes
        .filter((node) => reachable.has(node.id))
        .map(({ id, features, deps }) => ({
          id,
          features,
          deps: deps.filter(
            (dep) =>
              reachable.has(dep.pkg) &&
              dep.dep_kinds.some(({ kind }) => kind !== "dev"),
          ),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
  );
  add(sourceInputs(roots, graph.workspace_root));
  add(
    workspaceBuildSettings(
      readFileSync(join(graph.workspace_root, "Cargo.toml"), "utf8"),
    ),
  );
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
  for (const value of extra) add(value);
  add(
    JSON.stringify(
      Object.entries(process.env)
        // Offline startup strips inherited logging settings. Rust's log filter
        // changes diagnostics, while compiler flags must still invalidate output.
        .filter(
          ([name]) =>
            name !== "RUST_LOG" &&
            /^(CARGO_|RUST|WASM_|CC$|CFLAGS$|AR$)/u.test(name),
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  return hash.digest("hex");
};
