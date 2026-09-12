import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { parseSync } from "oxc-parser";
import { z } from "zod";
import {
  defineEntity,
  parseEntityFieldModelMetadata,
  readFieldSchemas,
} from "../../../packages/schemas/src/entity-definitions/definition";
import type { EntityDeclaration } from "../../../packages/schemas/src/entity-definitions/definition";
import { checkEntityArtifacts } from "../../../scripts/entity-generator/artifacts";
import { compileEntityDeclarations } from "../../../scripts/entity-generator/compile";
import { loadEntityDeclarations } from "../../../scripts/entity-generator/declarations";
import type { CompiledEntity } from "../../../scripts/entity-generator/declarations";
import { renderEntityArtifacts } from "../../../scripts/entity-generator/render/index";
import { renderFilterArtifacts } from "../../../scripts/entity-generator/render/filters";
import {
  expectedBrowserRouteFiles,
  missingBrowserRouteFiles,
} from "../../../scripts/entity-generator/render/routes";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

const expectDeclaredEntityParity = (
  compiled: CompiledEntity,
  definition: EntityDeclaration,
) => {
  expect(compiled.inspector).toMatchObject({
    singular: definition.names.singular,
    plural: definition.names.plural,
    titleField: definition.presentation.titleField,
  });
  expect(compiled.fieldModel.create).toEqual(definition.model?.create ?? []);
  expect(compiled.fieldModel.update).toEqual(definition.model?.update ?? []);
  expect(compiled.fieldModel.output).toEqual(definition.model?.output ?? []);
  expect(compiled.descriptor.relationships).toEqual(
    definition.relations.map((relation) => ({
      ...relation,
      sourceKey: relation.sourceKey ?? relation.key,
      sources: relation.sources ?? [],
    })),
  );
  for (const declared of definition.model?.fields ?? []) {
    const field = compiled.fieldModel.fields.find(
      ({ key }) => key === declared.key,
    );
    expect(field).toBeDefined();
    expect(field?.validation.read).toBe(declared.validation?.read ?? null);
    expect(field?.validation.create).toBe(declared.validation?.create ?? null);
    expect(field?.validation.update).toBe(declared.validation?.update ?? null);
  }
};

const base = {
  key: "alpha",
  names: { singular: "Alpha", plural: "Alphas" },
  route: null,
  table: null,
  identifiers: { brand: null, shortcode: null, legacy: null },
  presentation: { titleField: "name" },
  fields: null,
  filters: { descriptors: [] },
  relations: [],
  search: { enabled: false },
  capabilities: {
    auditable: false,
    images: false,
    countable: false,
    softDelete: false,
    delete: null,
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: null, merge: null },
    mcp: [],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: null,
      references: { label: null, resolver: null },
      filters: null,
      search: { projection: null, semanticText: null, dependentRefresh: null },
    },
  },
};
const model = {
  fields: [
    {
      key: "name",
      kind: "text",
      validation: {
        read: z.string(),
        create: z.string().trim().min(1).default("Example"),
        update: z.string().trim().min(1).optional(),
      },
    },
  ],
  storage: ["name"],
  create: ["name"],
  update: ["name"],
  output: ["name"],
  bulk: [],
  audit: ["name"],
};

const canonicalSchemaModules = new Set([
  "product.ts",
  "recipe.ts",
  "ingredient.ts",
  "cookbook.ts",
  "location.ts",
  "inventory.ts",
  "meal.ts",
  "task.ts",
  "ledger-party.ts",
  "ledger-transfer.ts",
  "project.ts",
  "vendor.ts",
  "purchase.ts",
  "financial-account.ts",
  "financial-transaction.ts",
  "wish.ts",
  "expense.ts",
  "image.ts",
  "usda.ts",
]);
const repositoryRoot = resolve(process.cwd(), "../..");

const declarationDependencyViolations = async () => {
  const roots = (await import("node:fs/promises")).readdir(
    resolve(repositoryRoot, "packages/schemas/src/entity-definitions"),
  );
  const files = (await roots).filter((file) => file.endsWith(".entity.ts"));
  const seen = new Set<string>();
  const pathByFile = new Map<string, string[]>();
  const violations: string[] = [];
  const visit = async (file: string): Promise<void> => {
    const absolute = resolve(file);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    const path = pathByFile.get(absolute) ?? [absolute];
    const source = await readFile(absolute, "utf8");
    const ast = parseSync(absolute, source, { lang: "ts" });
    const specifiers = ast.program.body.flatMap((statement) => {
      if (statement.type === "ImportDeclaration") {
        if (
          statement.importKind === "type" ||
          (statement.specifiers.length > 0 &&
            statement.specifiers.every(
              (specifier) =>
                specifier.type === "ImportSpecifier" &&
                specifier.importKind === "type",
            ))
        )
          return [];
        return [statement.source.value];
      }
      if (
        statement.type === "ExportAllDeclaration" &&
        statement.exportKind !== "type"
      )
        return [statement.source.value];
      if (
        statement.type === "ExportNamedDeclaration" &&
        statement.source !== null &&
        statement.exportKind !== "type"
      )
        return [statement.source.value];
      return [];
    });
    for (const specifier of specifiers) {
      const target = specifier.startsWith("@cubby/schemas/")
        ? resolve(
            repositoryRoot,
            "packages/schemas/src",
            `${specifier.slice("@cubby/schemas/".length)}.ts`,
          )
        : specifier.startsWith(".")
          ? resolve(
              dirname(absolute),
              `${specifier.replace(/\.[jt]s$/u, "")}.ts`,
            )
          : undefined;
      if (!target) continue;
      if (
        target.includes("/generated/") ||
        target.includes("/apps/") ||
        target.includes("/server/") ||
        target.includes("/browser/") ||
        canonicalSchemaModules.has(target.split("/").pop() ?? "")
      )
        violations.push([...path, target].join(" -> "));
      if (target.includes("packages/schemas/src/")) {
        pathByFile.set(target, [...path, target]);
        await visit(target);
      }
    }
  };
  await Promise.all(
    files.map((file) => {
      const root = join(
        repositoryRoot,
        "packages/schemas/src/entity-definitions",
        file,
      );
      pathByFile.set(root, [root]);
      return visit(root);
    }),
  );
  return violations.sort();
};

describe("typed entity compiler", () => {
  it("preserves literal model keys through the inferred declaration contract", () => {
    const definition = defineEntity({
      ...base,
      model: {
        fields: [
          {
            key: "displayName",
            kind: "text",
            validation: { read: z.string() },
          },
        ],
        storage: ["displayName"],
        create: ["displayName"],
        update: ["displayName"],
        output: ["displayName"],
        bulk: [],
        audit: [],
      },
    });
    type FieldKey = (typeof definition.model.fields)[number]["key"];
    const outputFields = ["displayName"] as const satisfies readonly FieldKey[];
    // @ts-expect-error A declaration policy cannot name a field it does not declare.
    const invalidOutputFields: readonly FieldKey[] = ["missing"];
    void invalidOutputFields;
    expectTypeOf(outputFields).toEqualTypeOf<readonly ["displayName"]>();
    expectTypeOf(readFieldSchemas(definition)).toEqualTypeOf<{
      displayName: z.ZodString;
    }>();
  });

  it("parses field metadata once while retaining declared Zod instances", () => {
    const read = z.string().brand<"ReadValue">();
    const parsed = parseEntityFieldModelMetadata(
      {
        fields: [{ key: "displayName", kind: "text", validation: { read } }],
        storage: ["displayName"],
        create: [],
        update: [],
        output: ["displayName"],
        bulk: [],
        audit: [],
      },
      "example.model",
    );
    expect(parsed?.fields[0]).toMatchObject({
      nullable: false,
      control: null,
      display: {
        list: false,
        detail: false,
        detailSection: "overview",
      },
      validation: { create: null, read, update: null },
    });
    expect(parsed?.fields[0]?.validation.read).toBe(read);
  });

  it("keeps executable declarations in the dependency-safe schema layer", async () => {
    expect(await declarationDependencyViolations()).toEqual([]);
  });

  it("retains actual schemas and explicit policies while defaulting presentation and storage", () => {
    const entity = compileEntityDeclarations([{ ...base, model }])[0]!;
    const field = entity.fieldModel.fields[0]!;
    expect(field).toMatchObject({
      key: "name",
      label: "Name",
      readKey: "name",
      nullable: false,
      control: null,
      display: { list: false, detail: false },
    });
    expect(field.validation.create).toBe(model.fields[0]!.validation.create);
    expect(field.validation.create!.parse(undefined)).toBe("Example");
    expect(field.validation.update!.parse(undefined)).toBeUndefined();
    expect(field.validation.read!.parse(" Example ")).toBe(" Example ");
    expect(field.validation.create!.parse(" Example ")).toBe("Example");
    expect(field.validation.update!.safeParse(null).success).toBe(false);
    expect(entity.fieldModel.storage[0]).toMatchObject({
      key: "name",
      column: "name",
      kind: "text",
      nullable: false,
      default: "none",
    });
    expect(entity.fieldModel.bulk).toEqual([]);
  });

  it("preserves every declared field schema and policy across the catalog", async () => {
    const entities = await loadEntityDeclarations();
    const compiledByKey = new Map(
      entities.map((entity) => [entity.key, entity]),
    );
    const definitionDirectory = resolve(
      repositoryRoot,
      "packages/schemas/src/entity-definitions",
    );
    const entries = (await readdir(definitionDirectory))
      .filter((entry) => entry.endsWith(".entity.ts"))
      .sort();

    for (const entry of entries) {
      const definition = (
        await import(pathToFileURL(join(definitionDirectory, entry)).href)
      ).default;
      const compiled = compiledByKey.get(definition.key);
      expect(compiled).toBeDefined();
      if (compiled !== undefined)
        expectDeclaredEntityParity(compiled, definition);
    }
  });

  it.each([
    [{ nullable: null }, "nullable must be a boolean"],
    [{ label: null }, "label must be a non-empty string"],
    [{ display: { list: null } }, "display.list must be a boolean"],
    [{ validation: { read: { kind: "string" } } }, "must be a Zod schema"],
    [{ validation: { write: z.string() } }, "write is not allowed"],
  ])("rejects invalid explicit field values: %j", (patch, message) => {
    expect(() =>
      compileEntityDeclarations([
        {
          ...base,
          model: {
            ...model,
            fields: [{ key: "name", kind: "text", ...patch }],
          },
        },
      ]),
    ).toThrow(message);
  });

  it("preserves null read projections and explicit storage exceptions; rejects undeclared storage", () => {
    const entity = compileEntityDeclarations([
      {
        ...base,
        model: {
          ...model,
          fields: [
            {
              key: "name",
              kind: "text",
              label: "Title",
              readKey: null,
              nullable: true,
            },
          ],
          storage: [
            {
              key: "name",
              column: "title",
              nullable: false,
              default: "literal",
              defaultValue: "Example",
            },
          ],
        },
      },
    ])[0]!;
    expect(entity.fieldModel.fields[0]).toMatchObject({
      readKey: null,
      nullable: true,
      validation: { read: null, create: null, update: null },
    });
    expect(entity.fieldModel.storage[0]).toMatchObject({
      column: "title",
      nullable: false,
      defaultValue: "Example",
    });
    expect(() =>
      compileEntityDeclarations([
        { ...base, model: { ...model, storage: ["missing"] } },
      ]),
    ).toThrow("references undeclared field missing");
  });

  it("compiles a declared sort roster and treats computed keys as exempt from the field roster", () => {
    const entity = compileEntityDeclarations([
      {
        ...base,
        model: {
          ...model,
          sort: {
            fields: ["name", "related:example.count"],
            default: "name",
            computed: ["related:example.count"],
            groupable: ["name"],
          },
        },
      },
    ])[0]!;
    expect(entity.fieldModel.sort).toEqual({
      fields: ["name", "related:example.count"],
      default: "name",
      computed: ["related:example.count"],
      groupable: ["name"],
    });
  });

  it("defaults an absent sort declaration to null", () => {
    const entity = compileEntityDeclarations([{ ...base, model }])[0]!;
    expect(entity.fieldModel.sort).toBeNull();
  });

  it.each([
    [
      { fields: ["missing"], default: "missing" },
      "references undeclared field missing",
    ],
    [
      { fields: ["name"], default: "missing" },
      "default missing must be one of sort.fields",
    ],
    [
      { fields: ["name"], default: "name", computed: ["missing"] },
      "computed missing must be one of sort.fields",
    ],
    [
      { fields: ["name"], default: "name", groupable: ["missing"] },
      "groupable missing must be one of sort.fields",
    ],
  ])("rejects an invalid sort declaration: %j", (sort, message) => {
    expect(() =>
      compileEntityDeclarations([{ ...base, model: { ...model, sort } }]),
    ).toThrow(message);
  });

  it("validates standard display renderers and sections", () => {
    const compile = (
      display: { standard?: string; detailSection?: string },
      kind = "text",
    ) =>
      compileEntityDeclarations([
        {
          ...base,
          model: { ...model, fields: [{ key: "name", kind, display }] },
        },
      ]);
    expect(() => compile({ standard: "unknown" })).toThrow(/./u);
    expect(() => compile({ standard: "name" }, "number")).toThrow(/./u);
    expect(() => compile({ detailSection: " " })).toThrow(
      "detailSection must not be blank",
    );
    expect(
      compile({ detailSection: "resources" })[0]?.fieldModel.fields[0]?.display
        .detailSection,
    ).toBe("resources");
  });

  it("rejects duplicate entity and shortcode identities", () => {
    expect(() => compileEntityDeclarations([base, base])).toThrow(
      "Duplicate entity key alpha",
    );
    const named = (key: string, shortcode: string, legacy = "A-") => ({
      ...base,
      key,
      identifiers: {
        ...base.identifiers,
        shortcode,
        legacy,
      },
    });
    expect(() =>
      compileEntityDeclarations([
        named("alpha", "ALP-"),
        named("beta", "ALP-", "B-"),
      ]),
    ).toThrow("conflicts");
    expect(() =>
      compileEntityDeclarations([
        named("alpha", "ALP-"),
        named("beta", "BET-", "A-"),
      ]),
    ).toThrow("conflicts");
  });

  it("rejects undeclared capabilities and obsolete ports", () => {
    expect(() =>
      compileEntityDeclarations([
        {
          ...base,
          extensions: {
            ...base.extensions,
            ports: {
              ...base.extensions.ports,
              lifecycle: {},
            },
          },
        },
      ]),
    ).toThrow("ports.lifecycle is not allowed");
    expect(() =>
      compileEntityDeclarations([
        {
          ...base,
          fields: {
            create: null,
            update: null,
            output: { module: "@cubby/schemas/example", export: "output" },
          },
        },
      ]),
    ).toThrow("shortcode");
  });

  it("requires inverse paths for local relationships and rejects deletion policy on views", async () => {
    const raw = (
      await import("../../../packages/schemas/src/entity-definitions/02-ingredient.entity")
    ).default;
    const relation = {
      key: "child",
      label: "Child",
      target: "ingredient",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Ingredient.recipeId", direction: "outgoing" }],
      },
    };
    // The loaded declaration is checked by the same compiler as every production entity.
    const metadata = raw;
    expect(() =>
      compileEntityDeclarations([{ ...metadata, relations: [relation] }]),
    ).toThrow("requires inverse");
    expect(() =>
      compileEntityDeclarations([
        {
          ...metadata,
          relations: [
            { ...relation, inverse: { steps: [] }, deletionPolicy: "restrict" },
          ],
        },
      ]),
    ).toThrow("deletionPolicy is not allowed");
  });

  it("validates filter descriptors and audit ownership", () => {
    const text = { columnId: "name", kind: "text", placeholder: "Search" };
    const cases = [
      [{ descriptors: [{ ...text, kind: "fuzzy" }] }, "kind is unsupported"],
      [
        { descriptors: [text, { ...text, urlKey: "alias" }] },
        "duplicate columnId",
      ],
      [
        {
          descriptors: [
            { ...text, urlKey: "same" },
            { ...text, columnId: "alias", urlKey: "same" },
          ],
        },
        "duplicate URL keys",
      ],
      [{ audit: "yes", descriptors: [] }, "filters.audit must be a boolean"],
      [{ urlKeys: [], descriptors: [] }, "filters.urlKeys is not allowed"],
      [{ audit: true, descriptors: [] }, "requires an auditable entity"],
      [{ audit: false }, "filters.descriptors is required"],
      [
        {
          descriptors: [
            { ...text, options: [], optionsRef: { module: "x", export: "y" } },
          ],
        },
        "cannot declare both",
      ],
    ] as const;
    for (const [filters, message] of cases)
      expect(() => compileEntityDeclarations([{ ...base, filters }])).toThrow(
        message,
      );
    expect(
      compileEntityDeclarations([
        {
          ...base,
          capabilities: { ...base.capabilities, auditable: true },
          filters: { audit: true, descriptors: [] },
        },
      ])[0]?.filterUrlKeys,
    ).toEqual(["createdAt", "updatedAt"]);
  });

  it("requires route modules for generated browser destinations", () => {
    const entities = compileEntityDeclarations([
      { ...base, route: { basePath: "alphas", detailParam: "id" } },
    ]);
    const expected = expectedBrowserRouteFiles(entities);
    expect(expected).toEqual([
      "apps/web/src/routes/_authenticated/alphas.index.tsx",
      "apps/web/src/routes/_authenticated/alphas.$id.tsx",
    ]);
    expect(
      missingBrowserRouteFiles(entities, (path) => path.endsWith(expected[0]!)),
    ).toEqual([expected[1]]);
  });

  it("reports missing, stale and extraneous generated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cubby-entities-"));
    temporaryRoots.push(root);
    const artifacts = [
      {
        relativePath: "generated/entity-literal-alpha.gen.ts",
        source: "export const alpha = 1;\n",
      },
    ];
    expect(await checkEntityArtifacts(root, artifacts)).toEqual([
      "missing: generated/entity-literal-alpha.gen.ts",
    ]);
    await mkdir(join(root, "generated"));
    await writeFile(
      join(root, "generated/entity-literal-alpha.gen.ts"),
      "stale",
    );
    await writeFile(
      join(root, "generated/entity-literal-extra.gen.ts"),
      "extra",
    );
    expect(await checkEntityArtifacts(root, artifacts)).toEqual([
      "stale: generated/entity-literal-alpha.gen.ts",
      "extraneous: generated/entity-literal-extra.gen.ts",
    ]);
  });

  it("compiles the full catalog with schema references and schema-free browser metadata", async () => {
    const entities = await loadEntityDeclarations();
    const artifacts = [
      ...renderEntityArtifacts(entities),
      ...renderFilterArtifacts(entities),
    ];
    const artifact = (suffix: string) =>
      artifacts.find(({ relativePath }) => relativePath.endsWith(suffix))!
        .source;
    expect(entities).toHaveLength(19);
    expect(artifact("entity-field-schemas.ingredient.gen.ts")).toContain(
      "definition.model.fields[",
    );
    // Field schema maps reference the declaration; only the filter fields
    // derived from descriptor metadata spell Zod, and those come after them.
    const ingredientSchemas = artifact(
      "entity-field-schemas.ingredient.gen.ts",
    );
    const [fieldMaps, filterFields] = ingredientSchemas.split(
      "generatedIngredientFilterFields",
    );
    expect(fieldMaps).not.toContain("z.string()");
    expect(filterFields).toContain(
      'nameFilter":z.string().optional().describe(',
    );
    expect(filterFields).toContain('"usuallyOnHand":z.boolean().optional()');
    expect(artifact("entity-field-model.gen.ts")).not.toContain("validation:");
    expect(artifact("entity-field-model.gen.ts")).not.toMatch(
      /^import .*entity-definitions\//m,
    );
    expect(artifact("entity-details.gen.ts")).not.toContain("~/server/");
    expect(artifact("entity-filter-bindings.gen.ts")).toContain(
      'columnId:"related:product.tasks"',
    );
    expect(artifact("shortcode-registry.gen.ts")).toContain(
      'LEGACY_SHORTCODE_PREFIX = {"P-":"product","L-":"location"}',
    );
    expect(artifact("entity-details.gen.ts")).toContain(
      '"product": productWithFoodOut',
    );
    expect(artifact("entity-details.gen.ts")).toContain(
      "z.output<(typeof ENTITY_DETAIL_OUTPUT_SCHEMAS)[E]>",
    );
    expect(artifact("entity-lists.gen.ts")).toContain(
      "z.input<(typeof ENTITY_LIST_FILTER_SCHEMAS)[E]>",
    );
    expect(artifact("entity-lists.gen.ts")).toContain(
      "ENTITY_LIST_FILTER_SCHEMAS",
    );
    const swiftCatalog = artifact("EntityCatalog.swift");
    expect(swiftCatalog).toContain("public enum EntityKey");
    const entityKeyBody = swiftCatalog
      .split("public enum EntityKey")[1]!
      .split("\n}\n")[0]!;
    expect(entityKeyBody.match(/^ {2}case /gmu)).toHaveLength(19);
  });
});
