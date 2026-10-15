import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// Layout guard for the domain-first tree (docs/adr/0019-domain-first-server-layout.md).
// Baselines are shrink-only: a listed folder may not grow, and one that drops
// to the limit must leave the list.

const repoRoot = join(import.meta.dirname, "../../..");
const tracked = execFileSync(
  "git",
  [
    "-C",
    repoRoot,
    "ls-files",
    "apps/web/src",
    "apps/web/tests",
    "apps/web/generator",
  ],
  {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  },
)
  .split("\n")
  .filter(Boolean);

/** TanStack route files carry URL params (`$accountView`); their names are URL contract. */
const isRouteFile = (path: string) =>
  path.startsWith("apps/web/src/routes/") ||
  path === "apps/web/src/routeTree.gen.ts";
const isSource = (path: string) =>
  /\.(ts|tsx)$/.test(path) && !path.endsWith(".d.ts");
const isTest = (path: string) => /\.(test|spec)\.tsx?$/.test(path);

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SERVER_TOP_LEVEL = new Set([
  "ai",
  "cf-env.ts",
  "clients",
  "db",
  "db.ts",
  "domains",
  "entity-kernel",
  "errors",
  "generated",
  "generic",
  "http",
  "lib",
  "mcp",
  "observability",
  "operation-runtime",
  "testing",
  "worker-bindings.ts",
  "workflows",
]);
const ROLE_ENTRY = /^(repo|service|operations)(\.[a-z0-9.-]+)?$/;
const MAX_DIRECT_SOURCE_FILES = 40;
const CROWDED_FOLDERS = {
  "apps/web/src/contracts": 60,
  "apps/web/src/features/recipe": 51,
  "apps/web/src/lib": 89,
  "apps/web/src/server/domains/product/repo": 43,
  "apps/web/src/ui/data-table": 52,
  "apps/web/src/ui/primitives": 54,
} satisfies Record<string, number>;

describe("repository layout", () => {
  it("names TS/TSX files and folders in kebab-case", () => {
    const offenders = tracked.filter((path) => {
      if (isRouteFile(path)) return false;
      // Playwright owns its `<spec>-snapshots` folder names.
      const segments = path
        .split("/")
        .slice(2)
        .filter((segment) => !segment.endsWith("-snapshots"));
      const file = segments.pop()!;
      const folderBad = segments.some((segment) => !KEBAB.test(segment));
      const fileBad =
        isSource(path) &&
        file
          .split(".")
          .some(
            (part, index, parts) =>
              index < parts.length - 1 && !KEBAB.test(part),
          );
      return folderBad || fileBad;
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the server top level to its platform folders", () => {
    const entries = new Set(
      tracked
        .filter((path) => path.startsWith("apps/web/src/server/"))
        .map(
          (path) => path.slice("apps/web/src/server/".length).split("/")[0]!,
        ),
    );
    expect(
      [...entries].filter((entry) => !SERVER_TOP_LEVEL.has(entry)),
    ).toEqual([]);
  });

  it("gives every domain and generic capability folder only role entries", () => {
    const offenders = tracked
      .map((path) =>
        /^apps\/web\/src\/server\/(domains|generic)\/([^/]+)\/([^/]+)/.exec(
          path,
        ),
      )
      .filter((match) => match !== null && !ROLE_ENTRY.test(match[3]!))
      .map((match) => `${match![1]}/${match![2]}/${match![3]}`);
    expect([...new Set(offenders)]).toEqual([]);
  });

  it(`keeps folders at ${MAX_DIRECT_SOURCE_FILES} direct source files or fewer`, () => {
    const counts = new Map<string, number>();
    for (const path of tracked) {
      if (!isSource(path) || isTest(path) || isRouteFile(path)) continue;
      counts.set(dirname(path), (counts.get(dirname(path)) ?? 0) + 1);
    }
    const crowded = Object.fromEntries(
      [...counts]
        .filter(
          ([folder, count]) =>
            count > MAX_DIRECT_SOURCE_FILES || folder in CROWDED_FOLDERS,
        )
        .sort(),
    );
    expect(crowded).toEqual(CROWDED_FOLDERS);
  });
});
