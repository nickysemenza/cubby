const inertExact = new Set([
  "LICENSE",
  "cubby.code-workspace",
]);

const inertPrefixes = [".agents/", ".claude/", ".codex/", ".vscode/", "docs/"];

const startsWithAny = (path, prefixes) =>
  prefixes.some((prefix) => path.startsWith(prefix));

const isInert = (path) =>
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

// These files can affect every JS workspace or the CI machinery which decides
// what to run. Keeping the list explicit makes a novel root path fail safe.
const sharedRootExact = new Set([
  ".gitignore",
  ".mcp.json.example",
  ".nvmrc",
  ".worktreeinclude",
  "biome.json",
  "codecov.yml",
  "docker-compose.yml",
  "knip.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "security-audit-allowlist.json",
]);

const sharedRootPrefixes = [".github/", ".husky/", "scripts/"];

const isKnownCodePath = (path) =>
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

export function classifyPaths(paths) {
  const changed = [...new Set(paths.filter(Boolean))];
  const active = changed.filter((path) => !isInert(path));
  const unknown = active.some((path) => !isKnownCodePath(path));
  const sharedRoot = active.some(
    (path) =>
      sharedRootExact.has(path) ||
      path === "packages/tsconfig.package.json" ||
      startsWithAny(path, sharedRootPrefixes),
  );

  const web =
    unknown || sharedRoot || active.some((path) => startsWithAny(path, webPrefixes));
  const aux =
    unknown ||
    sharedRoot ||
    active.some((path) => startsWithAny(path, auxTestPrefixes));
  const usda =
    unknown || sharedRoot || active.some((path) => startsWithAny(path, usdaPrefixes));
  const upc =
    unknown || sharedRoot || active.some((path) => startsWithAny(path, upcPrefixes));
  const rust =
    unknown ||
    active.some(
      (path) => path === "rust-toolchain.toml" || startsWithAny(path, rustPrefixes),
    );

  return {
    inert: active.length === 0,
    web,
    rust,
    aux,
    usda,
    upc,
    workers: [
      ...(usda ? ["usda-api"] : []),
      ...(upc ? ["upc-lookup"] : []),
    ],
    unknown,
  };
}
