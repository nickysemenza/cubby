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

const rustPrefixes = ["recipebridge/"];

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
  ".github/workflows/",
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
        path === "apps/web/package.json" ||
        path === "pnpm-lock.yaml" ||
        path.startsWith("apps/web/wrangler") ||
        path.startsWith("apps/web/vite.config"),
    );

  return {
    inert: active.length === 0,
    web,
    rust,
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
