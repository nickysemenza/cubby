/**
 * Derives the route- and feature-directory part of `tests/e2e/spec-areas.ts`
 * from what each E2E spec actually visits, so adding a route or pointing a
 * spec at a new URL cannot leave the affected-spec map stale.
 *
 *   node scripts/generate-spec-areas.ts            # rewrite spec-areas.derived.ts
 *   (e2e-affected.unit.test.ts fails when the committed file has drifted)
 *
 * How a spec maps to source:
 *   1. Collect every absolute-path literal in the spec and the plain helper
 *      modules it imports from `tests/e2e/` (fixtures and harness files are
 *      excluded: their URLs are plumbing, not the page under test).
 *   2. Match each against the TanStack file routes under `src/routes/`.
 *   3. Add the matched route file, plus the `src/app/<feature>/**` directories
 *      it imports directly.
 *
 * What it deliberately does not derive: server repositories, contracts and
 * shared libs. Which of those a spec reaches is not visible in the spec text,
 * so `spec-areas.ts` keeps a small hand-written `SPEC_EXTRA_GLOBS` for them.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Repo-relative globs per spec file name. */
export type SpecGlobMap = Readonly<Record<string, readonly string[]>>;

const WEB = "apps/web";
const HELPER_EXCLUDE = /^(?:e2e-|fixtures-|harness-)/u;

interface FileRoute {
  /** Repo-relative route file, e.g. `apps/web/src/routes/_authenticated/tasks.index.tsx`. */
  file: string;
  /** Path segments; `$` marks a parameter and `*` a splat. */
  segments: string[];
}

function routeSegments(relative: string): string[] {
  const withoutExtension = relative.replace(/\.[jt]sx?$/u, "");
  const segments = withoutExtension
    .split(/[/.]/u)
    // Pathless layouts (`_authenticated`) and ignored files (`-helper`).
    .filter(
      (part) => part !== "" && !part.startsWith("_") && !part.startsWith("-"),
    )
    // `recipes.$id_` opts out of layout nesting; the URL is unchanged.
    .map((part) => part.replace(/_$/u, ""));
  if (segments.at(-1) === "index") segments.pop();
  return segments.map((part) => (part === "$" ? "*" : part));
}

function listRoutes(webDir: string): FileRoute[] {
  const routesDir = path.join(webDir, "src/routes");
  return readdirSync(routesDir, { recursive: true, encoding: "utf8" })
    .filter(
      (name) =>
        /\.tsx?$/u.test(name) &&
        !/\.(?:unit|integration|spec)\.test\./u.test(name) &&
        !name.includes("["),
    )
    .sort()
    .map((name) => ({
      file: `${WEB}/src/routes/${name}`,
      segments: routeSegments(name),
    }));
}

function segmentMatches(route: string, candidate: string): boolean {
  // A parameter matches anything; a templated candidate segment (`${id}`)
  // stands for an id, so it must not select a static route.
  if (route.startsWith("$") || route === "*") return true;
  return !candidate.includes("*") && route === candidate;
}

function routeMatches(route: FileRoute, candidate: string[]): boolean {
  const splat = route.segments.at(-1) === "*";
  if (!splat && route.segments.length !== candidate.length) return false;
  if (splat && candidate.length < route.segments.length - 1) return false;
  return route.segments.every(
    (segment, index) =>
      segment === "*" || segmentMatches(segment, candidate[index] ?? ""),
  );
}

/** Spec text plus the plain helper modules it imports from `tests/e2e/`. */
function specSources(e2eDir: string, spec: string): string {
  const seen = new Set<string>();
  const queue = [spec];
  let text = "";
  for (let name = queue.shift(); name; name = queue.shift()) {
    if (seen.has(name)) continue;
    seen.add(name);
    const file = path.join(e2eDir, name);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    text += `\n${source}`;
    for (const match of source.matchAll(/from\s+["']\.\/([\w.-]+)["']/gu)) {
      const base = match[1]!;
      if (HELPER_EXCLUDE.test(base)) continue;
      queue.push(base.endsWith(".ts") ? base : `${base}.ts`);
    }
  }
  return text;
}

function visitedPaths(source: string): string[][] {
  const found: string[][] = [];
  for (const match of source.matchAll(/(["'`])(\/[^"'`\s]*)\1/gu)) {
    const before = source.slice(Math.max(0, match.index - 60), match.index);
    const raw = match[2]!.replace(/[?#].*$/u, "").replace(/\$\{[^}]*\}/gu, "*");
    // A bare "/" is only a visit when it is the argument of a navigation call.
    if (
      raw === "/" &&
      !/(?:goto\w*|gotoAuthenticatedPage)\([^)]*$/u.test(before)
    )
      continue;
    found.push(raw.split("/").filter(Boolean));
  }
  return found;
}

function featureGlobs(webDir: string, routeFile: string): string[] {
  const source = readFileSync(path.join(webDir, "..", "..", routeFile), "utf8");
  const globs = new Set<string>();
  for (const match of source.matchAll(/from\s+["']~\/app\/([^"']+)["']/gu)) {
    const [feature, ...rest] = match[1]!.split("/");
    // `_components` is shared UI: most areas are all-spec seams
    // (ALL_SPECS_TRIGGERS) and the rest are hand-listed in SPEC_EXTRA_GLOBS.
    if (!feature || feature.startsWith("_")) continue;
    globs.add(
      rest.length > 0
        ? `${WEB}/src/app/${feature}/**`
        : `${WEB}/src/app/${feature}.{ts,tsx}`,
    );
  }
  return [...globs];
}

export function deriveSpecGlobs(webDir: string) {
  const e2eDir = path.join(webDir, "tests/e2e");
  const routes = listRoutes(webDir);
  const result: Record<string, string[]> = {};
  const specs = readdirSync(e2eDir)
    .filter((name) => name.endsWith(".spec.ts"))
    .sort();
  for (const spec of specs) {
    const globs = new Set<string>();
    for (const candidate of visitedPaths(specSources(e2eDir, spec))) {
      const matched = routes.filter((route) => routeMatches(route, candidate));
      // A static route wins over the parameter routes that would also match.
      const exact = matched.filter(
        (route) =>
          !route.segments.some((part) => part.startsWith("$") || part === "*"),
      );
      for (const route of exact.length > 0 ? exact : matched) {
        globs.add(route.file);
        for (const glob of featureGlobs(webDir, route.file)) globs.add(glob);
      }
    }
    result[spec] = [...globs].sort();
  }
  return result;
}

export function renderGenerated(derived: SpecGlobMap): string {
  const entries = Object.entries(derived)
    .map(
      ([spec, globs]) =>
        `  ${JSON.stringify(spec)}: [${globs.map((g) => JSON.stringify(g)).join(", ")}],`,
    )
    .join("\n");
  return `// Generated by apps/web/scripts/generate-spec-areas.ts. Do not edit; rerun\n// \`node scripts/generate-spec-areas.ts\` from apps/web after adding a route or\n// changing the URLs a spec visits. e2e-affected.unit.test.ts fails on drift.\n\nimport type { SpecGlobMap } from "../../scripts/generate-spec-areas.ts";\n\nexport const DERIVED_SPEC_GLOBS: SpecGlobMap = {\n${entries}\n};\n`;
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invoked === import.meta.url) {
  const webDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const output = path.join(webDir, "tests/e2e/spec-areas.derived.ts");
  writeFileSync(output, renderGenerated(deriveSpecGlobs(webDir)));
  // Commit the formatter's layout so regenerating never makes noise.
  execFileSync("pnpm", ["exec", "oxfmt", output], { cwd: webDir });
}
