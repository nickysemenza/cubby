// Generator-time guard for the transitive import boundary entity
// declarations must respect (docs/entities.md). A declaration file
// (`packages/schemas/src/entity-definitions/*.entity.ts`) and the small set
// of helper modules it may import are the generator's INPUT: they must never
// transitively reach a generated artifact, a canonical entity schema module
// (built from generated field schemas), application code, or the WASM
// boundary. That boundary is enforced at lint time by the `no-restricted-imports`
// override in `.oxlintrc.json` (search its `files` list for
// `packages/schemas/src/entity-definitions/**/*.ts`) — but that override's
// `files` glob list is hand-maintained. If a declaration starts importing a
// new helper module that isn't in that list, oxlint's rule silently never
// runs against it, and the boundary it enforces stops applying to whatever
// that new helper imports.
//
// This walks the real transitive import graph — the same regex-based,
// no-TS-compiler-API approach the removed
// `entity-declaration-import-boundary.unit.test.ts` used (see git history at
// 2bfc1d10e^) — starting from every `*.entity.ts` file, and fails `pnpm
// generate` the moment it reaches a file inside `packages/schemas/src` that
// the override's `files`/`excludeFiles` globs do not match. That single
// check subsumes the old test's job: a helper module missing from the
// override is a real gap (add it), and a declaration that reaches all the
// way into `generated/`, a canonical entity schema module, or `apps/` is
// *also* a file the override never covers, so it fails here too, by the same
// mechanism.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EntityDeclarationError } from "./declarations.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const SCHEMAS_ROOT = resolve(REPO_ROOT, "packages/schemas");
const SRC_ROOT = resolve(SCHEMAS_ROOT, "src");
const ENTITY_DEFINITIONS_DIR = join(SRC_ROOT, "entity-definitions");
const OXLINTRC_PATH = resolve(REPO_ROOT, ".oxlintrc.json");
const SELF_PACKAGE_NAME = "@cubby/schemas";
const OVERRIDE_MARKER_GLOB = "packages/schemas/src/entity-definitions/**/*.ts";

// -- Tolerant JSONC parsing (no dependency: strip comments, string-aware) --

/**
 * Strips `//` line comments and `/* *\/` block comments from JSON source,
 * leaving string contents (including one that happens to contain `//` or
 * `/*`) untouched. Good enough for `.oxlintrc.json`'s own JSONC dialect;
 * this file deliberately avoids a comment-aware JSON parsing dependency
 * since none is already installed where this script resolves modules from.
 */
function stripJsonComments(source: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let stringQuote = "";
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Preserve the escaped character verbatim (e.g. `\"`).
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === stringQuote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (
        i < source.length &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * The one shape this file reads out of `.oxlintrc.json`: an `overrides` array
 * of objects each carrying (at least) `files`/`excludeFiles` glob lists.
 * `.passthrough()` leaves everything else in the config (`rules`, other
 * overrides' fields) unparsed, since this check only ever reads these two
 * lists off the one matching override.
 */
const oxlintOverrideSchema = z
  .object({
    files: z.array(z.string()).default([]),
    excludeFiles: z.array(z.string()).default([]),
  })
  .passthrough();
type OxlintOverride = z.infer<typeof oxlintOverrideSchema>;

const oxlintrcSchema = z
  .object({
    overrides: z.array(oxlintOverrideSchema).default([]),
  })
  .passthrough();

/** The one field this file reads off `packages/schemas/package.json`. */
const packageManifestSchema = z
  .object({
    exports: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();

/**
 * Reads an oxlint config's `overrides` array and returns the `files` /
 * `excludeFiles` globs of the one override whose `files` list includes
 * `markerGlob` — the hand-maintained list this check keeps honest. Takes the
 * config path and marker as parameters (rather than the module-level
 * `OXLINTRC_PATH`/`OVERRIDE_MARKER_GLOB`) so a unit test can point it at a
 * small fixture `.oxlintrc.json` instead of the real one.
 */
function loadDeclarationOverrideGlobs(
  oxlintrcPath: string,
  markerGlob: string,
): OxlintOverride {
  const raw = readFileSync(oxlintrcPath, "utf8");
  const config = oxlintrcSchema.parse(JSON.parse(stripJsonComments(raw)));
  const match = config.overrides.find((override) =>
    override.files.includes(markerGlob),
  );
  if (!match) {
    throw new EntityDeclarationError(
      `${oxlintrcPath} has no "overrides" entry whose "files" list includes ` +
        `"${markerGlob}". The entity-declaration import-boundary override ` +
        `(docs/entities.md) is missing or was renamed — update OVERRIDE_MARKER_GLOB ` +
        `in scripts/generator/entities/import-boundary.ts to match.`,
    );
  }
  return match;
}

// -- Minimal glob matching (no dependency: `**`, `*`, literal segments) --

/**
 * Converts one glob pattern to a `RegExp` anchored over a whole
 * repo-relative, forward-slash path. Supports exactly what this repo's
 * override globs use: `**` (any number of path segments, including zero),
 * `*` (any run of characters excluding `/`), and literal text otherwise.
 * Not a general-purpose glob engine — matches oxlint's own override
 * semantics closely enough for this narrow, checked-in pattern set.
 */
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  let i = 0;
  while (i < glob.length) {
    const rest = glob.slice(i);
    if (rest.startsWith("**/")) {
      pattern += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (rest.startsWith("**")) {
      pattern += ".*";
      i += 2;
      continue;
    }
    const ch = glob[i] ?? "";
    if (ch === "*") {
      pattern += "[^/]*";
    } else if (".+^${}()|[]\\".includes(ch)) {
      pattern += `\\${ch}`;
    } else {
      pattern += ch;
    }
    i += 1;
  }
  return new RegExp(`^${pattern}$`);
}

function matchesAnyGlob(relPath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(relPath));
}

// -- Transitive import walk (regex-based; mirrors the removed unit test) --

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

function firstExisting(candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

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

function resolveSelfPackageSpecifier(
  spec: string,
  schemasRoot: string,
  exportsMap: Record<string, string>,
): string | undefined {
  const key =
    spec === SELF_PACKAGE_NAME
      ? "."
      : `.${spec.slice(SELF_PACKAGE_NAME.length)}`;
  const target = exportsMap[key];
  return target ? resolve(schemasRoot, target) : undefined;
}

function resolveSpecifier(
  fromFile: string,
  spec: string,
  schemasRoot: string,
  exportsMap: Record<string, string>,
): string | undefined {
  if (spec.startsWith(".")) return resolveRelativeSpecifier(fromFile, spec);
  if (spec === SELF_PACKAGE_NAME || spec.startsWith(`${SELF_PACKAGE_NAME}/`)) {
    return resolveSelfPackageSpecifier(spec, schemasRoot, exportsMap);
  }
  return undefined; // external package — not this boundary's concern
}

export interface BoundaryViolation {
  file: string;
  chain: string[];
}

/**
 * Breadth-first walk of one declaration file's transitive imports, staying
 * within `srcRoot` (`packages/schemas/src` in production, a fixture's own
 * "src" root in a test). A file the override does not cover is reported and
 * not walked further (its own imports are moot: fixing the override, or the
 * file, comes first). A file the override does cover keeps expanding, so a
 * chain of several covered helpers can still bottom out at an uncovered one
 * several hops from the declaration.
 */
function findBoundaryViolations(
  declarationFile: string,
  srcRoot: string,
  schemasRoot: string,
  overrideGlobs: { files: string[]; excludeFiles: string[] },
  exportsMap: Record<string, string>,
  toRelativePath: (absolutePath: string) => string,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const visited = new Set<string>([declarationFile]);
  const queue: { file: string; chain: string[] }[] = [
    { file: declarationFile, chain: [declarationFile] },
  ];

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    const specifiers = extractSpecifiers(readFileSync(file, "utf8"));

    for (const spec of specifiers) {
      const resolved = resolveSpecifier(file, spec, schemasRoot, exportsMap);
      if (!resolved) continue; // external package — not this boundary's concern

      // Only files inside the schemas src root are this check's concern: the
      // override's globs are all rooted there, and anything a relative
      // specifier resolves to outside it (this hasn't happened in practice)
      // is a different boundary's problem.
      if (resolved !== srcRoot && !resolved.startsWith(`${srcRoot}/`)) {
        continue;
      }

      if (visited.has(resolved)) continue;
      visited.add(resolved);

      const relPath = toRelativePath(resolved);
      const covered =
        matchesAnyGlob(relPath, overrideGlobs.files) &&
        !matchesAnyGlob(relPath, overrideGlobs.excludeFiles);

      if (!covered) {
        violations.push({ file: resolved, chain: [...chain, resolved] });
        continue;
      }

      queue.push({ file: resolved, chain: [...chain, resolved] });
    }
  }

  return violations;
}

/**
 * The generator-facing check, parameterized over every filesystem root it
 * reads so a unit test can point it at a small fixture tree instead of the
 * real repo. Returns one violation per uncovered file reached from any
 * `*.entity.ts` declaration under `entityDefinitionsDir`, deduplicated by the
 * file it names.
 */
export function computeEntityDeclarationImportBoundaryViolations(options: {
  repoRoot: string;
  schemasRoot: string;
  srcRoot: string;
  entityDefinitionsDir: string;
  oxlintrcPath: string;
  overrideMarkerGlob: string;
}): BoundaryViolation[] {
  const {
    repoRoot,
    schemasRoot,
    srcRoot,
    entityDefinitionsDir,
    oxlintrcPath,
    overrideMarkerGlob,
  } = options;
  const overrideGlobs = loadDeclarationOverrideGlobs(
    oxlintrcPath,
    overrideMarkerGlob,
  );
  const packageManifest = packageManifestSchema.parse(
    JSON.parse(readFileSync(join(schemasRoot, "package.json"), "utf8")),
  );
  const exportsMap = packageManifest.exports;
  const toRelativePath = (absolutePath: string) =>
    relative(repoRoot, absolutePath).split("\\").join("/");

  const declarationFiles = readdirSync(entityDefinitionsDir)
    .filter((name) => name.endsWith(".entity.ts"))
    .map((name) => join(entityDefinitionsDir, name))
    .sort();

  if (declarationFiles.length === 0) {
    throw new EntityDeclarationError(
      `Found no *.entity.ts files under ${toRelativePath(entityDefinitionsDir)} — ` +
        `the entity-declaration import-boundary check would pass vacuously.`,
    );
  }

  const violations = declarationFiles.flatMap((declarationFile) =>
    findBoundaryViolations(
      declarationFile,
      srcRoot,
      schemasRoot,
      overrideGlobs,
      exportsMap,
      toRelativePath,
    ),
  );

  const seen = new Set<string>();
  return violations.filter((violation) => {
    if (seen.has(violation.file)) return false;
    seen.add(violation.file);
    return true;
  });
}

export const describeBoundaryViolation = (
  repoRoot: string,
  violation: BoundaryViolation,
): string =>
  `${relative(repoRoot, violation.file)} is not matched by the ` +
  `entity-declaration import-boundary override's "files" globs in .oxlintrc.json, ` +
  `via ${violation.chain.map((step) => relative(repoRoot, step)).join(" -> ")}`;

/**
 * Fails `pnpm generate` when an entity declaration transitively imports a
 * file (staying within `packages/schemas/src`) that `.oxlintrc.json`'s
 * entity-declaration import-boundary override does not cover. Either the
 * override's `files` list is missing a legitimate new helper module, or the
 * declaration reached somewhere it never should have (`generated/`, a
 * canonical entity schema module, `apps/`) — either way, the override
 * silently stopped enforcing the boundary against whichever uncovered file
 * this names, which is what this check exists to catch.
 */
export function validateEntityDeclarationImportBoundary(): void {
  const violations = computeEntityDeclarationImportBoundaryViolations({
    repoRoot: REPO_ROOT,
    schemasRoot: SCHEMAS_ROOT,
    srcRoot: SRC_ROOT,
    entityDefinitionsDir: ENTITY_DEFINITIONS_DIR,
    oxlintrcPath: OXLINTRC_PATH,
    overrideMarkerGlob: OVERRIDE_MARKER_GLOB,
  });

  if (violations.length > 0) {
    throw new EntityDeclarationError(
      `Entity declarations transitively import files the import-boundary override ` +
        `in .oxlintrc.json does not cover (docs/entities.md). Add each one to that ` +
        `override's "files" list if it is a legitimate helper module, or fix the ` +
        `import if it reaches somewhere a declaration must not:\n` +
        violations
          .map(
            (violation) =>
              `- ${describeBoundaryViolation(REPO_ROOT, violation)}`,
          )
          .join("\n"),
    );
  }
}
