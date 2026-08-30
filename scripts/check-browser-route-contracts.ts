import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const generatedRoutesPath = join(
  repoRoot,
  "apps/web/src/entities/generated/entity-routes.gen.ts",
);

export function expectedBrowserRouteFiles(): readonly string[] {
  const generated = readFileSync(generatedRoutesPath, "utf8");
  const definitions = generated.matchAll(
    /basePath:"([^"]+)",routes:\{detail:"[^"]+\/(\$[^"]+)",list:"[^"]+"\}/g,
  );
  return [...definitions].flatMap(([, basePath, detailParameter]) => [
    `apps/web/src/routes/_authenticated/${basePath}.index.tsx`,
    `apps/web/src/routes/_authenticated/${basePath}.${detailParameter}.tsx`,
  ]);
}

export function missingBrowserRouteFiles(
  exists: (path: string) => boolean = existsSync,
): readonly string[] {
  return expectedBrowserRouteFiles().filter(
    (relativePath) => !exists(join(repoRoot, relativePath)),
  );
}

if (import.meta.main) {
  const missing = missingBrowserRouteFiles();
  if (missing.length > 0) {
    process.stderr.write(
      `Generated browser routes are missing route modules:\n${missing.map((path) => `- ${path}`).join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
