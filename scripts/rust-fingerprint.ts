// Content fingerprint for a Rust build whose inputs live outside Nx's
// workspace: Cargo resolution, every local path dependency (including the
// `[patch]` checkouts in ~/.cargo/config.toml), Cargo configuration, the
// compiler, and the build-affecting environment. Shared by ensure-wasm.ts and
// ensure-apple-ffi.ts so both artifacts key their Nx cache the same way.
// A metadata failure must fail closed; restoring an old artifact would hide an
// incompatible local parser checkout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

type CargoPackage = { manifest_path: string; source: string | null };
type CargoMetadata = { packages: CargoPackage[] };

// This runs before workspace dependencies are installed in the native CI jobs.
// SAFETY: Cargo owns the `--format-version=1` output contract and its command
// failure is already fatal in `command`; these are the only fields consumed.
const parseCargoMetadata = (input: string): CargoMetadata =>
  JSON.parse(input) as CargoMetadata;

export const command = (program: string, args: string[]) =>
  execFileSync(program, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 1 << 26,
  });

// `extra` carries the tool versions and flags specific to one artifact
// (wasm-pack, xcodebuild, the cargo profile); everything Cargo itself reads is
// hashed here.
export const rustFingerprint = (
  manifestPath: string,
  extra: string[],
): string => {
  const metadata = command("cargo", [
    "metadata",
    "--format-version=1",
    "--manifest-path",
    manifestPath,
  ]);
  const roots = new Set(
    parseCargoMetadata(metadata)
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
  for (const value of extra) add(value);
  add(
    JSON.stringify(
      Object.entries(process.env)
        .filter(([name]) => /^(CARGO_|RUST|WASM_|CC$|CFLAGS$|AR$)/u.test(name))
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  return hash.digest("hex");
};

// Runs one cached Nx target of the root `cubby-checks` project. The daemon is
// off so the run is self-contained; without node_modules the nx entry cannot
// resolve, which is the "run pnpm install first" case.
export const runNxTarget = (target: string) => {
  let nx: string;
  try {
    nx = fileURLToPath(import.meta.resolve("nx/bin/nx.js"));
  } catch {
    throw new Error(
      `cannot resolve nx; run \`pnpm install --frozen-lockfile\` before ${target}`,
    );
  }
  execFileSync(process.execPath, [nx, "run", `cubby-checks:${target}`], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, NX_DAEMON: "false" },
  });
};
