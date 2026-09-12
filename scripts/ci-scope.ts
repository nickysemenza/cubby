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
  "package.json",
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

  const web =
    unknown ||
    sharedRoot ||
    active.some((path) => startsWithAny(path, webPrefixes));
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
  const rust =
    unknown ||
    active.some(
      (path) =>
        path === "rust-toolchain.toml" || startsWithAny(path, rustPrefixes),
    );
  const wasm =
    unknown ||
    active.some(
      (path) =>
        path === "rust-toolchain.toml" || startsWithAny(path, wasmPrefixes),
    );
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
        highRiskFragments.some((fragment) => path.includes(fragment)) ||
        highRiskExact.has(path) ||
        path === "apps/web/package.json" ||
        path === "pnpm-lock.yaml" ||
        path.startsWith("apps/web/wrangler") ||
        path.startsWith("apps/web/vite.config"),
    );

  return {
    inert: active.length === 0,
    web,
    rust,
    wasm,
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
  | "web-tests"
  | "postgres"
  | "e2e"
  | "cloudflare"
  | "aux"
  | "rust"
  | "apple";

export function selectPushChecks(
  paths: readonly string[],
  forceFull = false,
): readonly PushCheck[] {
  const scope = classifyPaths(paths);
  if (forceFull || scope.highRisk)
    return ["rust", "aux", "cloudflare", "all-tests", "apple"];
  if (scope.inert) return [];

  return [
    ...(scope.web
      ? ([scope.postgres ? "postgres" : "web-tests"] as const)
      : []),
    ...(scope.cloudflare || scope.e2e || scope.highRisk
      ? (["cloudflare"] as const)
      : []),
    ...(scope.e2e || scope.highRisk ? (["e2e"] as const) : []),
    ...(scope.aux ? (["aux"] as const) : []),
    ...(scope.rust ? (["rust"] as const) : []),
    ...(scope.apple ? (["apple"] as const) : []),
  ];
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

const resolveBase = (): string => {
  if (process.env.CUBBY_VERIFY_BASE) return process.env.CUBBY_VERIFY_BASE;
  try {
    return capture("git", ["merge-base", "HEAD", "origin/main"]);
  } catch {
    return capture("git", ["rev-parse", "HEAD^"]);
  }
};

const run = (command: string, arguments_: readonly string[]) => {
  const display = [command, ...arguments_].join(" ");
  process.stdout.write(`\n[pre-push] ${display}\n`);
  const result = spawnSync(command, arguments_, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
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

const runRustCheck = () => {
  // Two independent manifests (no shared workspace): recipebridge feeds
  // the WASM package, cubby-ffi is the native UniFFI target. Same gates,
  // run once per manifest.
  for (const manifest of ["recipebridge/Cargo.toml", "cubby-ffi/Cargo.toml"]) {
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
    "apps/apple/CubbyKit/Sources/cubby",
    "apps/apple/CubbyKit/Tests",
  ];
};

const runAppleCheck = () => {
  const xcodeSelect = spawnSync("xcode-select", ["-p"]);
  if (xcodeSelect.error || xcodeSelect.status !== 0) {
    process.stdout.write(
      "[pre-push] Skipping apple checks: Xcode not installed (xcode-select -p failed).\n",
    );
    return;
  }
  run("apps/apple/scripts/build-rust.sh", ["--check"]);
  run("xcodegen", ["generate", "--spec", "apps/apple/project.yml"]);
  run("swift", [
    "format",
    "lint",
    "--strict",
    "--configuration",
    "apps/apple/.swift-format",
    "--recursive",
    ...swiftFormatTargets(),
  ]);
  run("swift", ["test", "--package-path", "apps/apple/CubbyKit"]);
  run("apps/apple/scripts/check-openapi-drift.sh", []);
  run("xcodebuild", [
    "-project",
    "apps/apple/Cubby.xcodeproj",
    "-scheme",
    "Cubby-iOS",
    "-destination",
    "generic/platform=iOS Simulator",
    "build",
  ]);
};

const runPushCheck = (check: PushCheck, base: string, full: boolean) => {
  switch (check) {
    case "all-tests":
      return run("pnpm", ["test:all"]);
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
      return runRustCheck();
    case "apple":
      return runAppleCheck();
  }
};

const verifyPush = () => {
  requireCommittedCode();
  const base = resolveBase();
  const paths = capture("git", ["diff", "--name-only", `${base}...HEAD`])
    .split("\n")
    .filter(Boolean);
  const scope = classifyPaths(paths);
  const full = process.argv.includes("--full") || scope.highRisk;
  const checks = selectPushChecks(paths, full);

  if (checks.length === 0) {
    process.stdout.write(
      "[pre-push] No code changes require scoped verification.\n",
    );
    return;
  }

  process.stdout.write(
    `[pre-push] ${paths.length} changed paths from ${base}; running ${checks.join(", ")}.\n`,
  );

  if (full || scope.wasm || scope.dependencies) {
    run("pnpm", ["wasm"]);
    run("pnpm", ["install", "--frozen-lockfile"]);
  }
  run("pnpm", [full ? "check:all" : "check"]);
  if (full || scope.dependencies) run("pnpm", ["dedupe:check"]);

  for (const check of checks) runPushCheck(check, base, full);
};

if (import.meta.main) verifyPush();
