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
import {
  checkArtifacts,
  findExtraArtifacts,
  generatedHeader,
} from "../../../scripts/generator/artifacts";
import {
  compileEntityDeclarations,
  validatePhotoCategoryLabels,
} from "../../../scripts/generator/entities/compile";
import { loadEntityDeclarations } from "../../../scripts/generator/entities/declarations";
import type { CompiledEntity } from "../../../scripts/generator/entities/declarations";
import { renderBrowserRouteArtifacts } from "../../../scripts/generator/entities/render/browser-routes";
import { renderEntityArtifacts } from "../../../scripts/generator/entities/render/index";
import { renderFilterArtifacts } from "../../../scripts/generator/entities/render/filters";
import { renderKernelBindingsArtifacts } from "../../../scripts/generator/entities/render/kernel-bindings";
import { renderImagePolicyArtifacts } from "../../../scripts/generator/entities/render/image-policy";
import { renderRelationArtifacts } from "../../../scripts/generator/entities/render/relations";
import {
  generatedBrowserRouteFiles,
  handWrittenBrowserRouteFiles,
  missingBrowserRouteFiles,
} from "../../../scripts/generator/entities/render/routes";
import { renderSearchArtifacts } from "../../../scripts/generator/entities/render/search";

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
  // `capabilities.dataQuality` synthesizes one output field beyond the
  // declaration's own roster (docs/entities.md "Data quality").
  expect(compiled.fieldModel.output).toEqual([
    ...(definition.model?.output ?? []),
    ...(definition.capabilities.dataQuality ? ["dataQuality"] : []),
  ]);
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

const presentation = {
  titleField: "name",
  domain: null,
  description: "Alpha records.",
  emptyState: { title: "No alphas", description: "Add one." },
  icons: { lucide: "Box", sfSymbol: "cube", emoji: "🧊" },
} as const;

const base = {
  key: "alpha",
  names: { singular: "Alpha", plural: "Alphas" },
  route: null,
  table: null,
  identifiers: { brand: null, shortcode: null },
  presentation,
  fields: null,
  filters: { descriptors: [] },
  relations: [],
  search: { enabled: false },
  capabilities: {
    auditable: false,
    images: { storage: false as const },
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
  it("rejects image policies whose routes, evidence, or candidate fields escape the manifest", () => {
    const definition = (
      images: EntityDeclaration["capabilities"]["images"],
    ) => ({
      ...base,
      model,
      capabilities: { ...base.capabilities, images },
    });
    const routing: NonNullable<
      EntityDeclaration["capabilities"]["images"]["routing"]
    > = {
      candidateFields: ["name"],
      temporalFields: [],
      lifecycleFilters: [],
      signals: { ocrFields: ["name"], classifierLabels: ["alpha"] },
      abstention: { minimumScore: 0.7, minimumMargin: 0.1 },
      category: "food",
    };

    expect(() =>
      compileEntityDeclarations([
        definition({
          storage: false,
          ingress: [
            {
              kind: "existingRelated",
              routeId: "alpha-missing",
              relationPath: ["missing"],
            },
          ],
          routing,
        }),
      ]),
    ).toThrow("references undeclared relation alpha.missing");
    expect(() =>
      compileEntityDeclarations([
        {
          ...definition({
            storage: false,
            ingress: [
              {
                kind: "existingRelated",
                routeId: "alpha-related-without-storage",
                relationPath: ["self"],
              },
            ],
            routing,
          }),
          relations: [
            {
              key: "self",
              label: "Self",
              target: "alpha",
              cardinality: "one",
              provenance: {
                kind: "local-path",
                steps: [{ edge: "Alpha.id", direction: "outgoing" }],
              },
              inverse: {
                steps: [{ edge: "Alpha.id", direction: "incoming" }],
              },
            },
          ],
        },
      ]),
    ).toThrow("has no direct image storage");
    expect(() =>
      compileEntityDeclarations([
        definition({
          storage: "gallery",
          ingress: [],
          routing,
        }),
      ]),
    ).toThrow("requires exactly one self route");
    expect(() =>
      compileEntityDeclarations([
        definition({
          storage: false,
          ingress: [],
          routing: { ...routing, candidateFields: ["missing"] },
        }),
      ]),
    ).toThrow("references undeclared field missing");
    // Every storage-bearing entity must declare exactly one createSelf route, naming the
    // entity, so "which entities could create from a photo" is explicit rather than an
    // absence a client has to notice on its own.
    expect(() =>
      compileEntityDeclarations([
        definition({
          storage: "gallery",
          ingress: [{ kind: "self", routeId: "alpha-self-no-create-self" }],
          routing,
        }),
      ]),
    ).toThrow(
      "alpha.capabilities.images.ingress requires exactly one createSelf route",
    );
    // createSelf has no source record, so its bindings may only draw from the photo itself
    // (capture-date | constant) — a source-id binding is rejected at the schema layer.
    // Passed inline (not through the `EntityDeclaration`-typed `definition` helper) so
    // `compileEntityDeclarations`'s `readonly unknown[]` parameter, not a narrower local
    // binding, is what accepts this otherwise-statically-forbidden shape.
    expect(() =>
      compileEntityDeclarations([
        {
          ...base,
          model,
          capabilities: {
            ...base.capabilities,
            images: {
              storage: "gallery",
              ingress: [
                { kind: "self", routeId: "alpha-self-bad-binding" },
                {
                  kind: "createSelf",
                  routeId: "alpha-new-bad-binding",
                  enabled: false,
                  disabledReason: "test",
                  bindings: [{ field: "name", from: "source-id" }],
                },
              ],
              routing,
            },
          },
        },
      ]),
    ).toThrow(/Invalid discriminator value/);

    const directImages = {
      storage: "gallery" as const,
      ingress: [
        { kind: "self" as const, routeId: "shared-photo-route" },
        {
          kind: "createSelf" as const,
          routeId: "shared-photo-route-new",
          enabled: false,
          disabledReason: "test",
        },
      ],
      routing,
    };
    expect(() =>
      compileEntityDeclarations([
        definition(directImages),
        {
          ...definition(directImages),
          key: "beta",
          names: { singular: "Beta", plural: "Betas" },
          presentation: { ...presentation, description: "Beta records." },
        },
      ]),
    ).toThrow("routeId shared-photo-route conflicts");
  });

  it("emits a conditional-primary route's resolved literal and predicate", () => {
    const routing = {
      candidateFields: ["name"],
      temporalFields: [],
      lifecycleFilters: [],
      signals: { ocrFields: ["name"], classifierLabels: ["alpha"] },
      abstention: { minimumScore: 0.7, minimumMargin: 0.1 },
      category: "food",
    } as const;
    const compiled = compileEntityDeclarations([
      {
        ...base,
        model: {
          ...model,
          fields: [
            ...model.fields,
            {
              key: "kind",
              kind: "enum" as const,
              validation: {
                read: z.enum(["a", "b"]),
                create: z.enum(["a", "b"]).optional(),
                update: z.enum(["a", "b"]).optional(),
              },
            },
          ],
        },
        capabilities: {
          ...base.capabilities,
          images: {
            storage: "gallery" as const,
            ingress: [
              {
                kind: "self" as const,
                routeId: "alpha-self-conditional",
                // Falls back to "prompt" (not "alternate") so this fixture does not also
                // need an unconditional primary route to satisfy the separate "alternate
                // requires a primary" invariant.
                choice: {
                  primary: { when: { field: "kind", oneOf: ["a"] } },
                  otherwise: "prompt" as const,
                },
              },
              {
                kind: "createSelf" as const,
                routeId: "alpha-new-conditional",
                enabled: false,
                disabledReason: "test",
                choice: "prompt" as const,
              },
            ],
            routing,
          },
        },
      },
    ]);
    const imagePolicy = renderImagePolicyArtifacts(compiled).find(
      ({ relativePath }) => relativePath.endsWith("image-policy.gen.ts"),
    )?.source;
    expect(imagePolicy).toContain('"routeId":"alpha-self-conditional"');
    expect(imagePolicy).toContain('"choice":"prompt"');
    expect(imagePolicy).toContain(
      '"primaryWhen":{"field":"kind","oneOf":["a"]}',
    );
  });

  it("keeps routing visual evidence explicit and requires image-owning targets", async () => {
    const recipe = (
      await import("../../../packages/schemas/src/entity-definitions/01-recipe.entity")
    ).default;
    const planting = (
      await import("../../../packages/schemas/src/entity-definitions/19-planting.entity")
    ).default;
    const meal = (
      await import("../../../packages/schemas/src/entity-definitions/06-meal.entity")
    ).default;
    expect(recipe.capabilities.images.routing?.visualEvidence).toEqual([
      { relationPath: ["meals"], priority: 1, ordering: "newest" },
    ]);
    expect(planting.capabilities.images.routing?.visualEvidence).toEqual([
      { relationPath: ["entries"], priority: 1, ordering: "newest" },
    ]);
    // A display fallback alone is never promoted to routing evidence.
    expect("visualEvidence" in (meal.capabilities.images.routing ?? {})).toBe(
      false,
    );

    const routing: NonNullable<
      EntityDeclaration["capabilities"]["images"]["routing"]
    > = {
      candidateFields: ["name"],
      temporalFields: [],
      lifecycleFilters: [],
      signals: { ocrFields: ["name"], classifierLabels: ["alpha"] },
      abstention: { minimumScore: 0.7, minimumMargin: 0.1 },
      category: "food",
      visualEvidence: [
        { relationPath: ["related"], priority: 1, ordering: "newest" },
      ],
    };
    const related = {
      ...base,
      key: "related",
      names: { singular: "Related", plural: "Related" },
      model,
      capabilities: {
        ...base.capabilities,
        images: {
          storage: "gallery" as const,
          ingress: [
            { kind: "self" as const, routeId: "related-self" },
            {
              kind: "createSelf" as const,
              routeId: "related-new",
              enabled: false,
              disabledReason: "test",
            },
          ],
          routing: { ...routing, visualEvidence: [] },
        },
      },
    };
    const source = {
      ...base,
      model,
      relations: [
        {
          key: "related",
          label: "Related",
          target: "related",
          cardinality: "one" as const,
          provenance: {
            kind: "local-path",
            steps: [{ edge: "Alpha.relatedId", direction: "outgoing" }],
          },
          inverse: {
            steps: [{ edge: "Alpha.relatedId", direction: "incoming" }],
          },
        },
      ],
      capabilities: {
        ...base.capabilities,
        images: { storage: false as const, routing },
      },
    };
    expect(() => compileEntityDeclarations([source, related])).not.toThrow();

    expect(() =>
      compileEntityDeclarations([
        {
          ...source,
          capabilities: {
            ...source.capabilities,
            images: {
              storage: false as const,
              routing: {
                ...routing,
                visualEvidence: [
                  {
                    relationPath: ["missing"],
                    priority: 1,
                    ordering: "newest" as const,
                  },
                ],
              },
            },
          },
        },
        related,
      ]),
    ).toThrow("references undeclared relation alpha.missing");

    expect(() =>
      compileEntityDeclarations([
        {
          ...source,
          capabilities: {
            ...source.capabilities,
            images: {
              storage: false as const,
              routing: {
                ...routing,
                visualEvidence: [
                  {
                    relationPath: ["related"],
                    priority: 1,
                    ordering: "newest" as const,
                  },
                ],
              },
            },
          },
          relations: [{ ...source.relations[0]!, target: "alpha" }],
        },
        related,
      ]),
    ).toThrow("targets alpha, which does not have gallery image storage");

    // Cover/logo storage is also rejected: PhotoVisualEvidenceMatcher only
    // reads attachment-role (gallery) images, so evidence aimed at a
    // cover/logo-only target could never fire.
    expect(() =>
      compileEntityDeclarations([
        source,
        {
          ...related,
          capabilities: {
            ...related.capabilities,
            images: { ...related.capabilities.images, storage: "cover" },
          },
        },
      ]),
    ).toThrow("targets related, which does not have gallery image storage");

    const compiled = compileEntityDeclarations([source, related]);
    const artifacts = renderImagePolicyArtifacts(compiled);
    const imagePolicy = artifacts.find(({ relativePath }) =>
      relativePath.endsWith("image-policy.gen.ts"),
    )?.source;
    expect(imagePolicy).toContain('"visualEvidence"');
    expect(imagePolicy).toContain('"relationPath":["related"]');
  });

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
      direction: "desc",
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

  it("validates standard display renderers", () => {
    const compile = (display: { standard?: string }, kind = "text") =>
      compileEntityDeclarations([
        {
          ...base,
          model: { ...model, fields: [{ key: "name", kind, display }] },
        },
      ]);
    expect(() => compile({ standard: "unknown" })).toThrow(/./u);
    expect(() => compile({ standard: "name" }, "number")).toThrow(/./u);
  });

  it.each([
    [
      "list",
      { list: "alpha-list" },
      "display.renderer.list requires display.list",
    ],
    [
      "detail",
      { detail: "alpha-detail" },
      "display.renderer.detail requires display.detail",
    ],
  ])(
    "rejects a %s renderer on an inactive display surface",
    (_, renderer, message) => {
      expect(() =>
        compileEntityDeclarations([
          {
            ...base,
            model: {
              ...model,
              fields: [{ ...model.fields[0], display: { renderer } }],
            },
          },
        ]),
      ).toThrow(message);
    },
  );

  it("keeps list renderers valid when the list column is initially hidden", () => {
    expect(() =>
      compileEntityDeclarations([
        {
          ...base,
          model: {
            ...model,
            fields: [
              {
                ...model.fields[0],
                display: {
                  list: true,
                  listHidden: true,
                  renderer: { list: "alpha-list" },
                },
              },
            ],
          },
        },
      ]),
    ).not.toThrow();
  });

  it("validates titleField against the read projection, not model field keys", () => {
    // `readKey` renames a field for output; `titleField` must resolve through
    // that rename (cookbook's `name` field reads out as `book`, so
    // `titleField: "book"` is legal) rather than matching a raw model key. A
    // second, always-readable field keeps the read projection non-empty so
    // the "no readable fields at all" exemption doesn't mask these cases.
    const compileWithReadKey = (readKey: string | null) =>
      compileEntityDeclarations([
        {
          ...base,
          presentation: { ...presentation, titleField: "book" },
          model: {
            ...model,
            fields: [
              { ...model.fields[0], readKey },
              { key: "other", kind: "text", validation: { read: z.string() } },
            ],
          },
        },
      ]);
    expect(compileWithReadKey("book")[0]?.inspector.titleField).toBe("book");
    expect(() => compileWithReadKey(null)).toThrow(
      /titleField "book" for entity "alpha" must be a read-projection key/,
    );
    expect(() => compileWithReadKey("name")).toThrow(
      /titleField "book" for entity "alpha" must be a read-projection key/,
    );
  });

  it("skips titleField validation when the entity has no readable fields", () => {
    // A storage-only field set (every field's readKey is null) has no read
    // projection to validate a titleField against; this must compile rather
    // than reject a value that can never be satisfied.
    const entity = compileEntityDeclarations([
      {
        ...base,
        presentation,
        model: {
          ...model,
          fields: [{ ...model.fields[0], readKey: null }],
        },
      },
    ])[0]!;
    expect(entity.inspector.titleField).toBe("name");
  });

  it("rejects duplicate entity and shortcode identities", () => {
    expect(() => compileEntityDeclarations([base, base])).toThrow(
      "Duplicate entity key alpha",
    );
    const named = (key: string, shortcode: string) => ({
      ...base,
      key,
      identifiers: { ...base.identifiers, shortcode },
    });
    expect(() =>
      compileEntityDeclarations([
        named("alpha", "ALP-"),
        named("beta", "ALP-"),
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

  it("carries display.listOrder and validates it", () => {
    const withListOrder = (listOrder: number | undefined) =>
      compileEntityDeclarations([
        {
          ...base,
          model: {
            ...model,
            fields: [
              { key: "name", kind: "text", display: { list: true, listOrder } },
            ],
          },
        },
      ])[0]?.fieldModel.fields[0]?.display.listOrder;
    expect(withListOrder(2)).toBe(2);
    expect(withListOrder(undefined)).toBeNull();
    expect(() => withListOrder(-1)).toThrow("Too small");
    expect(() => withListOrder(1.5)).toThrow("expected int");
  });

  it("validates stored filter shapes against the storage model", () => {
    const fields = [
      { key: "name", kind: "text" },
      { key: "tags", kind: "text-array", nullable: true },
      { key: "flag", kind: "boolean" },
      { key: "at", kind: "timestamp", nullable: true },
      { key: "amount", kind: "number" },
    ];
    type RawDescriptor = EntityDeclaration["filters"]["descriptors"][number];
    const stored = (
      descriptor: Pick<RawDescriptor, "columnId" | "kind"> &
        Partial<RawDescriptor>,
    ) =>
      compileEntityDeclarations([
        {
          ...base,
          model: {
            ...model,
            fields,
            storage: ["name", "tags", "flag", "at", "amount"],
          },
          filters: {
            descriptors: [
              {
                placeholder: "x",
                deriveSchema: true,
                stored: true,
                ...descriptor,
              },
            ],
          },
        },
      ])[0]?.filterDescriptors[0]?.stored;
    expect(stored({ columnId: "name", kind: "text" })).toEqual({
      columns: ["name"],
      array: false,
    });
    expect(
      stored({
        columnId: "search",
        kind: "text",
        stored: { columns: ["name", "tags"] },
      }),
    ).toEqual({ columns: ["name", "tags"], array: false });
    expect(
      stored({
        columnId: "tags",
        kind: "multiselect",
        optionsKey: "tags",
        stored: { array: true },
      }),
    ).toEqual({ columns: ["tags"], array: true });
    expect(stored({ columnId: "at", kind: "boolean" })).toEqual({
      columns: ["at"],
      array: false,
    });
    const rejected: Array<[Parameters<typeof stored>[0], string]> = [
      [
        { columnId: "name", kind: "text", deriveSchema: false },
        "stored requires deriveSchema",
      ],
      [
        { columnId: "name", kind: "text", stored: { columns: ["missing"] } },
        "needs a stored model field missing",
      ],
      [
        {
          columnId: "flag",
          kind: "boolean",
          stored: { columns: ["flag", "name"] },
        },
        "several fields only for a text filter",
      ],
      [
        { columnId: "tags", kind: "multiselect", optionsKey: "tags" },
        "needs stored.array",
      ],
      [
        {
          columnId: "name",
          kind: "multiselect",
          optionsKey: "names",
          stored: { array: true },
        },
        "applies only to a multiselect over a text-array field",
      ],
      [
        { columnId: "amount", kind: "boolean" },
        "reads as presence, so the field must be nullable",
      ],
      [
        { columnId: "at", kind: "range", range: { finite: true } },
        "range.int/finite apply only to numeric ranges",
      ],
    ];
    for (const [descriptor, message] of rejected)
      expect(() => stored(descriptor)).toThrow(message);
  });

  it("checks every presentation declaration against the fields, relations and capabilities", () => {
    const presented = {
      ...base,
      model: {
        ...model,
        fields: [
          ...model.fields,
          {
            key: "status",
            kind: "enum",
            control: {
              kind: "select",
              options: [{ value: "open", label: "Open" }],
            },
            provenance: {
              kind: "derived",
              sources: [{ label: "Workflow state" }],
            },
            display: { detail: true },
            validation: { read: z.enum(["open"]), create: null, update: null },
          },
          {
            key: "dueOn",
            kind: "date",
            provenance: {
              kind: "derived",
              sources: [{ label: "Scheduling rules" }],
            },
            display: { detail: true },
            validation: { read: z.string(), create: null, update: null },
          },
        ],
        output: ["name", "status", "dueOn"],
      },
      relations: [
        {
          key: "parent",
          label: "Parent",
          target: "alpha",
          cardinality: "one",
          provenance: {
            kind: "local-path",
            steps: [{ edge: "Alpha.parentId", direction: "outgoing" }],
          },
          inverse: {
            steps: [{ edge: "Alpha.parentId", direction: "incoming" }],
          },
        },
      ],
    };
    const compile = (
      presentation: Partial<EntityDeclaration["presentation"]>,
      capabilities: Partial<EntityDeclaration["capabilities"]> = {},
    ) =>
      compileEntityDeclarations([
        {
          ...presented,
          presentation: { ...base.presentation, ...presentation },
          capabilities: { ...base.capabilities, ...capabilities },
        },
      ]);
    const fields = (
      keys: string[],
    ): Partial<EntityDeclaration["presentation"]> => ({
      detail: {
        sections: [
          { kind: "fields", id: "overview", title: "Overview", fields: keys },
        ],
      },
    });
    expect(
      compile(fields(["status", "dueOn"]))[0]?.inspector.detail.hero,
    ).toEqual({
      chip: null,
      stats: [],
      breadcrumb: null,
      images: false,
      actions: [],
    });
    const rejected: [
      string,
      Partial<EntityDeclaration["presentation"]>,
      string,
    ][] = [
      [
        "a non-detail field in a fields section",
        fields(["name"]),
        "not a display.detail field",
      ],
      ["a detail field left unplaced", fields(["status"]), "unplaced: dueOn"],
      [
        "a field placed twice",
        {
          detail: {
            sections: [
              {
                kind: "fields",
                id: "a",
                title: "A",
                fields: ["status", "dueOn"],
              },
              { kind: "fields", id: "b", title: "B", fields: ["status"] },
            ],
          },
        },
        "already placed in a",
      ],
      [
        "a reserved section id",
        { detail: { sections: [{ kind: "slot", id: "history" }] } },
        "reserved id",
      ],
      [
        "a relation section over a to-one relation",
        {
          detail: {
            sections: [
              {
                kind: "relation",
                id: "parent",
                title: "Parent",
                relation: "parent",
                filter: { descriptor: "parentId" },
              },
            ],
          },
        },
        "not a many-cardinality relation",
      ],
      [
        "a text hero chip",
        { detail: { hero: { chip: "name" } } },
        "must be an enum or boolean field",
      ],
      [
        "a non-reference breadcrumb",
        { detail: { hero: { breadcrumb: "name" } } },
        "must be a reference field",
      ],
      [
        "a timeline view without the capability",
        { list: { views: ["table", "timeline"] } },
        "without capabilities.timeline",
      ],
      [
        "a readOnlyWhen value outside the control options",
        {
          edit: {
            readOnlyWhen: [
              { field: "status", equals: "closed", fields: ["name"] },
            ],
          },
        },
        "not one of status's control options",
      ],
    ];
    for (const [, presentation, message] of rejected)
      expect(() => compile(presentation)).toThrow(message);
    expect(() => compile({}, { timeline: "custom" })).toThrow(
      "must be declared together",
    );
    expect(() =>
      compile(
        { list: { timeline: { lifecycle: { start: "name" } } } },
        { timeline: "default" },
      ),
    ).toThrow("must be a date or timestamp field");
  });

  it("compiles a card view for an entity without stored images and preserves captions", () => {
    const [compiled] = compileEntityDeclarations([
      {
        ...base,
        model,
        capabilities: {
          ...base.capabilities,
          images: { storage: false },
        },
        presentation: {
          ...base.presentation,
          list: {
            views: ["table", "shelf"],
            shelf: { subtitle: ["name"] },
          },
        },
      },
    ]);

    expect(compiled?.inspector.list.views).toEqual(["table", "shelf"]);
    expect(compiled?.inspector.list.shelf).toEqual({ subtitle: ["name"] });

    const [fallbackCompiled] = compileEntityDeclarations([
      {
        ...base,
        model: {
          ...model,
          fields: [
            ...model.fields,
            {
              key: "kind",
              kind: "text" as const,
              display: { mobile: { slot: "subtitle", priority: 10 } },
              validation: { read: z.string(), create: null, update: null },
            },
          ],
          output: ["name", "kind"],
        },
        capabilities: {
          ...base.capabilities,
          images: { storage: false },
        },
      },
    ]);

    expect(fallbackCompiled?.inspector.list.shelf).toEqual({
      subtitle: ["kind"],
    });
  });

  it("splits browser route modules between the generator and hand-written files", () => {
    const entities = compileEntityDeclarations([
      {
        ...base,
        route: {
          basePath: "alphas",
          detailParam: "id",
          create: "page",
          list: null,
          detail: {
            query: { module: "~/entities/alpha", export: "alphaQuery" },
          },
        },
      },
    ]);
    expect(generatedBrowserRouteFiles(entities)).toEqual([
      "apps/web/src/routes/_authenticated/alphas.$id.tsx",
    ]);
    const expected = handWrittenBrowserRouteFiles(entities);
    expect(expected).toEqual([
      "apps/web/src/routes/_authenticated/alphas.index.tsx",
      "apps/web/src/routes/_authenticated/alphas.new.tsx",
    ]);
    expect(
      missingBrowserRouteFiles(entities, (path) => path.endsWith(expected[0]!)),
    ).toEqual([expected[1]]);
    // A generated detail page reads the kernel projections, which need a
    // create+update contract; a generated index only needs something to list.
    expect(() =>
      compileEntityDeclarations([
        { ...base, route: { basePath: "alphas", list: null, detail: true } },
      ]),
    ).toThrow("no create+update contract");
    expect(() =>
      compileEntityDeclarations([
        { ...base, route: { basePath: "alphas", list: true, detail: null } },
      ]),
    ).toThrow("has no contract (nothing to list)");
    // A dialog-created entity needs a capture intent for the dialog to open.
    expect(() =>
      compileEntityDeclarations([
        {
          ...base,
          route: {
            basePath: "alphas",
            create: "dialog",
            list: null,
            detail: null,
          },
        },
      ]),
    ).toThrow('model.intents.create lacks "capture"');
  });

  it("reports missing, stale and extraneous generated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cubby-entities-"));
    temporaryRoots.push(root);
    const artifacts = [
      {
        relativePath: "generated/entity-literal-alpha.gen.ts",
        source: `${generatedHeader}export const alpha = 1;\n`,
      },
    ];
    expect(await checkArtifacts(root, artifacts)).toEqual([
      "missing: generated/entity-literal-alpha.gen.ts",
    ]);
    await mkdir(join(root, "generated"));
    await writeFile(
      join(root, "generated/entity-literal-alpha.gen.ts"),
      "stale",
    );
    // Extraneous detection reads the generator ownership header, not the
    // filename: a stray file only counts if it carries that header — which
    // catches a retired artifact name (nothing in the current artifact list
    // matches it) exactly as it catches a still-current one.
    await writeFile(
      join(root, "generated/entity-retired-name.gen.ts"),
      `${generatedHeader}export const retired = 1;\n`,
    );
    // A file with no generator header — even one shaped like a generated
    // artifact's name — is left alone; it isn't ours to flag.
    await writeFile(join(root, "generated/notes.gen.ts"), "// just a note\n");
    expect(await checkArtifacts(root, artifacts)).toEqual([
      "stale: generated/entity-literal-alpha.gen.ts",
    ]);
    expect(await findExtraArtifacts(root, artifacts)).toEqual([
      "generated/entity-retired-name.gen.ts",
    ]);
  });

  it("compiles the full catalog with schema references and schema-free browser metadata", async () => {
    const entities = await loadEntityDeclarations();
    const artifacts = [
      ...renderEntityArtifacts(entities),
      ...renderRelationArtifacts(entities),
      ...renderKernelBindingsArtifacts(entities),
      ...renderFilterArtifacts(entities),
      ...renderSearchArtifacts(entities),
      ...renderBrowserRouteArtifacts(entities),
      ...renderImagePolicyArtifacts(entities),
    ];
    const artifact = (suffix: string) =>
      artifacts.find(({ relativePath }) => relativePath.endsWith(suffix))!
        .source;
    // Search codecs follow the descriptor kind: exact-entity filters brand
    // their shortcodes (nullable ones also admit the presence sentinels),
    // static rosters validate as enums, and everything else stays a string.
    // (Sources are asserted as rendered; oxfmt runs when the artifact is sealed.)
    const search = artifact("entity-search.gen.ts");
    expect(search).toContain('"productId":urlShortcodeParam("product")');
    expect(search).toContain(
      '"location":urlShortcodeListParam("location", { sentinels: PRESENCE_SENTINELS })',
    );
    expect(search).toContain('"kind":urlEnumListParam(searchRef');
    expect(search).toContain("create:createSearchField");
    expect(search).toContain('"manufacturer":urlStringParam');
    const explanationReference = artifact("how-values-are-determined.md");
    expect(explanationReference).toContain("# How values are determined");
    expect(explanationReference).not.toContain("\nDerived from ");
    const explanationCount = entities.reduce(
      (count, entity) =>
        count +
        entity.fieldModel.fields.filter((field) => field.explanation !== null)
          .length,
      0,
    );
    expect(explanationReference.match(/^### /gmu)).toHaveLength(
      explanationCount,
    );
    expect(explanationReference).toContain(
      "A manual valuation price wins; otherwise Cubby derives a per-unit price",
    );
    expect(explanationReference).toContain(
      "- Rule: `product.effective-valuation-price`, version 1",
    );
    expect(explanationReference).toContain(
      "- Value paths: List `pricing.effectivePrice`; Detail `pricing.effectivePrice`; Summary `pricing.effectivePrice`",
    );
    expect(explanationReference).toContain("Manual valuation price (`price`)");
    expect(explanationReference).toContain("- Available actions: Edit source");
    expect(explanationReference).toContain(
      "- Value paths: List `displayImages`; Detail `images`; Summary `displayImages`",
    );
    expect(explanationReference).toContain(
      "Selected product images (`displayImages`)",
    );
    expect(explanationReference).toContain(
      "Parent project (`parentProjectId`)",
    );
    expect(explanationReference).toContain("Image storage key (`key`)");
    // Generated routes keep a literal options object (the code-splitter
    // contract) and address the entity through its generated search.
    const vendorsIndex = artifact("vendors.index.tsx");
    expect(vendorsIndex).toContain(
      'createFileRoute("/_authenticated/vendors/")({',
    );
    expect(vendorsIndex).toContain(
      "validateSearch: entitySearch.vendor.schema",
    );
    expect(vendorsIndex).toContain('captureRequest("vendor")');
    // The image list is not a kernel list, so its index route stays hand-written.
    expect(
      artifacts.some(({ relativePath }) =>
        relativePath.endsWith("images.index.tsx"),
      ),
    ).toBe(false);
    expect(artifact("images.$shortcode.tsx")).toContain("imageDetailQuery(");
    expect(artifact("vendors.$shortcode.tsx")).toContain(
      "title: (record) => record.name",
    );
    expect(artifact("entity-routes.gen.ts")).toContain(
      'product:{basePath:"products",routes:{detail:"/products/$shortcode",list:"/products",create:"page",new:"/products/new"}}',
    );
    // Field schemas are read off the declaration BY KEY at load time — never
    // by a positional `definition.model.fields[N]` that a mid-roster insert
    // would shift.
    expect(artifact("entity-field-schemas.ingredient.gen.ts")).toContain(
      "= fieldSchemasOf(definition);",
    );
    expect(artifact("entity-field-schemas.ingredient.gen.ts")).not.toContain(
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
    // Declared ranges carry their numeric constraints and MCP prose through
    // the shared min/max and from/to builders.
    const expenseFilters = artifact("entity-field-schemas.expense.gen.ts");
    expect(expenseFilters).toContain(
      '...numericRangeFields("cost",{describe:{min:"Inclusive lower bound on expense cost, in dollars",max:"Inclusive upper bound on expense cost, in dollars"}})',
    );
    expect(expenseFilters).toContain(
      '...dateRangeFields("date",{describe:{from:"Inclusive lower bound on expense date",to:"Inclusive upper bound on expense date"}})',
    );
    expect(
      artifact("entity-field-schemas.financialTransaction.gen.ts"),
    ).toContain('...numericRangeFields("amount",{finite:true})');
    expect(artifact("entity-field-model.gen.ts")).not.toContain("validation:");
    expect(artifact("entity-field-model.gen.ts")).not.toMatch(
      /^import .*entity-definitions\//m,
    );
    expect(artifact("entity-details.gen.ts")).not.toContain("~/server/");
    expect(artifact("entity-filter-bindings.gen.ts")).toContain(
      'columnId:"related:product.tasks"',
    );
    expect(artifact("shortcode-registry.gen.ts")).not.toContain("LEGACY");
    expect(artifact("entity-details.gen.ts")).toContain(
      '"product": withEntityDetailMedia(productWithFoodOut)',
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
    const entityColumns = artifact("entity-columns.gen.ts");
    expect(entityColumns).toContain(
      '"agentHints":jsonb("agentHints").notNull().default(sql`\'{"ordersListUrl":null,"pagination":null,"orderLinkPattern":null,"notes":[]}\'::jsonb`)',
    );
    expect(entityColumns).toContain(
      '"cursor":jsonb("cursor").notNull().default(sql`\'{"newestOrderAt":null,"orderIdsOnNewestDate":[],"backfillBeforeOrderAt":null,"earliestAvailableOrderAt":null}\'::jsonb`)',
    );
    expect(entityColumns).toContain(".$type<VendorAccountId>()");
    expect(artifact("EntityCatalog.swift")).toContain("import CubbyAPISupport");
    // Icons emit both the SF Symbol and its emoji text fallback (definition.ts
    // `icons.emoji`) onto the same generated EntityDescriptor.
    expect(artifact("EntityCatalog.swift")).toContain(
      'sfSymbol: "text.badge.plus"',
    );
    expect(artifact("EntityCatalog.swift")).toContain('emoji: "📓"');
    const swiftEntityKey = artifact("EntityKey.swift");
    expect(swiftEntityKey).toContain("public enum EntityKey");
    const entityKeyBody = swiftEntityKey
      .split("public enum EntityKey")[1]!
      .split("\n}\n")[0]!;
    const rawValues = [
      ...entityKeyBody.matchAll(/^ {2}case \w+ = "([^"]*)"/gmu),
    ].map((match) => match[1]!);
    expect(new Set(rawValues)).toEqual(
      new Set(entities.map((entity) => entity.key)),
    );
    // Regression guard for the Swift enum emitter (image-policy.ts): manifest
    // vocabularies must render as typed enum cases, not raw string literals.
    const photoImportCatalog = artifact("PhotoImportCatalog.swift");
    expect(photoImportCatalog).toContain("public enum PhotoIngressRouteKind");
    expect(photoImportCatalog).toContain("public enum PhotoBindingSource");
    expect(photoImportCatalog).toMatch(/kind: \.createRelated/);
    expect(photoImportCatalog).toMatch(/source: \.captureDate/);
    // The manifest's plants category names its two garden-adjacent routing
    // entities; a typo in either mapping (B1) would silently drop a member.
    expect(photoImportCatalog).toMatch(
      /PhotoCategory\(key: "plants", .*entities: \[\.planting, \.gardenEntry\]\)/,
    );
  });
});

describe("photo categories (B1)", () => {
  const routing: NonNullable<
    EntityDeclaration["capabilities"]["images"]["routing"]
  > = {
    candidateFields: ["name"],
    temporalFields: [],
    lifecycleFilters: [],
    signals: { ocrFields: ["name"], classifierLabels: ["alpha"] },
    abstention: { minimumScore: 0.7, minimumMargin: 0.1 },
    category: "food",
  };
  // `category: unknown` (not `EntityDeclaration`-shaped) on purpose: a present-but-undefined
  // key and a missing key parse identically here, so this also covers the "field omitted
  // entirely" declaration shape without needing a second, statically-rejected fixture —
  // exercised through `compileEntityDeclarations`'s `readonly unknown[]` parameter.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- exercises compileEntityDeclarations's readonly unknown[] boundary with an invalid wire value
  const withCategory = (category: unknown) => ({
    ...base,
    model,
    capabilities: {
      ...base.capabilities,
      images: {
        storage: false as const,
        ingress: [],
        routing: { ...routing, category },
      },
    },
  });

  it("requires a category on every routing-policy entity, naming the entity", () => {
    expect(() => compileEntityDeclarations([withCategory(undefined)])).toThrow(
      "alpha.capabilities.images.routing.category is required.",
    );
  });

  it("rejects a category outside the declared photo-category vocabulary", () => {
    expect(() => compileEntityDeclarations([withCategory("vehicles")])).toThrow(
      /category/,
    );
  });

  it("rejects a classifier label declared in two categories' base lists", () => {
    const categories = {
      plants: { classifierLabels: ["leaf", "stem"] },
      garden: { classifierLabels: ["stem", "trowel"] },
    };
    expect(() => validatePhotoCategoryLabels(categories)).toThrow(
      'photoCategories.garden classifierLabel "stem" also appears in photoCategories.plants.',
    );
    expect(() =>
      validatePhotoCategoryLabels({
        plants: { classifierLabels: ["leaf"] },
        garden: { classifierLabels: ["trowel"] },
      }),
    ).not.toThrow();
  });
});
