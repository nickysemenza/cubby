import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkEntityArtifacts,
  expectedBrowserRouteFiles,
  missingBrowserRouteFiles,
  parseEntityLiteralFiles,
  parseEntityLiterals,
  renderEntityArtifacts,
  renderFilterArtifacts,
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
  const parseField = (field: string, storage = '["name"]') =>
    parseEntityLiterals(`export const ENTITY_LITERALS = [{
      key: "alpha", descriptor: { auditable: false, searchable: false, lifecycle: {delete: null, merge: false} }, contract: null,
      fieldModel: {
        fields: [${field}], storage: ${storage},
        create: ["name"], update: ["name"], output: ["name"], bulk: [], audit: [],
      },
    }];`);

  it("compiles shared rules and defaults identically to explicit field contracts", () => {
    const compact = parseField(`{
      key: "name", kind: "text", control: {kind: "text"}, display: {list: true},
      validation: {
        kind: "string", description: "Name", write: {trim: true, min: 1},
        read: true, create: {defaultValue: "Example"}, update: true,
      },
    }`);
    const explicit = parseField(
      `{
      key: "name", kind: "text", label: "Name", nullable: false, readKey: "name",
      description: null, reference: null,
      control: {kind: "text", renderer: null, options: null, section: "main"},
      display: {list: true, detail: false},
      validation: {
        read: {kind: "string", description: "Name"},
        create: {kind: "string", description: "Name", trim: true, min: 1, defaultValue: "Example"},
        update: {kind: "string", description: "Name", trim: true, min: 1, optional: true},
      },
    }`,
      `[{key: "name", kind: "text", column: "name", nullable: false,
      default: "none", defaultValue: null, reference: null, specialized: null}]`,
    );
    expect(compact).toEqual(explicit);
    expect(renderEntityArtifacts(compact)).toEqual(
      renderEntityArtifacts(explicit),
    );

    const exception = parseField(
      `{
      key: "name", kind: "text", nullable: true, label: "Display name", readKey: null,
      validation: {kind: "string", nullable: true, update: {optional: false}},
    }`,
      `[{key: "name", column: "title", nullable: false, default: "literal", defaultValue: "Example"}]`,
    )[0]?.fieldModel;
    expect(exception?.fields[0]).toMatchObject({
      label: "Display name",
      readKey: null,
      nullable: true,
      validation: {
        read: null,
        create: null,
        update: { optional: false, nullable: true },
      },
    });
    expect(exception?.storage[0]).toMatchObject({
      column: "title",
      nullable: false,
      defaultValue: "Example",
    });
  });

  it.each([
    ["nullable: null", "nullable must be a boolean"],
    ["label: null", "label must be a non-empty string"],
    ["display: {list: null}", "display.list must be a boolean"],
    [
      'validation: {kind: "string", read: true, write: {typo: true}}',
      "write.typo is not allowed",
    ],
    ["validation: {read: true}", "read.kind is required"],
  ])(
    "rejects invalid explicit values instead of replacing them with defaults: %s",
    (override, error) => {
      expect(() =>
        parseField(`{key: "name", kind: "text", ${override}}`),
      ).toThrow(error);
    },
  );

  it("rejects storage shorthand for undeclared fields", () => {
    expect(() =>
      parseField('{key: "name", kind: "text"}', '["missing"]'),
    ).toThrow("references undeclared field missing");
  });

  it("validates standard display renderers against their declared field", () => {
    const parseDisplay = (display: string) =>
      parseEntityLiterals(`
      export const ENTITY_LITERALS = [{
        key: "alpha", descriptor: { auditable: false, searchable: false }, contract: null,
        fieldModel: {
          fields: [{
            key: "name", kind: "text", nullable: false, label: "Name",
            description: null, readKey: "name", reference: null, control: null,
            display: ${display}, validation: {},
          }],
          storage: [], create: ["name"], update: ["name"], bulk: [], audit: [], output: ["name"],
        },
      }];
    `);
    expect(
      parseDisplay('{ list: true, detail: true, standard: "name" }')[0]
        ?.fieldModel.fields[0]?.display.standard,
    ).toBe("name");
    expect(() =>
      parseDisplay('{ list: true, detail: true, standard: "image" }'),
    ).toThrow("incompatible standard display column");
    expect(() =>
      parseDisplay('{ list: false, detail: true, standard: "name" }'),
    ).toThrow("incompatible standard display column");
    expect(() =>
      parseDisplay('{ list: true, detail: true, standard: "unknown" }'),
    ).toThrow("standard must be name or image");
    expect(
      parseDisplay("{ list: true, detail: true, detailOrder: 0 }")[0]
        ?.fieldModel.fields[0]?.display.detailOrder,
    ).toBe(0);
    expect(() =>
      parseDisplay("{ list: true, detail: true, detailOrder: -1 }"),
    ).toThrow("found UnaryExpression");
    expect(() =>
      parseDisplay("{ list: true, detail: true, detailOrder: 0.5 }"),
    ).toThrow("detailOrder must be a nonnegative integer");
    expect(
      parseDisplay(
        '{ list: false, detail: true, detailSection: "resources" }',
      )[0]?.fieldModel.fields[0]?.display.detailSection,
    ).toBe("resources");
    expect(() =>
      parseDisplay('{ list: false, detail: true, detailSection: " " }'),
    ).toThrow("detailSection must not be blank");
  });

  it("compiles the catalog and CRUD contract cases from literal data", () => {
    const entities = parseEntityLiterals(`
      export const ENTITY_LITERALS = [
        {
          key: "alpha",
          descriptor: {
            shortcodePrefix: "ALP-", auditable: true, browserRoutes: true, searchable: false,
            lifecycle: { delete: null, merge: false },
            relationships: [{
              key: "children", label: "Children", target: "alpha", cardinality: "many", sourceKey: "explicit",
              provenance: { kind: "local-path", steps: [{ edge: "Alpha.parentId", direction: "incoming" }] },
              inverse: { steps: [{ edge: "Alpha.parentId", direction: "outgoing" }] }, sources: [],
              mutation: {
                source: "explicit",
                itemSchema: { module: "@cubby/schemas/example", export: "relationItem" },
                adapter: { module: "~/server/example", export: "exampleRelationAdapter" },
                audiences: ["browser", "mcp"],
              },
            }],
          },
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
          },
        },
      ] as const;
    `);

    const artifacts = renderEntityArtifacts(entities);
    const filterArtifacts = renderFilterArtifacts(entities);

    const artifact = (suffix: string) =>
      artifacts.find(({ relativePath }) => relativePath.endsWith(suffix))
        ?.source;
    expect(artifact("shortcode-registry.gen.ts")).toContain('alpha:"ALP-"');
    expect(artifact("entity-manifest-data.gen.ts")).toContain("{alpha:{");
    expect(artifact("entity-bindings.gen.ts")).toContain('"alpha": {');
    expect(artifact("entity-bindings.gen.ts")).toContain("mcpOutput:output");
    expect(artifact("entity-details.gen.ts")).toContain(
      "ENTITY_DETAIL_OUTPUT_SCHEMAS",
    );
    expect(artifact("entity-details.gen.ts")).toContain('"alpha": output');
    expect(artifact("entity-details.gen.ts")).toContain(
      'detailEntities = ["alpha"]',
    );
    expect(artifact("entity-details.gen.ts")).toContain(
      "shortcode:shortcodeSchema",
    );
    expect(artifact("entity-details.gen.ts")).toContain(
      "export type EntityDetailByEntity",
    );
    expect(artifact("entity-details.gen.ts")).toContain("shortcode: z.input");
    expect(artifact("entity-details.gen.ts")?.match(/^import .*$/gm)).toEqual(
      expect.arrayContaining([
        'import { output } from "@cubby/schemas/example";',
      ]),
    );
    expect(artifact("entity-details.gen.ts")).not.toContain("~/server/");
    expect(artifact("entity-routes.gen.ts")).toContain(
      'detail:"/alphas/$shortcode"',
    );
    expect(artifact("entity-routes.gen.ts")).toContain(
      'generatedBrowserCrudEntities = ["alpha"]',
    );
    expect(artifact("entity-kernel-entities.gen.ts")).toContain(
      'alpha:{actions:["get","list","create","update"]',
    );
    expect(artifact("entity-kernel-bindings.gen.ts")).toContain(
      'import type * as entityPortModule3 from "~/server/example"',
    );
    expect(artifact("entity-kernel-bindings.gen.ts")).toContain(
      'typeof entityPortModule3["exampleRepository"]',
    );
    expect(artifact("entity-kernel-bindings.gen.ts")).toContain(
      'typeof entityPortModule3["exampleRelationAdapter"]',
    );
    expect(artifact("entity-relation-contracts.gen.ts")).toContain(
      'relation:z.literal("children")',
    );
    expect(artifact("entity-relation-bindings.gen.ts")).toContain(
      'case "alpha:children"',
    );
    expect(
      filterArtifacts.find(({ relativePath }) =>
        relativePath.endsWith("entity-filter-contracts.gen.ts"),
      )?.source,
    ).toContain("generatedEntityFilterContractCases");
    expect(artifact("entity-lists.gen.ts")).toContain("entityListInputSchema");
    expect(artifact("entity-lists.gen.ts")).toContain(
      "ENTITY_LIST_OUTPUT_SCHEMAS",
    );
  });

  it("rejects retired lifecycle and relation-mutation ports", () => {
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
          },
        }];
      `),
    ).toThrow("ports.lifecycle is not allowed");
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

  it("rejects generic contracts without shortcode identity", () => {
    expect(() =>
      parseEntityLiterals(`
        export const ENTITY_LITERALS = [{
          key: "external",
          descriptor: { auditable: false, searchable: false },
          contract: {
            create: null,
            update: null,
            output: { module: "@cubby/schemas/external", export: "externalOut" },
          },
        }];
      `),
    ).toThrow("cannot declare a contract without a shortcode");
  });

  it("requires cardinality and local-view inverses and rejects deletion policy", () => {
    const entity = (relation: string) => `
      export const ENTITY_LITERALS = [{
        key: "alpha", names: { singular: "alpha" }, route: null, table: null,
        identifiers: { brand: null, shortcode: null, legacy: null }, presentation: { titleField: "name" }, fields: null,
        filters: { descriptors: [] }, relations: [${relation}], search: { enabled: false },
        capabilities: { auditable: false, images: false, countable: false, softDelete: false, delete: null, merge: false, operationOwners: { delete: null, merge: null }, bulkUpdate: null, mcp: [] },
        extensions: { countFilter: null, relatednessSignals: null, mcpNames: null },
      }];
    `;
    const local = `key:"child",label:"Child",target:"alpha",cardinality:"many",provenance:{kind:"local-path",steps:[{edge:"Alpha.childId",direction:"outgoing"}]}`;
    expect(
      parseEntityLiterals(entity(`{${local},inverse:{steps:[]}}`))[0]
        ?.descriptor.relationships,
    ).toEqual([
      expect.objectContaining({ cardinality: "many", sourceKey: "child" }),
    ]);
    expect(() => parseEntityLiterals(entity(`{${local}}`))).toThrow(
      "requires inverse",
    );
    expect(() =>
      parseEntityLiterals(
        entity(`{${local},inverse:{steps:[]},deletionPolicy:"restrict"}`),
      ),
    ).toThrow("deletionPolicy is not allowed");
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

  it("requires route modules for every generated browser route", () => {
    const entities = parseEntityLiterals(`
      export const ENTITY_LITERALS = [{
        key: "alpha", route: { basePath: "alphas", detailParam: "id" },
        descriptor: { auditable: false, searchable: false }, contract: null,
      }];
    `);
    const expected = expectedBrowserRouteFiles(entities);

    expect(expected).toEqual([
      "apps/web/src/routes/_authenticated/alphas.index.tsx",
      "apps/web/src/routes/_authenticated/alphas.$id.tsx",
    ]);
    expect(
      missingBrowserRouteFiles(entities, (path) =>
        path.endsWith(expected[0] ?? ""),
      ),
    ).toEqual([expected[1]]);
  });

  it("rejects unsupported, duplicate, missing, and stale filter descriptors", () => {
    const parseFilters = (filters: string, auditable = false) =>
      parseEntityLiterals(`
        export const ENTITY_LITERALS = [{
          key: "alpha", descriptor: { auditable: ${auditable}, searchable: false }, contract: null,
          filters: ${filters},
        }];
      `);

    expect(() =>
      parseFilters(
        '{ descriptors: [{ columnId: "name", kind: "fuzzy", placeholder: "Search..." }] }',
      ),
    ).toThrow("kind is unsupported");
    expect(() =>
      parseFilters(
        '{ descriptors: [{ columnId: "name", kind: "text", placeholder: "Search..." }, { columnId: "name", urlKey: "alias", kind: "text", placeholder: "Search..." }] }',
      ),
    ).toThrow("duplicate columnId");
    expect(() =>
      parseFilters(
        '{ descriptors: [{ columnId: "name", urlKey: "same", kind: "text", placeholder: "Search..." }, { columnId: "alias", urlKey: "same", kind: "text", placeholder: "Search..." }] }',
      ),
    ).toThrow("descriptors contains duplicate URL keys");
    expect(() => parseFilters("{ descriptors: [] }")).not.toThrow();
    expect(
      parseFilters("{ audit: true, descriptors: [] }", true)[0]?.filterUrlKeys,
    ).toEqual(["createdAt", "updatedAt"]);
    expect(() => parseFilters('{ audit: "yes", descriptors: [] }')).toThrow(
      "filters.audit must be a boolean",
    );
    expect(() => parseFilters("{ urlKeys: [], descriptors: [] }")).toThrow(
      "filters.urlKeys is not allowed",
    );
    expect(() => parseFilters("{ audit: true, descriptors: [] }")).toThrow(
      "filters.audit requires an auditable entity",
    );
    expect(() =>
      parseFilters(
        '{ descriptors: [{ columnId: "createdAt", kind: "range", placeholder: "Created" }], audit: true }',
      ),
    ).toThrow("duplicates an explicit");
    expect(() => parseFilters("{ audit: false }")).toThrow(
      "filters.descriptors is required",
    );
    expect(() =>
      parseFilters(
        '{ descriptors: [{ columnId: "name", kind: "text", placeholder: "Search...", options: [], optionsRef: { module: "x", export: "y" } }] }',
      ),
    ).toThrow("cannot declare both options and optionsRef");
  });

  it("projects filter URL keys from literal specs without executing app modules", async () => {
    const entities = await parseEntityLiteralFiles();
    const artifacts = [
      ...renderEntityArtifacts(entities),
      ...renderFilterArtifacts(entities),
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
          "apps/web/src/entities/generated/entity-filter-bindings.gen.ts",
      )?.source,
    ).toContain('columnId:"related:product.tasks"');
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
          "apps/web/src/entities/generated/entity-details.gen.ts",
      )?.source,
    ).toContain('"product": productWithFoodOut');
  });

  it("emits authoritative field schemas and rejects self-import cycles", async () => {
    const entities = await parseEntityLiteralFiles();
    const artifacts = renderEntityArtifacts(entities);

    expect(
      artifacts.find(({ relativePath }) =>
        relativePath.endsWith("entity-field-schemas.ingredient.gen.ts"),
      )?.source,
    ).toContain("generatedIngredientFieldSchemas");
    expect(
      artifacts.find(({ relativePath }) =>
        relativePath.endsWith("entity-field-schemas.ingredient.gen.ts"),
      )?.source,
    ).toContain(
      'generatedIngredientFilterFields = {"nameFilter":z.string().optional().describe("Filter by ingredient name (substring)"),"usuallyOnHand":z.boolean().optional().describe("Filter by ingredients usually kept on hand")}',
    );
    expect(
      artifacts.find(({ relativePath }) =>
        relativePath.endsWith("entity-field-schemas.image.gen.ts"),
      )?.source,
    ).toContain('generatedImageStatusValues = ["PENDING","UPLOADED","FAILED"]');
    expect(
      artifacts.find(({ relativePath }) =>
        relativePath.endsWith("entity-field-model.gen.ts"),
      )?.source,
    ).toContain(
      'control:{kind:"text",renderer:null,options:null,section:"main"}',
    );
    expect(
      artifacts.find(({ relativePath }) =>
        relativePath.endsWith("entity-field-schemas.cookbook.gen.ts"),
      )?.source,
    ).toContain('read:{"id":cookbookShortcode,"book":z.string()');
    expect(
      artifacts.find(({ relativePath }) =>
        relativePath.endsWith("entity-field-schemas.usda-food.gen.ts"),
      )?.source,
    ).toContain("generatedUSDAFoodFieldSchemas");
    expect(
      artifacts.find(({ relativePath }) =>
        relativePath.endsWith("entity-bindings.gen.ts"),
      )?.source,
    ).toContain('"cookbook": entitySchema');
    expect(
      artifacts.find(({ relativePath }) =>
        relativePath.endsWith("entity-kernel-bindings.gen.ts"),
      )?.source,
    ).not.toContain('"cookbook"');

    const cyclic = parseEntityLiterals(`
      export const ENTITY_LITERALS = [{
        key: "alpha",
        descriptor: {
          shortcodePrefix: "ALP-", auditable: false, searchable: false,
          lifecycle: { delete: null, merge: false },
        },
        contract: {
          create: { module: "@cubby/schemas/alpha", export: "alphaCreate" },
          update: { module: "@cubby/schemas/alpha", export: "alphaUpdate" },
          output: { module: "@cubby/schemas/alpha", export: "alphaOut" },
        },
        ports: {
          repository: { module: "~/server/alpha", export: "alphaRepository" },
          references: { label: null, resolver: null }, filters: null,
          search: { projection: null, semanticText: null, dependentRefresh: null },
        },
        fieldModel: {
          fields: [{
            key: "name", kind: "text", nullable: false, label: "Name",
            description: null, readKey: "name", reference: null,
            control: { kind: "text", renderer: null, options: null, section: "identity" },
            display: { list: true, detail: true },
            validation: {
              read: { kind: "source", source: { module: "@cubby/schemas/alpha", export: "alphaName" } },
              create: { kind: "source", source: { module: "@cubby/schemas/alpha", export: "alphaName" } },
              update: { kind: "source", source: { module: "@cubby/schemas/alpha", export: "alphaName" } },
            },
          }],
          storage: [], create: ["name"], update: ["name"], bulk: [], audit: [],
          output: ["name"],
        },
      }];
    `);

    expect(cyclic[0]?.fieldModel.fields[0]?.control?.section).toBe("identity");
    expect(() =>
      parseEntityLiterals(`
        export const ENTITY_LITERALS = [{
          key: "alpha", descriptor: { auditable: false, searchable: false }, contract: null,
          fieldModel: {
            fields: [{
              key: "name", kind: "text", nullable: false, label: "Name",
              description: null, readKey: "name", reference: null,
              control: { kind: "text", renderer: null, options: null, section: "   " },
              display: { list: true, detail: true }, validation: {},
            }],
            storage: [], create: [], update: [], bulk: [], audit: [], output: [],
          },
        }];
      `),
    ).toThrow("control.section must be nonempty");

    expect(() => renderEntityArtifacts(cyclic)).toThrow(
      "creates a cycle with its generated contract",
    );

    const mismatched = structuredClone(entities);
    const productPresence = mismatched
      .find(({ key }) => key === "ingredient")
      ?.filterDescriptors.find(({ columnId }) => columnId === "product");
    if (productPresence === undefined) throw new Error("Missing test fixture");
    Object.assign(productPresence, { deriveSchema: true });
    expect(() => renderEntityArtifacts(mismatched)).toThrow(
      "cannot derive a schema without a matching model field",
    );
  });
});
