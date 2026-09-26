import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  defineEntity,
  parseEntityDeclarationMetadata,
  parseEntityFieldModelMetadata,
  readFieldSchemas,
} from "../../../packages/schemas/src/entity-definitions/definition";
import type { EntityDeclaration } from "../../../packages/schemas/src/entity-definitions/definition";
import {
  generatedHeader,
  removeExtraArtifacts,
} from "../../../scripts/generator/artifacts";
import {
  collectEntityOverrides,
  compileEntityDeclarations,
  validatePhotoCategoryLabels,
} from "../../../scripts/generator/entities/compile";
import { loadEntityDeclarations } from "../../../scripts/generator/entities/declarations";
import { deriveImageDisplaySources } from "../../../scripts/generator/entities/derive";
import { renderEntityArtifacts } from "../../../scripts/generator/entities/render/index";
import { renderImagePolicyArtifacts } from "../../../scripts/generator/entities/render/image-policy";
import {
  generatedBrowserRouteFiles,
  handWrittenBrowserRouteFiles,
  missingBrowserRouteFiles,
  missingListSources,
} from "../../../scripts/generator/entities/render/routes";

const temporaryRoots: string[] = [];

it("catalogs every named declaration override with keyed paths and preserves opt-outs", () => {
  expect(
    collectEntityOverrides({
      model: {
        fields: [
          { key: "name", labelOverride: "Display name" },
          { key: "image", display: { listOrderOverride: 0 } },
        ],
      },
      route: { detailOverride: null },
      presentation: { detail: { sectionOverrides: [{ id: "facts" }] } },
    }),
  ).toEqual([
    { path: "model.fields[name].labelOverride", value: '"Display name"' },
    { path: "model.fields[image].display.listOrderOverride", value: "0" },
    { path: "route.detailOverride", value: "null" },
    {
      path: "presentation.detail.sectionOverrides",
      value: '[{"id":"facts"}]',
    },
  ]);
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

const presentation = {
  titleField: "name",
  domain: null,
  description: "Alpha records.",
  emptyState: { title: "No alphas", description: "Add one." },
  icons: { phosphor: "Cube", sfSymbol: "cube", emoji: "🧊" },
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

  it("ranks singular subject images and preserves an explicit opt-out", () => {
    const subject = {
      key: "subject",
      capabilities: { images: { storage: "gallery" } },
      relations: [],
    };
    const image = {
      key: "image",
      capabilities: { images: { storage: false } },
      relations: [],
    };
    const sighting = {
      key: "sighting",
      capabilities: { images: { storage: false } },
      relations: [
        {
          key: "subject",
          target: "subject",
          cardinality: "one",
          provenance: {
            kind: "local-path",
            steps: [{ edge: "Sighting.subjectId", direction: "outgoing" }],
          },
        },
        {
          key: "activity",
          target: "subject",
          cardinality: "many",
          provenance: {
            kind: "local-path",
            steps: [{ edge: "Activity.sightingId", direction: "incoming" }],
          },
        },
        {
          key: "image",
          target: "image",
          cardinality: "one",
          provenance: {
            kind: "local-path",
            steps: [{ edge: "Sighting.imageId", direction: "outgoing" }],
          },
        },
      ],
    };
    const declarations = [sighting, subject, image];
    expect(deriveImageDisplaySources(declarations)[0]).toMatchObject({
      capabilities: {
        images: {
          displaySourceOverrides: [
            { relationPath: ["image"], priority: 0 },
            { relationPath: ["subject"], priority: 1 },
          ],
        },
      },
    });
    const optedOut = {
      ...sighting,
      capabilities: { images: { storage: false, displaySourceOverrides: [] } },
    };
    expect(deriveImageDisplaySources([optedOut, subject, image])[0]).toBe(
      optedOut,
    );
  });

  it("preserves literal model keys through the inferred declaration contract", () => {
    const definition = defineEntity({
      ...base,
      model: {
        fields: [
          {
            key: "displayName",
            kind: "text",
            readKeyOverride: "display_name",
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
      display_name: z.ZodString;
    }>();
    expect(Object.keys(readFieldSchemas(definition))).toEqual(["display_name"]);
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

  it.each([
    [{ nullable: null }, "nullable must be a boolean"],
    [{ labelOverride: null }, "labelOverride must be a non-empty string"],
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
              labelOverride: "Title",
              readKeyOverride: null,
              nullable: true,
            },
          ],
          storage: [
            {
              key: "name",
              columnOverride: "title",
              nullableOverride: false,
              defaultOverride: "literal",
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
            computed: ["related:example.count"],
            groupable: ["name"],
          },
        },
      },
    ])[0]!;
    expect(entity.fieldModel.sort).toEqual({
      fields: ["name", "related:example.count"],
      default: "name",
      direction: "asc",
      computed: ["related:example.count"],
      groupable: ["name"],
    });
  });

  it("defaults an absent sort declaration to null", () => {
    const entity = compileEntityDeclarations([{ ...base, model }])[0]!;
    expect(entity.fieldModel.sort).toBeNull();
  });

  it("derives a detail overview from readable fields unless sections are opted out", () => {
    const displayed = {
      ...base,
      model: {
        ...model,
        fields: [{ ...model.fields[0]!, display: { detail: true } }],
      },
    };
    expect(
      compileEntityDeclarations([displayed])[0]?.inspector.detail.sections,
    ).toEqual([
      {
        kind: "fields",
        id: "overview",
        title: "Details",
        placement: "supporting",
        collapsed: false,
        fields: ["name"],
      },
    ]);
    expect(
      compileEntityDeclarations([
        {
          ...displayed,
          presentation: { ...presentation, detail: { sectionOverrides: [] } },
        },
      ])[0]?.inspector.detail.sections,
    ).toEqual([]);
  });

  it.each([
    [
      { fields: ["missing"], defaultOverride: "missing" },
      "references undeclared field missing",
    ],
    [
      { fields: ["name"], defaultOverride: "missing" },
      "default missing must be one of sort.fields",
    ],
    [
      { fields: ["name"], defaultOverride: "name", computed: ["missing"] },
      "computed missing must be one of sort.fields",
    ],
    [
      { fields: ["name"], defaultOverride: "name", groupable: ["missing"] },
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
              { ...model.fields[0], readKeyOverride: readKey },
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
          fields: [{ ...model.fields[0], readKeyOverride: null }],
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
              {
                key: "name",
                kind: "text",
                display: { list: true, listOrderOverride: listOrder },
              },
            ],
          },
        },
      ])[0]?.fieldModel.fields[0]?.display.listOrder;
    expect(withListOrder(2)).toBe(2);
    expect(withListOrder(undefined)).toBe(0);
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
      {
        key: "parentId",
        kind: "identifier",
        labelOverride: "Parent",
        reference: { entity: "alpha" },
      },
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
            storage: [
              "name",
              "tags",
              "flag",
              "at",
              "amount",
              { key: "parentId", reference: "alpha" },
            ],
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
    expect(
      stored({
        columnId: "parentId",
        kind: "idMulti",
        brandRef: { entity: "alpha" },
      }),
    ).toEqual({ columns: ["parentId"], array: false });
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
      [
        { columnId: "name", kind: "id", brandRef: { entity: "alpha" } },
        "stored id filter needs a foreign-key field",
      ],
      [
        {
          columnId: "parentId",
          kind: "idMulti",
          brandRef: { entity: "device" },
        },
        "brandRef must name the entity its field references",
      ],
    ];
    for (const [descriptor, message] of rejected)
      expect(() => stored(descriptor)).toThrow(message);
  });

  // Regression: Run's purpose filter was a hand copy of the field's options.
  // The enum gained AI purposes, the copy did not, and every AI Run was
  // unreachable from the Runs list filter and its URL schema.
  it("derives enum filter options from the field and rejects a stale copy", () => {
    const status = {
      key: "status",
      kind: "enum",
      control: {
        kind: "select",
        options: [
          { value: "open", label: "Open" },
          { value: "done", label: "Done" },
        ],
      },
      validation: {
        read: z.enum(["open", "done"]),
        create: null,
        update: null,
      },
    };
    const compile = (options: Array<{ value: string; label: string }> | null) =>
      compileEntityDeclarations([
        {
          ...base,
          model: {
            ...model,
            fields: [...model.fields, status],
            storage: ["name", "status"],
          },
          filters: {
            descriptors: [
              {
                columnId: "status",
                kind: "multiselect",
                placeholder: "x",
                options,
              },
            ],
          },
        },
      ])[0]?.filterDescriptors[0]?.options;
    expect(compile(null)).toEqual([
      { value: "open", label: "Open" },
      { value: "done", label: "Done" },
    ]);
    expect(() => compile([{ value: "open", label: "Open" }])).toThrow(
      "options must match status's control options",
    );
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
        sectionOverrides: [
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
            sectionOverrides: [
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
        { detail: { sectionOverrides: [{ kind: "slot", id: "history" }] } },
        "reserved id",
      ],
      [
        "a relation section over a to-one relation",
        {
          detail: {
            sectionOverrides: [
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
        { list: { viewOverrides: ["table", "timeline"] } },
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

  // The native editor renders only the fields a declared `edit.sections`
  // lists, so a controlled roster field left out of every section would
  // silently vanish there — the compiler refuses the declaration instead.
  it("requires declared edit sections to place every controlled roster field", () => {
    const sectioned = (fields: readonly string[]) =>
      compileEntityDeclarations([
        {
          ...base,
          model: {
            ...model,
            fields: [
              {
                key: "name",
                kind: "text",
                control: { kind: "text" },
                validation: {
                  read: z.string(),
                  create: z.string().trim().min(1),
                  update: z.string().trim().min(1).optional(),
                },
              },
              {
                key: "notes",
                kind: "text",
                nullable: true,
                control: { kind: "textarea" },
                validation: {
                  read: z.string().nullable(),
                  create: z.string().nullable().optional(),
                  update: z.string().nullable().optional(),
                },
              },
              {
                key: "pendingImageIds",
                kind: "text",
                readKeyOverride: null,
                control: { kind: "text" },
                provenance: {
                  kind: "relation",
                  sources: [{ label: "Images" }],
                },
                validation: {
                  read: null,
                  create: z.array(z.string()).optional(),
                  update: z.array(z.string()).optional(),
                },
              },
            ],
            storage: ["name", "notes"],
            create: ["name", "notes", "pendingImageIds"],
            update: ["name", "notes", "pendingImageIds"],
            output: ["name", "notes"],
          },
          presentation: {
            ...base.presentation,
            edit: {
              sectionOverrides: [
                { id: "identity", title: "Identity", fields: [...fields] },
              ],
            },
          },
        },
      ]);
    expect(() => sectioned(["name"])).toThrow(
      "edit.sections leave controlled roster fields unplaced (the native editor drops them): notes",
    );
    // The image block owns `pendingImageIds`; it never needs a section.
    expect(sectioned(["name", "notes"])[0]?.inspector.edit.sections).toEqual([
      {
        id: "identity",
        title: "Identity",
        fields: ["name", "notes"],
        collapsed: false,
      },
    ]);
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
            viewOverrides: ["table", "shelf"],
            shelfSubtitleOverride: ["name"],
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
    expect(
      parseEntityDeclarationMetadata(
        { ...base, route: { basePath: "alphas" } },
        "alpha",
      ).route,
    ).toMatchObject({ list: true, detail: true });
    const routeReady = {
      ...base,
      model: {
        ...model,
        intents: {
          fields: { capture: ["name"] },
          create: ["capture"],
          update: ["capture"],
        },
      },
      fields: {
        create: { module: "~/entities/alpha", export: "alphaCreate" },
        update: null,
        output: { module: "~/entities/alpha", export: "alphaOut" },
      },
    };
    expect(
      parseEntityDeclarationMetadata(
        { ...routeReady, route: { basePath: "alphas" } },
        "alpha",
      ).route?.create,
    ).toBe("dialog");
    expect(
      parseEntityDeclarationMetadata(
        {
          ...routeReady,
          route: { basePath: "alphas", createOverride: null },
        },
        "alpha",
      ).route?.create,
    ).toBeUndefined();
    const entities = compileEntityDeclarations([
      {
        ...base,
        route: {
          basePath: "alphas",
          detailParamOverride: "id",
          createOverride: "page",
          listOverride: null,
          detailOverride: {
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
        {
          ...base,
          route: {
            basePath: "alphas",
            listOverride: null,
            detailOverride: true,
          },
        },
      ]),
    ).toThrow("no create+update contract");
    const alphaDetail = {
      query: { module: "~/entities/alpha", export: "alphaQuery" },
    };
    expect(() =>
      compileEntityDeclarations([
        {
          ...base,
          route: { basePath: "alphas", detailOverride: alphaDetail },
        },
      ]),
    ).toThrow("has no contract (nothing to list)");
    // Every entity gets the generic detail page; only the allowlisted
    // recipe and usda-food routes stay hand-written.
    expect(() =>
      compileEntityDeclarations([
        {
          ...base,
          route: {
            basePath: "alphas",
            listOverride: null,
            detailOverride: null,
          },
        },
      ]),
    ).toThrow("every entity gets the generic detail page");
    // A dialog-created entity needs a capture intent for the dialog to open.
    expect(() =>
      compileEntityDeclarations([
        {
          ...base,
          route: {
            basePath: "alphas",
            createOverride: "dialog",
            listOverride: null,
            detailOverride: alphaDetail,
          },
        },
      ]),
    ).toThrow('model.intents.create lacks "capture"');
  });

  it("removes only header-carrying files that no artifact claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "cubby-entities-"));
    temporaryRoots.push(root);
    const artifacts = [
      {
        relativePath: "generated/entity-literal-alpha.gen.ts",
        source: `${generatedHeader}export const alpha = 1;\n`,
      },
    ];
    await mkdir(join(root, "generated"));
    await writeFile(
      join(root, "generated/entity-literal-alpha.gen.ts"),
      artifacts[0]!.source,
    );
    // Extraneous detection reads the generator ownership header, not the
    // filename, so a retired artifact name is caught too.
    await writeFile(
      join(root, "generated/entity-retired-name.gen.ts"),
      `${generatedHeader}export const retired = 1;\n`,
    );
    // A file with no generator header is not ours to delete.
    await writeFile(join(root, "generated/notes.gen.ts"), "// just a note\n");
    expect(await removeExtraArtifacts(root, artifacts)).toEqual([
      "generated/entity-retired-name.gen.ts",
    ]);
    expect((await readdir(join(root, "generated"))).sort()).toEqual([
      "entity-literal-alpha.gen.ts",
      "notes.gen.ts",
    ]);
  });

  // Regression: importRun declared `route.list: true` with no create/update
  // contract (so no kernel list read) and no list override, and the
  // generated Runs index crashed on SSR. The generator must refuse that.
  it("requires a list override for a generated index with no kernel list read", async () => {
    const entities = await loadEntityDeclarations();
    expect(missingListSources(entities)).toEqual([]);
    const registry = (await import("node:fs/promises")).readFile(
      new URL("../src/entities/list-columns/index.ts", import.meta.url),
      "utf8",
    );
    const withoutRuns = (await registry).replace(/^\s+importRun:.*$/mu, "");
    expect(missingListSources(entities, withoutRuns)).toEqual(["importRun"]);
  });

  it("keeps generated artifacts on their side of the schema and server boundaries", async () => {
    const entities = await loadEntityDeclarations();
    const artifacts = [
      ...renderEntityArtifacts(entities),
      ...renderImagePolicyArtifacts(entities),
    ];
    const artifact = (suffix: string) =>
      artifacts.find(({ relativePath }) => relativePath.endsWith(suffix))!
        .source;
    // Field schemas are read off the declaration BY KEY at load time — never
    // by a positional `definition.model.fields[N]` that a mid-roster insert
    // would shift.
    const ingredientSchemas = artifact(
      "entity-field-schemas.ingredient.gen.ts",
    );
    expect(ingredientSchemas).toContain("= fieldSchemasOf(definition);");
    expect(ingredientSchemas).not.toContain("definition.model.fields[");
    expect(artifact("entity-field-model.gen.ts")).not.toContain("validation:");
    expect(artifact("entity-field-model.gen.ts")).not.toMatch(
      /^import .*entity-definitions\//m,
    );
    expect(artifact("entity-details.gen.ts")).not.toContain("~/server/");
    // Regression guard for the Swift enum emitter (image-policy.ts): manifest
    // vocabularies must render as typed enum cases, not raw string literals.
    const photoImportCatalog = artifact("PhotoImportCatalog.swift");
    expect(photoImportCatalog).toMatch(/kind: \.createRelated/);
    expect(photoImportCatalog).toMatch(/source: \.captureDate/);
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
