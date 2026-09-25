import { appendFileSync } from "node:fs";

export interface CiChangeScope {
  validation: boolean;
  web: boolean;
  auxiliary: boolean;
  rust: boolean;
  apple: boolean;
  docs: boolean;
  format: boolean;
}

const emptyScope = (): CiChangeScope => ({
  validation: false,
  web: false,
  auxiliary: false,
  rust: false,
  apple: false,
  docs: false,
  format: false,
});

const fullScope = (): CiChangeScope => ({
  validation: true,
  web: true,
  auxiliary: true,
  rust: true,
  apple: true,
  docs: true,
  format: true,
});

const markdown = /\.(?:md|mdx|markdown)$/i;
const formatOnly = /\.(?:ya?ml|toml)$/i;
// The Swift client and catalog are generated (never committed) from the
// entity declarations and the HTTP contracts, so those inputs rebuild Apple.
const appleGeneratorInputs = [
  "apps/web/src/contracts/",
  "apps/web/src/lib/http-api/",
  "apps/web/scripts/apple-preview-fixtures.ts",
  "apps/web/src/lib/test/mock-schema.ts",
];

const sharedConfig = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "nx.json",
  "project.json",
  "tsconfig.json",
  "rust-toolchain.toml",
  ".nvmrc",
  ".oxfmtrc.json",
  ".lintstagedrc.json",
  "redocly.yaml",
]);

// The CI topology, shared toolchain, and root package graph can change any
// lane. Unknown paths deliberately use the same conservative policy.
const unsafePath = (path: string) =>
  !path || path.startsWith("/") || path.split("/").includes("..");

const affectedByPath = (path: string): Partial<CiChangeScope> | null => {
  if (unsafePath(path)) return null;
  if (markdown.test(path))
    return {
      docs: true,
      format: true,
      ...(path.startsWith("docs/") && { web: true }),
    };
  if (
    path.startsWith(".github/") ||
    path.startsWith("scripts/") ||
    sharedConfig.has(path)
  )
    return null;
  if (path.startsWith("apps/apple/") || path.startsWith("cubby-ffi/"))
    return { apple: true };
  if (path.startsWith("recipebridge/"))
    return {
      validation: true,
      web: true,
      auxiliary: true,
      rust: true,
      apple: true,
    };
  if (path.startsWith("packages/"))
    return {
      validation: true,
      web: true,
      auxiliary: true,
      ...(path.startsWith("packages/schemas/") && { apple: true }),
    };
  if (path.startsWith("apps/web/"))
    return {
      validation: true,
      web: true,
      ...(appleGeneratorInputs.some((prefix) => path.startsWith(prefix)) && {
        apple: true,
      }),
    };
  if (
    path.startsWith("apps/mcp-apps/") ||
    path.startsWith("apps/purchase-agent/")
  )
    return { validation: true, web: true, auxiliary: true };
  if (path.startsWith("apps/upc-lookup/") || path.startsWith("apps/usda-api/"))
    return { validation: true, auxiliary: true };
  if (path.startsWith("docker-compose")) return { validation: true, web: true };
  return null;
};

export function classifyCiChanges(
  paths: readonly string[],
  fullVerification = false,
): CiChangeScope {
  if (fullVerification || paths.length === 0) return fullScope();
  const scope = emptyScope();
  for (const path of paths) {
    if (formatOnly.test(path)) scope.format = true;
    const affected = affectedByPath(path);
    if (!affected) return fullScope();
    Object.assign(scope, affected);
  }
  return scope;
}

if (process.argv[1]?.endsWith("ci-change-scope.ts")) {
  const files: unknown = JSON.parse(process.env.CUBBY_CHANGED_FILES ?? "[]");
  if (!Array.isArray(files))
    throw new Error("CUBBY_CHANGED_FILES must be a JSON array of paths.");
  const scope = classifyCiChanges(
    files.map(String),
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
  );
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(
    output,
    Object.entries(scope)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
  );
  process.stdout.write(`CI scope: ${JSON.stringify(scope)}\n`);
}
