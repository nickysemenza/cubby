import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkEntityArtifacts,
  parseEntityLiteralFiles,
  parseEntityLiterals,
  renderEntityArtifacts,
  renderFilterArtifact,
} from "../../../scripts/entity-literal-generator";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("literal entity generator", () => {
  it("compiles the catalog and CRUD contract cases from literal data", () => {
    const entities = parseEntityLiterals(`
      export const ENTITY_LITERALS = [
        {
          key: "alpha",
          descriptor: { shortcodePrefix: "ALP-", auditable: true, browserRoutes: true, searchable: false, lifecycle: { delete: null, merge: false } },
          contract: {
            create: { module: "@cubby/schemas/example", export: "create" },
            update: { module: "@cubby/schemas/example", export: "update" },
            output: { module: "@cubby/schemas/example", export: "output" },
          },
          ports: {
            repository: { module: "~/server/example", export: "exampleRepository" },
            references: { label: { module: "~/entities/entities", export: "entityLabel" }, resolver: null },
            filters: { module: "~/entities/filter-manifest", export: "getEntityFilters" },
            search: { projection: null, semanticText: null, dependentRefresh: null },
            lifecycle: { policy: null, runtime: null },
            relationMutation: { attach: { module: "~/server/example", export: "attachExample" }, detach: null },
          },
        },
      ] as const;
    `);

    const artifacts = renderEntityArtifacts(entities);

    const artifact = (suffix: string) =>
      artifacts.find(({ relativePath }) => relativePath.endsWith(suffix))
        ?.source;
    expect(artifact("shortcode-registry.gen.ts")).toContain('alpha:"ALP-"');
    expect(artifact("entity-manifest-data.gen.ts")).toContain("{alpha:{");
    expect(artifact("entity-bindings.gen.ts")).toContain('"alpha": {');
    expect(artifact("entity-bindings.gen.ts")).not.toContain("mcpOut");
    expect(artifact("entity-bindings.gen.ts")).toContain(
      "ENTITY_DETAIL_OUTPUT_SCHEMAS",
    );
    expect(artifact("entity-bindings.gen.ts")).toContain('"alpha": output');
    expect(artifact("entity-details.gen.ts")).toContain(
      'detailEntities = ["alpha"]',
    );
    expect(artifact("entity-bindings.gen.ts")).toContain(
      "shortcode:shortcodeSchema",
    );
    expect(artifact("entity-details.gen.ts")).toContain(
      "export type EntityDetailByEntity",
    );
    expect(artifact("entity-details.gen.ts")).toContain("shortcode: z.input");
    expect(artifact("entity-details.gen.ts")?.match(/^import .*$/gm)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^import type /)]),
    );
    expect(artifact("entity-details.gen.ts")).not.toMatch(/^import \{ /m);
    expect(artifact("entity-routes.gen.ts")).toContain(
      'detail:"/alphas/$shortcode"',
    );
    expect(artifact("entity-routes.gen.ts")).toContain(
      'generatedBrowserCrudEntities = ["alpha"]',
    );
    expect(artifact("entity-kernel-entities.gen.ts")).toContain(
      'alpha:{actions:["get","list","create","update"]',
    );
    expect(artifact("entity-runtime-ports.gen.ts")).toContain(
      'repository:{module:"~/server/example",export:"exampleRepository"}',
    );
    expect(artifact("entity-runtime-ports.gen.ts")).toContain(
      'alpha:{attach:{module:"~/server/example",export:"attachExample"}',
    );
    expect(artifact("entity-runtime-ports.gen.ts")).toContain(
      'typeof import("~/server/example")["exampleRepository"]',
    );
  });

  it("rejects incomplete port declarations", () => {
    expect(() =>
      parseEntityLiterals(`
        export const ENTITY_LITERALS = [{
          key: "alpha", descriptor: { auditable: false, searchable: false }, contract: null,
          ports: {
            repository: null,
            references: { label: null, resolver: null },
            filters: null,
            search: { projection: null, semanticText: null, dependentRefresh: null },
            lifecycle: { policy: null, runtime: null },
            relationMutation: { attach: null },
          },
        }];
      `),
    ).toThrow("relationMutation.detach is required");
  });

  it("rejects expressions and duplicate keys", () => {
    expect(() =>
      parseEntityLiterals(
        "export const ENTITY_LITERALS = [makeEntity()] as const;",
      ),
    ).toThrow("must be a literal object");
    expect(() =>
      parseEntityLiterals(`
        export const ENTITY_LITERALS = [
          { key: "beta", descriptor: { auditable: false, searchable: false }, contract: null },
          { key: "beta", descriptor: { auditable: false, searchable: false }, contract: null },
        ] as const;
      `),
    ).toThrow("Duplicate entity key beta");
  });

  it("rejects canonical and legacy shortcode-prefix conflicts", () => {
    const entity = (
      key: string,
      shortcodePrefix: string,
      legacyShortcodePrefix?: string,
    ) => `{
      key: ${JSON.stringify(key)},
      descriptor: {
        shortcodePrefix: ${JSON.stringify(shortcodePrefix)},
        ${legacyShortcodePrefix === undefined ? "" : `legacyShortcodePrefix: ${JSON.stringify(legacyShortcodePrefix)},`}
        auditable: false,
        searchable: false,
      },
      contract: null,
    }`;
    const parse = (entries: string) =>
      parseEntityLiterals(
        `export const ENTITY_LITERALS = [${entries}] as const;`,
      );

    expect(() =>
      parse(`${entity("alpha", "ALP-")},${entity("beta", "ALP-")}`),
    ).toThrow("Canonical shortcode prefix ALP-");
    expect(() =>
      parse(`${entity("alpha", "ALP-", "B-")},${entity("beta", "BET-", "B-")}`),
    ).toThrow("Legacy shortcode prefix B-");
    expect(() =>
      parse(`${entity("alpha", "ALP-", "B-")},${entity("beta", "BET-", "A-")}`),
    ).not.toThrow();
  });

  it("requires local-view inverses and valid deletion policies", () => {
    const entity = (relation: string) => `
      export const ENTITY_LITERALS = [{
        key: "alpha", names: { singular: "alpha" }, route: null, table: null,
        identifiers: { brand: null, shortcode: null, legacy: null }, presentation: { titleField: "name" }, fields: null,
        filters: { urlKeys: [] }, relations: [${relation}], search: { enabled: false },
        capabilities: { auditable: false, images: false, countable: false, softDelete: false, delete: null, merge: false, mcp: [] },
        extensions: { countFilter: null, relatednessSignals: null, mcpNames: null },
      }];
    `;
    const local = `key:"child",label:"Child",target:"alpha",provenance:{kind:"local-path",steps:[{edge:"Alpha.childId",direction:"outgoing"}]}`;
    expect(
      parseEntityLiterals(entity(`{${local},inverse:{steps:[]}}`))[0]
        ?.descriptor.relationships,
    ).toEqual([expect.objectContaining({ deletionPolicy: "restrict" })]);
    expect(() =>
      parseEntityLiterals(entity(`{${local},deletionPolicy:"restrict"}`)),
    ).toThrow("requires inverse");
    expect(() =>
      parseEntityLiterals(
        entity(`{${local},inverse:{steps:[]},deletionPolicy:"erase"}`),
      ),
    ).toThrow("deletionPolicy is invalid");
  });

  it("reports missing, stale, and extraneous generated artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "cubby-entity-literal-"));
    temporaryRoots.push(root);
    const artifacts = [
      { relativePath: "a/entity-literal-catalog.gen.ts", source: "expected\n" },
      {
        relativePath: "b/entity-literal-contract-cases.gen.ts",
        source: "expected\n",
      },
    ];
    await mkdir(join(root, "a"), { recursive: true });
    await writeFile(join(root, "a/entity-literal-catalog.gen.ts"), "stale\n");
    await writeFile(join(root, "a/entity-literal-orphan.gen.ts"), "orphan\n");

    await expect(checkEntityArtifacts(root, artifacts)).resolves.toEqual([
      "stale: a/entity-literal-catalog.gen.ts",
      "missing: b/entity-literal-contract-cases.gen.ts",
      "extraneous: a/entity-literal-orphan.gen.ts",
    ]);
  });

  it("projects filter URL keys from literal specs without executing app modules", async () => {
    const entities = await parseEntityLiteralFiles();
    const artifacts = [
      ...renderEntityArtifacts(entities),
      renderFilterArtifact(entities),
    ];
    const filterArtifact = artifacts.find(
      (artifact) =>
        artifact.relativePath ===
        "apps/web/src/entities/filter-search-fields.gen.ts",
    );

    expect(filterArtifact?.source).toContain('"related-vendor"');
    expect(filterArtifact?.source).toContain("entityFilterSearchFields");
    expect(
      artifacts.find(
        (artifact) =>
          artifact.relativePath ===
          "packages/schemas/src/generated/entity-manifest-data.gen.ts",
      )?.source,
    ).toContain("inverse:{steps:");
    expect(
      artifacts.find(
        (artifact) =>
          artifact.relativePath ===
          "packages/shared/src/generated/shortcode-registry.gen.ts",
      )?.source,
    ).toContain('LEGACY_SHORTCODE_PREFIX = {"P-":"product","L-":"location"}');
    expect(
      artifacts.find(
        (artifact) =>
          artifact.relativePath ===
          "packages/schemas/src/generated/entity-inspector.gen.ts",
      )?.source,
    ).toContain(
      'kernelActions:["get","list","search","create","update","delete","merge"]',
    );
    expect(
      artifacts.find(
        (artifact) =>
          artifact.relativePath ===
          "apps/web/src/server/generated/entity-bindings.gen.ts",
      )?.source,
    ).toContain('"product": productWithFoodOut');
  });
});
