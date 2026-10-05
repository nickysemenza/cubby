import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export interface CiChangeScope {
  validation: boolean;
  web: boolean;
  auxiliary: boolean;
  rust: boolean;
  apple: boolean;
  docs: boolean;
  format: boolean;
  /** The optional purchase-import browser lane (never a merge gate). */
  importE2e: boolean;
}

const emptyScope = (): CiChangeScope => ({
  validation: false,
  web: false,
  auxiliary: false,
  rust: false,
  apple: false,
  docs: false,
  format: false,
  importE2e: false,
});

const fullScope = (): CiChangeScope => ({
  validation: true,
  web: true,
  auxiliary: true,
  rust: true,
  apple: true,
  docs: true,
  format: true,
  importE2e: true,
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

// The Worker bundles these skills as agent instructions (?raw imports).
const workerSkills = [
  ".claude/skills/purchase-import/",
  ".claude/skills/product-enrichment/",
  ".claude/skills/photo-inventory-import/",
];
// What the purchase-import browser spec drives: the agent and its server,
// the vendor import start, the Run and Purchase pages, and its harness.
const importE2eInputs = [
  "apps/web/src/server/purchase-import/",
  "apps/web/src/server/purchase-agent/",
  "apps/web/src/app/purchases/",
  "apps/web/src/app/runs/",
  "apps/web/src/app/vendors/order-mail",
  "apps/web/src/routes/_authenticated/runs.",
  "apps/web/tooling/purchase-agent-",
  "apps/web/tests/e2e/harness-services/purchase-",
  "apps/web/tests/e2e/purchase-import-run.spec.ts",
  ".claude/skills/purchase-import/",
  ".claude/skills/product-enrichment/",
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
      ...((path.startsWith("docs/") ||
        workerSkills.some((prefix) => path.startsWith(prefix))) && {
        web: true,
      }),
    };
  if (
    path.startsWith(".github/") ||
    path.startsWith("scripts/") ||
    sharedConfig.has(path)
  )
    return null;
  if (path.startsWith("apps/apple/")) return { apple: true };
  if (path.startsWith("cubby-ffi/")) return { rust: true, apple: true };
  if (
    path.startsWith("recipebridge/") ||
    path === "Cargo.toml" ||
    path === "Cargo.lock"
  )
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
  if (path.startsWith("apps/mcp-apps/"))
    return { validation: true, web: true, auxiliary: true };
  if (path.startsWith("apps/usda-api/"))
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
    if (importE2eInputs.some((prefix) => path.startsWith(prefix)))
      scope.importE2e = true;
  }
  return scope;
}

const changedPaths = (): string[] => {
  const event = process.env.GITHUB_EVENT_NAME;
  if (event !== "pull_request" && event !== "push") return [];
  const base = process.env.CUBBY_BASE_SHA;
  const head = process.env.CUBBY_HEAD_SHA;
  const sha = /^[a-f0-9]{40}$/i;
  if (!base || !head || !sha.test(base) || !sha.test(head)) return [];
  // PRs compare against the merge base; pushes compare their exact old tip.
  // Disabling rename detection retains both old and new owners' checks.
  const range = `${base}${event === "pull_request" ? "..." : ".."}${head}`;
  try {
    return execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", range, "--"],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    console.warn(
      "CI diff unavailable; running all checks:",
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
};

if (process.argv[1]?.endsWith("ci-change-scope.ts")) {
  const scope = classifyCiChanges(
    changedPaths(),
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
