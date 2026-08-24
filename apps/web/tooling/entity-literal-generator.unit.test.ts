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
            mcpOut: null,
          },
        },
      ] as const;
    `);

    const artifacts = renderEntityArtifacts(entities);

    expect(artifacts[0]?.source).toContain("{alpha:{");
    expect(artifacts[1]?.source).toContain('"alpha": {');
    expect(artifacts[1]?.source).toContain("mcpOut:null");
    expect(artifacts[2]?.source).toContain('detail:"/alphas/$shortcode"');
    expect(artifacts[2]?.source).toContain(
      'generatedBrowserCrudEntities = ["alpha"]',
    );
    expect(artifacts[3]?.source).toContain(
      'alpha:{actions:["get","list","create","update"]',
    );
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
    ).toThrow("duplicates beta");
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
  });
});
