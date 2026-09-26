/**
 * Fixture-tree coverage for the entity-declaration import-boundary check
 * (`scripts/generator/entities/import-boundary.ts`). That check walks the
 * real transitive imports of `packages/schemas/src/entity-definitions/*.entity.ts`
 * and fails `pnpm generate` when it reaches a file (staying within the
 * schemas package's `src`) that `.oxlintrc.json`'s hand-maintained
 * import-boundary override does not cover — see that file's own comment and
 * docs/entities.md for the full boundary this guards.
 *
 * This builds a small standalone fixture tree per test (its own fake
 * `packages/schemas` and `.oxlintrc.json`) rather than mutating the repo's
 * real ones, and drives `computeEntityDeclarationImportBoundaryViolations`
 * directly against it. Lives in apps/web/tooling (beside
 * `client-functions-import-boundary`) for the same reason the original,
 * removed version of this test did: this vitest project's `unit` glob is
 * rooted at apps/web, and the walk itself needs `node:fs`, which the
 * isomorphic schemas package deliberately doesn't carry.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeEntityDeclarationImportBoundaryViolations,
  describeBoundaryViolation,
} from "../../../scripts/generator/entities/import-boundary";

const OVERRIDE_MARKER_GLOB = "packages/schemas/src/entity-definitions/**/*.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * Builds a fixture repo root with a `packages/schemas` package (`package.json`
 * with an `exports` map, `src/entity-definitions/*.entity.ts`, and whatever
 * helper modules `files` names) plus a fixture `.oxlintrc.json` carrying one
 * override entry for `overrideFiles`/`overrideExcludeFiles`. Returns the
 * option bag `computeEntityDeclarationImportBoundaryViolations` expects.
 */
async function buildFixture(config: {
  files: Record<string, string>;
  overrideFiles: string[];
  overrideExcludeFiles?: string[];
}): Promise<
  Parameters<typeof computeEntityDeclarationImportBoundaryViolations>[0]
> {
  const repoRoot = await mkdtemp(join(tmpdir(), "import-boundary-fixture-"));
  roots.push(repoRoot);

  const schemasRoot = join(repoRoot, "packages/schemas");
  const srcRoot = join(schemasRoot, "src");
  const entityDefinitionsDir = join(srcRoot, "entity-definitions");

  for (const [relativePath, contents] of Object.entries(config.files)) {
    const absolutePath = join(schemasRoot, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }

  const exportsMap: Record<string, string> = {};
  for (const relativePath of Object.keys(config.files)) {
    if (!relativePath.startsWith("src/")) continue;
    const withoutSrc = relativePath.slice("src/".length).replace(/\.ts$/, "");
    exportsMap[`./${withoutSrc}`] = `./${relativePath}`;
  }
  await writeFile(
    join(schemasRoot, "package.json"),
    JSON.stringify({ name: "@cubby/schemas", exports: exportsMap }),
    "utf8",
  );

  const oxlintrcPath = join(repoRoot, ".oxlintrc.json");
  const oxlintrcJson = JSON.stringify(
    {
      overrides: [
        {
          files: config.overrideFiles,
          excludeFiles: config.overrideExcludeFiles ?? [],
          rules: {},
        },
      ],
    },
    null,
    2,
  );
  // Exercises the JSONC-tolerant parser: a real `//` line comment (and a
  // string value containing `//`, which must survive untouched) alongside
  // otherwise-ordinary JSON, matching .oxlintrc.json's own dialect.
  const oxlintrcWithComments = oxlintrcJson.replace(
    '"overrides"',
    '// fixture: entity-declaration import-boundary override\n  "overrides"',
  );
  await writeFile(
    oxlintrcPath,
    `${oxlintrcWithComments}\n// trailing comment, and a value with a "not // a comment" substring\n`,
    "utf8",
  );

  return {
    repoRoot,
    schemasRoot,
    srcRoot,
    entityDefinitionsDir,
    oxlintrcPath,
    overrideMarkerGlob: OVERRIDE_MARKER_GLOB,
  };
}

describe("computeEntityDeclarationImportBoundaryViolations", () => {
  it("passes when every transitively imported helper is covered by the override", async () => {
    const options = await buildFixture({
      files: {
        "src/entity-definitions/00-widget.entity.ts": [
          'import { widgetFields } from "../widget-fields";',
          "export const widget = { widgetFields };",
        ].join("\n"),
        "src/widget-fields.ts": [
          'import { baseEntity } from "./base-entity";',
          "export const widgetFields = { baseEntity };",
        ].join("\n"),
        "src/base-entity.ts": "export const baseEntity = {};",
      },
      overrideFiles: [
        OVERRIDE_MARKER_GLOB,
        "packages/schemas/src/*-fields.ts",
        "packages/schemas/src/base-entity.ts",
      ],
    });

    const violations =
      computeEntityDeclarationImportBoundaryViolations(options);
    expect(violations).toEqual([]);
  });

  it("fails, naming the file and import chain, when a helper escapes the override", async () => {
    const options = await buildFixture({
      files: {
        "src/entity-definitions/00-widget.entity.ts": [
          'import { widgetFields } from "../widget-fields";',
          "export const widget = { widgetFields };",
        ].join("\n"),
        "src/widget-fields.ts": [
          // widget-fields.ts reaches for a NEW helper the override was never
          // updated to list — the real-world "declaration imports a new
          // helper" gap this check exists to catch.
          'import { newHelper } from "./new-helper";',
          "export const widgetFields = { newHelper };",
        ].join("\n"),
        "src/new-helper.ts": "export const newHelper = {};",
      },
      overrideFiles: [OVERRIDE_MARKER_GLOB, "packages/schemas/src/*-fields.ts"],
      // deliberately omits packages/schemas/src/new-helper.ts
    });

    const violations =
      computeEntityDeclarationImportBoundaryViolations(options);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file.endsWith("src/new-helper.ts")).toBe(true);
    expect(
      violations[0]?.chain.map((step) => relative(options.repoRoot, step)),
    ).toEqual([
      "packages/schemas/src/entity-definitions/00-widget.entity.ts",
      "packages/schemas/src/widget-fields.ts",
      "packages/schemas/src/new-helper.ts",
    ]);

    const description = describeBoundaryViolation(
      options.repoRoot,
      violations[0]!,
    );
    expect(description).toContain("packages/schemas/src/new-helper.ts");
    expect(description).toContain(
      "is not matched by the entity-declaration import-boundary override",
    );
  });

  it("stops walking a violation's own imports instead of cascading further false positives", async () => {
    const options = await buildFixture({
      files: {
        "src/entity-definitions/00-widget.entity.ts": [
          'import { generated } from "../generated/entity-sort.gen";',
          "export const widget = { generated };",
        ].join("\n"),
        // Reachable only through the already-uncovered generated file: since
        // the walk stops expanding a violation, this must NOT also appear as
        // a separate violation.
        "src/generated/entity-sort.gen.ts": [
          'import { widgetFields } from "../widget-fields";',
          "export const generated = { widgetFields };",
        ].join("\n"),
        "src/widget-fields.ts": "export const widgetFields = {};",
      },
      overrideFiles: [OVERRIDE_MARKER_GLOB, "packages/schemas/src/*-fields.ts"],
    });

    const violations =
      computeEntityDeclarationImportBoundaryViolations(options);

    expect(violations).toHaveLength(1);
    expect(
      violations[0]?.file.endsWith("src/generated/entity-sort.gen.ts"),
    ).toBe(true);
  });

  it("respects excludeFiles: an excluded path is still reported as uncovered", async () => {
    const options = await buildFixture({
      files: {
        "src/entity-definitions/00-widget.entity.ts": [
          'import { widgetFields } from "../widget-fields";',
          "export const widget = { widgetFields };",
        ].join("\n"),
        "src/widget-fields.ts": "export const widgetFields = {};",
      },
      overrideFiles: [OVERRIDE_MARKER_GLOB, "packages/schemas/src/*-fields.ts"],
      overrideExcludeFiles: ["packages/schemas/src/widget-fields.ts"],
    });

    const violations =
      computeEntityDeclarationImportBoundaryViolations(options);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file.endsWith("src/widget-fields.ts")).toBe(true);
  });
});
