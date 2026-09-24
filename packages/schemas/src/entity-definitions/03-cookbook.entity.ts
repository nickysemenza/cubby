import { defineEntity } from "./definition.js";
import { cookbookProductSummary } from "@cubby/schemas/cookbook-fields";
import { cookbookShortcode } from "../identifier-fields.js";
import { z } from "zod";
export default defineEntity({
  key: "cookbook",
  names: { singular: "Cookbook", plural: "Cookbooks" },
  route: {
    basePath: "cookbooks",
    // No kernel `get`: the detail reads the cookbook summary query.
    detailOverride: {
      query: {
        module: "~/entities/cookbook.functions",
        export: "cookbookDetailQuery",
      },
    },
  },
  table: "Cookbook",
  identifiers: { brand: "CookbookId", shortcode: "CKB-" },
  presentation: {
    titleField: "book",
    domain: "cook",
    description: "Imported and maintained recipe collections.",
    emptyState: {
      title: "No cookbooks yet",
      description:
        "Drag an EPUB cookbook into the Recipes import page and Cubby will extract its recipes.",
    },
    icons: { phosphor: "BookOpen", sfSymbol: "book.closed", emoji: "📖" },
    detail: {
      additionalSectionOverrides: [
        {
          kind: "fields",
          id: "physical-copy",
          title: "Physical copy",
          placement: "supporting",
          fields: ["product"],
        },
        { kind: "slot", id: "toc", title: "Contents" },
        { kind: "slot", id: "import-progress", title: "Import" },
      ],
    },
    // The client-paged cookbook list has no generic row delete action.
    list: {
      actionOverrides: [],
      links: [{ label: "Import", path: "/recipes/import" }],
    },
  },
  model: {
    fields: [
      { key: "id", kind: "identifier" },
      {
        key: "shortcode",
        kind: "text",
        readKeyOverride: "id",
        validation: {
          read: cookbookShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "name",
        kind: "text",
        readKeyOverride: "book",
        display: { list: true, detail: true },
        validation: {
          read: z.string(),
          create: null,
          update: null,
        },
      },
      {
        key: "author",
        kind: "text-array",
        display: { list: true, detail: true },
        validation: {
          read: z.array(z.string()),
          create: null,
          update: null,
        },
      },
      {
        key: "subjects",
        kind: "text-array",
        display: { list: true, detail: true },
        validation: {
          read: z.array(z.string()),
          create: null,
          update: null,
        },
      },
      { key: "sourceLabel", kind: "text" },
      { key: "rawJson", kind: "json" },
      { key: "report", kind: "json", nullable: true },
      {
        key: "productId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "product" },
      },
      { key: "importedAt", kind: "timestamp" },
      { key: "createdAt", kind: "timestamp" },
      { key: "updatedAt", kind: "timestamp" },
      {
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
      },
      {
        key: "recipeCount",
        kind: "number",
        display: { list: true, detail: true },
        provenance: {
          kind: "derived",
          sources: [{ entity: "recipe", relation: "recipes" }],
        },
        explanation: {
          ruleId: "cookbook.recipe-count",
          description:
            "Recipe count is the number of live recipes imported from this cookbook.",
          readPath: "recipeCount",
        },
        validation: {
          read: z.number().int().min(0),
          create: null,
          update: null,
        },
      },
      {
        key: "coverUrl",
        kind: "text",
        nullable: true,
        display: { list: true, detail: true },
        provenance: {
          kind: "derived",
          sources: [{ entity: "image", relation: "cover" }],
        },
        explanation: {
          ruleId: "cookbook.cover",
          description:
            "The cover uses the cookbook's current cover image attachment when one is available.",
          readPath: "coverUrl",
          sourceDependencies: [
            { path: "displayImages", label: "Selected cookbook cover" },
          ],
        },
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "sourceRecipeCount",
        kind: "number",
        display: { detail: true },
        provenance: {
          kind: "derived",
          sources: [{ label: "Imported cookbook source" }],
        },
        explanation: {
          ruleId: "cookbook.source-recipe-count",
          description:
            "Source recipes counts recipe entries present in the cookbook's imported source data.",
          readPath: "sourceRecipeCount",
        },
        validation: {
          read: z.number().int().min(0),
          create: null,
          update: null,
        },
      },
      {
        key: "needsReextract",
        kind: "boolean",
        display: { detail: true },
        provenance: {
          kind: "derived",
          sources: [{ label: "Imported cookbook source format" }],
        },
        explanation: {
          ruleId: "cookbook.needs-reextract",
          description:
            "A cookbook needs re-extraction when its stored import payload uses the legacy shape.",
          readPath: "needsReextract",
          sourceDependencies: [
            { path: "sourceRecipeCount", label: "Source recipe count" },
          ],
        },
        validation: {
          read: z.boolean(),
          create: null,
          update: null,
        },
      },
      {
        key: "product",
        kind: "json",
        nullable: true,
        reference: { entity: "product" },
        display: { list: true, detail: true },
        validation: {
          read: cookbookProductSummary.nullable(),
          create: null,
          update: null,
        },
      },
    ],
    storage: [
      {
        key: "id",
        specialized: "primary-key:CookbookId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      {
        key: "author",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      {
        key: "subjects",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      "sourceLabel",
      { key: "rawJson", specialized: "json:rawJson" },
      { key: "report", specialized: "json:report" },
      // Stored at upsert (recipe items in the tree), so browse and problem
      // detection never walk the JSON.
      { key: "sourceRecipeCount", defaultValue: 0 },
      { key: "productId", reference: "product" },
      { key: "importedAt", defaultOverride: "now" },
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [],
    update: [],
    bulk: [],
    audit: [],
    sort: {
      fields: ["name", "recipeCount", "createdAt", "updatedAt"],
      computed: ["recipeCount"],
    },
    output: [
      "shortcode",
      "name",
      "author",
      "subjects",
      "recipeCount",
      "coverUrl",
      "sourceRecipeCount",
      "needsReextract",
      "product",
    ],
  },
  fields: {
    create: null,
    update: null,
    output: { module: "@cubby/schemas/recipe", export: "cookbookSummary" },
    list: { module: "@cubby/schemas/recipe", export: "cookbookSummary" },
    detail: { module: "@cubby/schemas/recipe", export: "cookbookSummary" },
  },
  filters: { descriptors: [] },
  relations: [
    {
      key: "recipes",
      label: "Recipes",
      target: "recipe",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Recipe.cookbookId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Recipe.cookbookId", direction: "outgoing" }],
      },
    },
    {
      key: "cover",
      label: "Cover image",
      target: "image",
      cardinality: "one",
      inverseOmit:
        "The image's associations slot lists what uses it, cookbook covers included.",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "EntityAttachment.subjectEntityId", direction: "incoming" },
          { edge: "EntityAttachment.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "EntityAttachment.imageId", direction: "incoming" },
          { edge: "EntityAttachment.subjectEntityId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "product",
      label: "Product",
      target: "product",
      cardinality: "one",
      inverseOmit:
        "The product page's cookbooks slot already lists the cookbooks this product is.",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Cookbook.productId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Cookbook.productId", direction: "incoming" }],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: {
      storage: "cover",
      displaySourceOverrides: [
        {
          relationPath: ["product"],
          priority: 1,
          ordering: "declared",
          identityEvidence: false,
        },
      ],
      ingress: [
        { kind: "self", routeId: "cookbook-cover" },
        {
          kind: "createSelf",
          routeId: "cookbook-new",
          enabled: false,
          disabledReason:
            "Cookbooks need a title and source first; create one in Cookbooks before attaching a cover",
        },
      ],
      routing: {
        category: "documents",
        candidateFields: [],
        temporalFields: [],
        lifecycleFilters: [],
        signals: { ocrFields: [], classifierLabels: ["book"] },
        abstention: { minimumScore: 0.82, minimumMargin: 0.18 },
      },
    },
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: false },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "workflow", merge: null },
    mcp: ["list"],
    dataQuality: {
      checks: [
        {
          id: "cookbook_import_incomplete",
          facet: "integrity",
          kind: "defect",
          weight: 2,
          label: "Import incomplete",
          message:
            "Fewer recipes are imported than the source cookbook contains.",
        },
        {
          id: "cookbook_cover",
          facet: "provenance",
          weight: 1,
          label: "Cover image",
          message: "No cover image is recorded.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: null,
      search: "document",
    },
  },
});
