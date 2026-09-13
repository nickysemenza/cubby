/**
 * The transitive import guard `docs/entities.md` promises for entity
 * declarations: a `packages/schemas/src/entity-definitions/*.entity.ts` file may use the small set
 * of primitive helpers (`definition.ts`, `field-primitives.ts`,
 * `identifier-fields.ts`, `base-entity.ts`, `codec.ts`, and siblings that
 * don't themselves reach further), but must never transitively import:
 *
 *  - a module under `packages/schemas/src/generated/` (the codegen output a
 *    declaration is the SOURCE for — importing it back would be a cycle in
 *    spirit, even where the module graph tolerates it);
 *  - a canonical entity schema module (`product.ts`, `recipe.ts`, …) —
 *    detected structurally, by the module itself importing from
 *    `./generated/entity-field-schemas.*`, rather than a hand-kept list that
 *    would silently stop covering a new one;
 *  - anything outside `packages/schemas/src` that resolves into `apps/`.
 *
 * Declarations are the input codegen reads to PRODUCE the generated schema
 * modules and their field-schema exports; a declaration reaching back into
 * either would be the generator depending on its own output, or the schemas
 * package reaching into application code it cannot depend on.
 *
 * This walks real import specifiers with regexes over source text — no TS
 * compiler API — resolving relative specifiers (`.js`/extensionless) and
 * `@cubby/schemas/*` self-references via this package's own `package.json`
 * `exports` map, entirely within `packages/schemas/src`. A specifier this
 * walk can't or needn't resolve further (an external package like `zod` or
 * `@cubby/shared`) is left unwalked — the boundary this test guards is about
 * schemas-internal layering and the schemas/apps boundary, not every
 * dependency a declaration happens to pull in.
 *
 * Lives in apps/web/tooling (beside `client-functions-import-boundary`)
 * rather than in the schemas package: that package deliberately carries no
 * Node types so it stays isomorphic, and this walk needs `node:fs`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCHEMAS_ROOT = resolve(REPO_ROOT, "packages/schemas");
const SRC_ROOT = resolve(SCHEMAS_ROOT, "src");
const ENTITY_DEFINITIONS_DIR = join(SRC_ROOT, "entity-definitions");
const GENERATED_ROOT = join(SRC_ROOT, "generated");
const SELF_PACKAGE_NAME = "@cubby/schemas";

interface PackageManifest {
  exports?: Record<string, string>;
}

// SAFETY: this package.json is checked-in source under our control; only
// the optional `exports` map is read, and a missing one falls back to `{}`.
const packageManifest = JSON.parse(
  readFileSync(join(SCHEMAS_ROOT, "package.json"), "utf8"),
) as PackageManifest;
const EXPORTS_MAP: Record<string, string> = packageManifest.exports ?? {};

/**
 * Matches the specifier of `import ... from "spec"`, `export ... from
 * "spec"` (including `export * from`/`export type ... from`), and bare
 * `import "spec"` — the shapes that actually appear in this package's
 * TypeScript source. A plain regex over source text, per this test's own
 * design constraint (no TS compiler API).
 */
const IMPORT_SPECIFIER_RE =
  /from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
    const spec = match[1] ?? match[2];
    if (spec) specifiers.push(spec);
  }
  return specifiers;
}

/** First candidate path that actually exists on disk, else `undefined`. */
function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

/** Resolve a relative specifier (`.js`, `.ts`, or extensionless) to a real file. */
function resolveRelativeSpecifier(
  fromFile: string,
  spec: string,
): string | undefined {
  const withoutExtension = spec.replace(/\.(js|ts|tsx)$/, "");
  const joined = resolve(dirname(fromFile), withoutExtension);
  return firstExisting([
    `${joined}.ts`,
    `${joined}.tsx`,
    join(joined, "index.ts"),
  ]);
}

/** Resolve `@cubby/schemas/*` (or the bare package name) via its own `exports` map. */
function resolveSelfPackageSpecifier(spec: string): string | undefined {
  const key =
    spec === SELF_PACKAGE_NAME
      ? "."
      : `.${spec.slice(SELF_PACKAGE_NAME.length)}`;
  const target = EXPORTS_MAP[key];
  return target ? resolve(SCHEMAS_ROOT, target) : undefined;
}

/**
 * Resolve one import specifier to an absolute file path, or `undefined` when
 * it's an external package (`zod`, `@cubby/shared`, `@cubby/usda-schemas`,
 * …) this boundary doesn't walk into.
 */
function resolveSpecifier(fromFile: string, spec: string): string | undefined {
  if (spec.startsWith(".")) return resolveRelativeSpecifier(fromFile, spec);
  if (spec === SELF_PACKAGE_NAME || spec.startsWith(`${SELF_PACKAGE_NAME}/`)) {
    return resolveSelfPackageSpecifier(spec);
  }
  return undefined;
}

/** A module counts as "canonical" by what IT imports, not by name — no hand list. */
const CANONICAL_ENTITY_SCHEMA_IMPORT_RE =
  /from\s*["']\.{1,2}\/generated\/entity-field-schemas[^"']*["']/;

function isCanonicalEntitySchemaModule(filePath: string): boolean {
  return CANONICAL_ENTITY_SCHEMA_IMPORT_RE.test(readFileSync(filePath, "utf8"));
}

function isUnderGenerated(filePath: string): boolean {
  return (
    filePath === GENERATED_ROOT || filePath.startsWith(`${GENERATED_ROOT}/`)
  );
}

function isUnderApps(filePath: string): boolean {
  const relativeToRepo = relative(REPO_ROOT, filePath);
  return relativeToRepo.split(/[/\\]/)[0] === "apps";
}

interface BoundaryViolation {
  reachedModule: string;
  reason: string;
  /** The import chain from the declaration file to the violating module. */
  chain: string[];
}

/**
 * Breadth-first walk of one declaration's transitive imports. Stops
 * expanding a branch the moment it hits a forbidden module (reported, not
 * walked further) or a module already visited from this declaration (cycles
 * are real here — `field-primitives.ts` imports `18-image.entity.ts`, which
 * can lead back toward other declarations).
 */
function findBoundaryViolations(declarationFile: string): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const visited = new Set<string>([declarationFile]);
  const queue: { file: string; chain: string[] }[] = [
    { file: declarationFile, chain: [declarationFile] },
  ];

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    const specifiers = extractSpecifiers(readFileSync(file, "utf8"));

    for (const spec of specifiers) {
      const resolved = resolveSpecifier(file, spec);
      if (!resolved) continue; // external package — not this boundary's concern

      if (isUnderApps(resolved) && !resolved.startsWith(`${SRC_ROOT}/`)) {
        violations.push({
          reachedModule: resolved,
          reason: "resolves outside packages/schemas/src into apps/",
          chain: [...chain, resolved],
        });
        continue;
      }

      if (resolved !== SRC_ROOT && !resolved.startsWith(`${SRC_ROOT}/`)) {
        continue; // outside packages/schemas/src, but not into apps/ either
      }

      if (isUnderGenerated(resolved)) {
        violations.push({
          reachedModule: resolved,
          reason: "is under packages/schemas/src/generated/",
          chain: [...chain, resolved],
        });
        continue;
      }

      if (isCanonicalEntitySchemaModule(resolved)) {
        violations.push({
          reachedModule: resolved,
          reason:
            "is a canonical entity schema module (imports from ../generated/entity-field-schemas.*)",
          chain: [...chain, resolved],
        });
        continue;
      }

      if (!visited.has(resolved)) {
        visited.add(resolved);
        queue.push({ file: resolved, chain: [...chain, resolved] });
      }
    }
  }

  return violations;
}

const declarationFiles = readdirSync(ENTITY_DEFINITIONS_DIR)
  .filter((name) => name.endsWith(".entity.ts"))
  .map((name) => join(ENTITY_DEFINITIONS_DIR, name))
  .sort();

const describeViolation = (violation: BoundaryViolation): string =>
  `${relative(SRC_ROOT, violation.reachedModule)} (${violation.reason}) via ` +
  violation.chain.map((step) => relative(SRC_ROOT, step)).join(" -> ");

describe("entity-definitions import boundary", () => {
  it("found entity declaration files to check", () => {
    // A regression here would mean this test is vacuously passing.
    expect(declarationFiles.length).toBeGreaterThan(0);
  });

  for (const declarationFile of declarationFiles) {
    const name = relative(ENTITY_DEFINITIONS_DIR, declarationFile);
    it(`${name} never transitively reaches generated/, a canonical entity schema module, or apps/`, () => {
      const violations = findBoundaryViolations(declarationFile);
      expect(violations.map(describeViolation)).toEqual([]);
    });
  }
});
