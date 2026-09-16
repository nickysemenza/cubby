import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const inertExact = new Set(["LICENSE", "cubby.code-workspace"]);

const inertPrefixes = [".agents/", ".claude/", ".codex/", ".vscode/", "docs/"];

const startsWithAny = (path: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => path.startsWith(prefix));

const isInert = (path: string) =>
  path.endsWith(".md") ||
  inertExact.has(path) ||
  startsWithAny(path, inertPrefixes);

const webPrefixes = [
  "apps/mcp-apps/",
  "apps/web/",
  "packages/design-tokens/",
  "packages/schemas/",
  "packages/shared/",
  "packages/upc-contract/",
  "packages/usda-contract/",
  "packages/usda-schemas/",
  "packages/wasm/",
  "recipebridge/",
];

const auxTestPrefixes = [
  "apps/mcp-apps/",
  "apps/upc-lookup/",
  "apps/usda-api/",
  "packages/schemas/",
  "packages/shared/",
  "packages/upc-contract/",
  "packages/usda-contract/",
  "packages/usda-schemas/",
  "packages/worker-tracing/",
];

const usdaPrefixes = [
  "apps/usda-api/",
  "packages/usda-contract/",
  "packages/usda-schemas/",
  "packages/worker-tracing/",
];

const upcPrefixes = [
  "apps/upc-lookup/",
  "packages/shared/",
  "packages/upc-contract/",
  "packages/usda-schemas/",
  "packages/worker-tracing/",
];

const rustPrefixes = ["recipebridge/", "cubby-ffi/"];
// Only recipebridge feeds the WASM package the web app consumes; cubby-ffi is
// a separate UniFFI target that never touches `packages/wasm`.
const wasmPrefixes = ["recipebridge/"];
const ffiPrefixes = ["cubby-ffi/"];
const applePrefixes = ["apps/apple/", "cubby-ffi/"];

const postgresPrefixes = [
  "apps/web/drizzle/",
  "apps/web/src/server/db/",
  "apps/web/src/server/entity-kernel/",
  "apps/web/src/server/repo/",
  "apps/web/src/server/services/",
  "apps/web/src/server/workflows/",
];

const e2ePrefixes = [
  "apps/web/tests/e2e/",
  "apps/web/src/routes/",
  "apps/web/src/app/auth/",
  "apps/web/src/app/_components/navigation/",
  "apps/web/src/app/_components/routing/",
];

const e2eExact = new Set([
  "apps/web/playwright.config.ts",
  "apps/web/vite.config.ts",
]);

const highRiskPrefixes = [
  ".github/",
  "apps/web/tooling/",
  "apps/web/drizzle/",
  "apps/web/src/app/auth/",
  "apps/web/src/app/expenses/",
  "apps/web/src/app/finance/",
  "apps/web/src/app/inventory/",
  "apps/web/src/routes/api/auth/",
  "apps/web/src/server/entity-kernel/",
  "apps/web/src/server/oauth/",
  "apps/web/src/server/repo/expense/",
  "apps/web/src/server/repo/inventory/",
  "apps/web/src/server/repo/merge/",
  "apps/web/src/server/repo/removal/",
];

const highRiskFragments = [
  ".integration.test.",
  "/auth.",
  "/delete",
  "/expense",
  "/inventory",
  "/ledger",
  "/merge",
  "/money",
  "/shortcode",
  "/transaction",
];

const highRiskExact = new Set([
  "apps/web/playwright.config.ts",
  "apps/web/vitest.config.ts",
  "scripts/ci-scope.ts",
]);

const sharedRootExact = new Set([
  ".gitignore",
  ".mcp.json.example",
  ".nvmrc",
  ".worktreeinclude",
  ".oxfmtrc.json",
  ".oxlintrc.json",
  "codecov.yml",
  "docker-compose.yml",
  "knip.json",
  "nx.json",
  "package.json",
  "project.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "security-audit-allowlist.json",
]);

const sharedRootPrefixes = [".github/", ".husky/", "scripts/"];

const isKnownCodePath = (path: string) =>
  startsWithAny(path, [
    ...webPrefixes,
    ...auxTestPrefixes,
    "packages/worker-tracing/",
    ...rustPrefixes,
    ...applePrefixes,
  ]) ||
  path === "rust-toolchain.toml" ||
  path === "packages/tsconfig.package.json" ||
  sharedRootExact.has(path) ||
  startsWithAny(path, sharedRootPrefixes);

const isPresentPath = (path: string | null | undefined): path is string =>
  typeof path === "string" && path.length > 0;

export function classifyPaths(paths: readonly (string | null | undefined)[]) {
  const changed = [...new Set(paths.filter(isPresentPath))];
  const active = changed.filter((path) => !isInert(path));
  const unknown = active.some((path) => !isKnownCodePath(path));
  const dependencies =
    unknown ||
    active.some(
      (path) =>
        path === "pnpm-lock.yaml" ||
        path === "pnpm-workspace.yaml" ||
        path.endsWith("/package.json") ||
        path === "package.json" ||
        path.startsWith("patches/"),
    );
  const sharedRoot = active.some(
    (path) =>
      sharedRootExact.has(path) ||
      path === "packages/tsconfig.package.json" ||
      startsWithAny(path, sharedRootPrefixes),
  );

  // `web` says the web app may be affected (shared root config and unknown
  // paths count); `webSource` says a web source path itself changed, which is
  // what `vitest --changed` can select tests for.
  const webSource = active.some((path) => startsWithAny(path, webPrefixes));
  const web = unknown || sharedRoot || webSource;
  const aux =
    unknown ||
    sharedRoot ||
    active.some((path) => startsWithAny(path, auxTestPrefixes));
  const usda =
    unknown ||
    sharedRoot ||
    active.some((path) => startsWithAny(path, usdaPrefixes));
  const upc =
    unknown ||
    sharedRoot ||
    active.some((path) => startsWithAny(path, upcPrefixes));
  const wasm =
    unknown ||
    active.some(
      (path) =>
        path === "rust-toolchain.toml" || startsWithAny(path, wasmPrefixes),
    );
  const ffi =
    unknown ||
    active.some(
      (path) =>
        path === "rust-toolchain.toml" || startsWithAny(path, ffiPrefixes),
    );
  const rust = wasm || ffi;
  const apple =
    unknown || active.some((path) => startsWithAny(path, applePrefixes));

  const postgres =
    unknown ||
    active.some(
      (path) =>
        startsWithAny(path, postgresPrefixes) ||
        path.includes(".integration.test."),
    );
  const e2e =
    unknown ||
    active.some(
      (path) => startsWithAny(path, e2ePrefixes) || e2eExact.has(path),
    );
  const cloudflare = web;
  const highRisk =
    unknown ||
    active.some(
      (path) =>
        startsWithAny(path, highRiskPrefixes) ||
        // Fragments name server money/ledger/removal seams; UI files that
        // merely mention inventory/expense/delete are not high-risk.
        (path.startsWith("apps/web/src/server/") &&
          highRiskFragments.some((fragment) => path.includes(fragment))) ||
        highRiskExact.has(path) ||
        path === "apps/web/package.json" ||
        path === "pnpm-lock.yaml" ||
        path.startsWith("apps/web/wrangler") ||
        path.startsWith("apps/web/vite.config"),
    );

  return {
    inert: active.length === 0,
    web,
    webSource,
    rust,
    wasm,
    ffi,
    apple,
    aux,
    usda,
    upc,
    workers: [...(usda ? ["usda-api"] : []), ...(upc ? ["upc-lookup"] : [])],
    dependencies,
    unknown,
    postgres,
    e2e,
    cloudflare,
    highRisk,
  };
}

export type PushCheck =
  | "all-tests"
  | "fast-tests"
  | "web-tests"
  | "postgres"
  | "e2e"
  | "cloudflare"
  | "aux"
  | "rust"
  | "apple";

export type RustManifest = "recipebridge/Cargo.toml" | "cubby-ffi/Cargo.toml";

// `--changed` selects tests that import a changed web source file; a shared
// root or unknown change has none, so it runs the whole fast tier instead.
const webLane = (scope: ReturnType<typeof classifyPaths>): PushCheck =>
  scope.postgres ? "postgres" : scope.webSource ? "web-tests" : "fast-tests";

// Shared by selectVerifyChecks' non-full path and the (highRisk-free) push
// selection below: callers decide when highRisk should escalate to full.
function scopedChecks(
  scope: ReturnType<typeof classifyPaths>,
): readonly PushCheck[] {
  return [
    ...(scope.web ? [webLane(scope)] : []),
    ...(scope.cloudflare || scope.e2e ? (["cloudflare"] as const) : []),
    ...(scope.e2e ? (["e2e"] as const) : []),
    ...(scope.aux ? (["aux"] as const) : []),
    ...(scope.rust ? (["rust"] as const) : []),
    ...(scope.apple ? (["apple"] as const) : []),
  ];
}

export function selectVerifyChecks(
  paths: readonly string[],
  forceFull = false,
): readonly PushCheck[] {
  const scope = classifyPaths(paths);
  if (forceFull || scope.highRisk)
    return ["rust", "aux", "cloudflare", "all-tests", "apple"];
  if (scope.inert) return [];

  return scopedChecks(scope);
}

export type PushSelection = {
  checks: readonly PushCheck[];
  manifests: readonly RustManifest[];
  warning?: string;
  wasm: boolean;
  dependencies: boolean;
};

// Pre-push is fast and scoped: JS lanes fail safe from the raw diff (an
// unrecognised path still runs every JS gate), but native lanes (rust, apple)
// and Rust manifests only run when a KNOWN path actually touches them — an
// unrecognised path must never trigger a Rust/Xcode toolchain pre-push, only
// a warning telling the pusher to run the full verify:local gate. highRisk is
// never consulted here: pre-push never escalates to "all-tests" on its own.
export function selectPushChecks(paths: readonly string[]): PushSelection {
  const scope = classifyPaths(paths);
  if (scope.inert)
    return { checks: [], manifests: [], wasm: false, dependencies: false };

  const known = classifyPaths(paths.filter(isKnownCodePath));

  const checks: PushCheck[] = [
    ...(scope.web ? [webLane(known)] : []),
    ...(scope.cloudflare || known.e2e ? (["cloudflare"] as const) : []),
    ...(known.e2e ? (["e2e"] as const) : []),
    ...(scope.aux ? (["aux"] as const) : []),
    ...(known.rust ? (["rust"] as const) : []),
    ...(known.apple ? (["apple"] as const) : []),
  ];

  const manifests: RustManifest[] = [
    ...(known.wasm ? (["recipebridge/Cargo.toml"] as const) : []),
    ...(known.ffi ? (["cubby-ffi/Cargo.toml"] as const) : []),
  ];

  const unrecognised = paths
    .filter((path) => !isInert(path) && !isKnownCodePath(path))
    .join(", ");
  const warning = scope.unknown
    ? `Unrecognised path(s): ${unrecognised}. Pre-push ran the JavaScript gates only; run pnpm verify:local before merging.`
    : undefined;

  return {
    checks,
    manifests,
    warning,
    wasm: known.wasm,
    dependencies: scope.dependencies,
  };
}

const capture = (command: string, arguments_: readonly string[]): string => {
  const result = spawnSync(command, arguments_, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `${command} exited ${result.status}`,
    );
  }
  return result.stdout.trim();
};

type ResolvedBase = { sha: string; fallback: boolean };

const resolveBase = (): ResolvedBase => {
  if (process.env.CUBBY_VERIFY_BASE)
    return { sha: process.env.CUBBY_VERIFY_BASE, fallback: false };
  try {
    return {
      sha: capture("git", ["merge-base", "HEAD", "origin/main"]),
      fallback: false,
    };
  } catch {
    return { sha: capture("git", ["rev-parse", "HEAD^"]), fallback: true };
  }
};

// Mutated once, at start-up, by main(): "[verify:local]" for pnpm
// verify:local(:full), "[verify:push]" for the pre-push gate.
let label = "[verify:local]";

const run = (command: string, arguments_: readonly string[]) => {
  const display = [command, ...arguments_].join(" ");
  process.stdout.write(`\n${label} ${display}\n`);
  const start = performance.now();
  const result = spawnSync(command, arguments_, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const seconds = (performance.now() - start) / 1000;
  process.stdout.write(`${label} ${display} ✓ ${seconds.toFixed(1)}s\n`);
};

const requireCommittedCode = () => {
  const dirty = [
    ...capture("git", ["diff", "--name-only", "HEAD"]).split("\n"),
    ...capture("git", ["ls-files", "--others", "--exclude-standard"]).split(
      "\n",
    ),
  ].filter(Boolean);
  if (dirty.some((path) => !classifyPaths([path]).inert)) {
    throw new Error(
      "Commit or stash uncommitted code before verifying the committed revision.",
    );
  }
};

const runAuxCheck = (full: boolean) => {
  if (!full)
    run("pnpm", [
      "-r",
      "--no-sort",
      "--workspace-concurrency=4",
      "--no-bail",
      "--filter",
      "!@cubby/web",
      "--if-present",
      "run",
      "test",
    ]);
  run("pnpm", ["--filter", "@cubby/usda-api", "build"]);
  run("pnpm", ["--filter", "@cubby/upc-lookup", "build"]);
};

const runRustCheck = (manifests: readonly RustManifest[]) => {
  // Two independent manifests (no shared workspace): recipebridge feeds
  // the WASM package, cubby-ffi is the native UniFFI target. Same gates,
  // run once per manifest.
  for (const manifest of manifests) {
    run("cargo", ["fmt", "--manifest-path", manifest, "--check"]);
    run("cargo", [
      "clippy",
      "--manifest-path",
      manifest,
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ]);
    run("cargo", ["test", "--manifest-path", manifest]);
  }
};

// swift-format's --recursive can't exclude a subdirectory, and
// CubbyKit/Sources/CubbyKit/Generated is emitter-owned (see apps/apple/CLAUDE.md) and must never
// be reformatted or linted. List that directory's other children instead of hand-maintaining
// them, so a newly added sibling is picked up without touching this file.
// Sources/CubbyAPI (swift-openapi-generator's whole target) is a sibling of Sources/CubbyKit, so
// it is never enumerated here — keep it that way; it is generated end to end.
const swiftFormatTargets = () => {
  const cubbyKitDir = "apps/apple/CubbyKit/Sources/CubbyKit";
  const siblingsOfGenerated = readdirSync(cubbyKitDir, { withFileTypes: true })
    .filter(
      (entry) => entry.name !== "Generated" && !entry.name.startsWith("."),
    )
    .map((entry) => `${cubbyKitDir}/${entry.name}`);
  return [
    ...siblingsOfGenerated,
    "apps/apple/App",
    "apps/apple/CubbyKit/Sources/CubbyAPISupport",
    "apps/apple/CubbyKit/Sources/cubby",
    "apps/apple/CubbyKit/Tests",
  ];
};

export const runAppleCheck = () => {
  const xcodeSelect = spawnSync("xcode-select", ["-p"]);
  if (xcodeSelect.error || xcodeSelect.status !== 0) {
    process.stdout.write(
      `${label} Skipping apple checks: Xcode not installed (xcode-select -p failed).\n`,
    );
    return;
  }
  // The xcframework + shim come from the Nx cache when the Rust tree is
  // unchanged; a stale committed shim shows up as a dirty path afterwards.
  // `requireCommittedCode` has already run, so the tree equals HEAD here and
  // `status --porcelain` (which also sees an untracked new file, unlike
  // `diff --exit-code`) judges the pushed revision.
  run("node", ["scripts/ensure-apple-ffi.ts"]);
  const shim = "apps/apple/CubbyKit/Sources/CubbyFFI/cubby_ffi.swift";
  if (capture("git", ["status", "--porcelain", "--", shim]) !== "") {
    throw new Error(
      `${shim} is stale for the current Rust sources; commit the regenerated file.`,
    );
  }
  run("xcodegen", [
    "generate",
    "--spec",
    "apps/apple/project.yml",
    "--use-cache",
  ]);
  run("swift", [
    "format",
    "lint",
    "--strict",
    "--configuration",
    "apps/apple/.swift-format",
    "--recursive",
    ...swiftFormatTargets(),
  ]);
  // A bare `swift test` re-resolves and rewrites CubbyKit/Package.resolved
  // (only the originHash, which differs per tool and checkout path), leaving
  // the tree dirty after every push. Frozen-lockfile semantics instead: pins
  // change only via a deliberate `swift package update` in CubbyKit.
  run("swift", [
    "test",
    "--package-path",
    "apps/apple/CubbyKit",
    "--force-resolved-versions",
  ]);
  run("apps/apple/scripts/generate-openapi.sh", ["--check"]);
  // Same DerivedData as `pnpm apple`, so this build is incremental over the
  // dev loop's instead of a second full compile of CubbyKit. The index store
  // has no reader in a command-line build.
  run("xcodebuild", [
    "-project",
    "apps/apple/Cubby.xcodeproj",
    "-scheme",
    "Cubby-iOS",
    "-destination",
    "generic/platform=iOS Simulator",
    "-derivedDataPath",
    "apps/apple/DerivedData",
    "COMPILER_INDEX_STORE_ENABLE=NO",
    "build",
  ]);
};

const runPushCheck = (
  check: PushCheck,
  base: string,
  full: boolean,
  manifests: readonly RustManifest[],
) => {
  switch (check) {
    case "all-tests":
      return run("pnpm", ["test:all"]);
    case "fast-tests":
      return run("pnpm", ["test"]);
    case "web-tests":
      return run("pnpm", ["test:changed", base]);
    case "postgres":
      return run("pnpm", ["test:changed:postgres", base]);
    case "e2e":
      return run("pnpm", ["test:e2e"]);
    case "cloudflare":
      return run("pnpm", ["--filter", "@cubby/web", "run", "build:cf"]);
    case "aux":
      return runAuxCheck(full);
    case "rust":
      return runRustCheck(manifests);
    case "apple":
      return runAppleCheck();
  }
};

const bothRustManifests: readonly RustManifest[] = [
  "recipebridge/Cargo.toml",
  "cubby-ffi/Cargo.toml",
];

const runVerify = (paths: readonly string[], base: string) => {
  const scope = classifyPaths(paths);
  const full = process.argv.includes("--full") || scope.highRisk;
  const checks = selectVerifyChecks(paths, full);

  if (checks.length === 0) {
    process.stdout.write(
      `${label} No code changes require scoped verification.\n`,
    );
    return;
  }

  process.stdout.write(
    `${label} ${paths.length} changed paths from ${base}; running ${checks.join(", ")}.\n`,
  );

  if (full || scope.wasm || scope.dependencies) {
    run("pnpm", ["wasm"]);
    run("pnpm", ["install", "--frozen-lockfile"]);
  }
  run("pnpm", [full ? "check:all" : "check"]);
  if (full || scope.dependencies) run("pnpm", ["dedupe:check"]);

  const manifests: readonly RustManifest[] = full
    ? bothRustManifests
    : [
        ...(scope.wasm ? (["recipebridge/Cargo.toml"] as const) : []),
        ...(scope.ffi ? (["cubby-ffi/Cargo.toml"] as const) : []),
      ];

  for (const check of checks) runPushCheck(check, base, full, manifests);
};

const runPush = (paths: readonly string[], base: string) => {
  const { checks, manifests, warning, wasm, dependencies } =
    selectPushChecks(paths);

  if (warning) process.stdout.write(`${label} ${warning}\n`);

  if (checks.length === 0) {
    process.stdout.write(
      `${label} No code changes require scoped verification.\n`,
    );
    return;
  }

  process.stdout.write(
    `${label} ${paths.length} changed paths from ${base}; running ${checks.join(", ")}.\n`,
  );

  if (wasm) run("pnpm", ["wasm"]);
  if (dependencies) run("pnpm", ["install", "--frozen-lockfile"]);
  // pre-commit already ran `pnpm check` on the staged tree, but an --amend,
  // rebase, or `commit -n` can produce a HEAD pre-commit never saw — rerun it
  // here; the Nx cache makes the repeat cheap when nothing actually changed.
  // Never check:all here: that full gate belongs to verify:local(:full).
  run("pnpm", ["check"]);
  if (dependencies) run("pnpm", ["dedupe:check"]);

  for (const check of checks) runPushCheck(check, base, false, manifests);
};

const main = () => {
  const start = performance.now();
  const mode = process.argv.includes("--push") ? "push" : "verify";
  if (mode === "push" && process.argv.includes("--full")) {
    throw new Error(
      "--full belongs to pnpm verify:local:full, not the push gate.",
    );
  }
  if (mode === "push") label = "[verify:push]";

  requireCommittedCode();
  const { sha: base, fallback } = resolveBase();
  process.stdout.write(
    `${label} base ${base}${fallback ? " (fallback HEAD^: origin/main unavailable)" : ""}\n`,
  );
  const paths = capture("git", ["diff", "--name-only", `${base}...HEAD`])
    .split("\n")
    .filter(Boolean);

  if (mode === "verify") runVerify(paths, base);
  else runPush(paths, base);

  const totalSeconds = (performance.now() - start) / 1000;
  process.stdout.write(`${label} total ${totalSeconds.toFixed(1)}s\n`);
};

if (import.meta.main) main();
