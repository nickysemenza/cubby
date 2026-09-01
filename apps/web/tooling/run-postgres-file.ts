import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultWebRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolvePostgresFamily(
  requested: string,
  webRoot = defaultWebRoot,
): string {
  const requestedPath = resolve(webRoot, requested);
  const familyRoot = resolve(webRoot, "src/server/integration-families");
  if (requestedPath.startsWith(`${familyRoot}/`)) {
    return relative(webRoot, requestedPath);
  }

  const matches = readdirSync(familyRoot)
    .filter((name) => name.endsWith(".integration.test.ts"))
    .flatMap((name) => {
      const familyPath = resolve(familyRoot, name);
      const source = readFileSync(familyPath, "utf8");
      const imports = [...source.matchAll(/^import "([^"]+)";$/gmu)].map(
        (match) => resolve(dirname(familyPath), `${match[1]}.ts`),
      );
      return imports.includes(requestedPath) ? [familyPath] : [];
    });

  const [match] = matches;
  if (!match || matches.length !== 1) {
    throw new Error(
      `Expected one PostgreSQL family for ${requested}; found ${matches.length}`,
    );
  }
  return relative(webRoot, match);
}

if (import.meta.main) {
  const [requested, ...arguments_] = process.argv.slice(2);
  if (!requested) {
    throw new Error("test:file:postgres requires a contract or family path");
  }
  const family = resolvePostgresFamily(requested);
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--project",
      "integration",
      family,
      ...arguments_,
    ],
    { cwd: defaultWebRoot, stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
