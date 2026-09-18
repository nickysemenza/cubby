import { defineEntity } from "./definition.js";
import { cookbookProductSummary } from "@cubby/schemas/cookbook-fields";
import { cookbookShortcode } from "../identifier-fields.js";
import { z } from "zod";
export default defineEntity({
  key: "cookbook",
  names: { singular: "Cookbook", plural: "Cookbooks" },
  route: {
    basePath: "cookbooks",
    list: true,
    // No kernel `get`: the detail reads the cookbook summary query.
    detail: {
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
    icons: { lucide: "BookOpen", sfSymbol: "book.closed", emoji: "📖" },
    detail: {
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Overview",
          placement: "supporting",
          fields: [
            "name",
            "author",
            "subjects",
            "recipeCount",
            "sourceRecipeCount",
            "needsReextract",
            "coverUrl",
          ],
        },
        {
          kind: "fields",
          id: "physical-copy",
          title: "Physical copy",
          placement: "supporting",
          fields: ["product"],
        },
        { kind: "slot", id: "toc", title: "Contents" },
        {
          kind: "relation",
          id: "recipes",
          title: "Recipes",
          relation: "recipes",
          filter: { descriptor: "source" },
          columns: ["name", "tags", "costTotal"],
        },
        { kind: "slot", id: "import-progress", title: "Import" },
      ],
    },
    list: { links: [{ label: "Import", path: "/recipes/import" }] },
  },
  model: {
    fields: [
      { key: "id", kind: "identifier", readKey: null },
      {
        key: "shortcode",
        kind: "text",
        readKey: "id",
        validation: {
          read: cookbookShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "name",
        kind: "text",
        readKey: "book",
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
      { key: "sourceLabel", kind: "text", readKey: null },
      { key: "rawJson", kind: "json", readKey: null },
      { key: "report", kind: "json", nullable: true, readKey: null },
      {
        key: "coverImageId",
        kind: "identifier",
        nullable: true,
        label: "Cover Image ID",
        readKey: null,
        reference: { entity: "image" },
      },
      {
        key: "productId",
        kind: "identifier",
        nullable: true,
        label: "Product ID",
        readKey: null,
        reference: { entity: "product" },
      },
      { key: "importedAt", kind: "timestamp", readKey: null },
      { key: "createdAt", kind: "timestamp", readKey: null },
      { key: "updatedAt", kind: "timestamp", readKey: null },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
      {
        key: "recipeCount",
        kind: "number",
        label: "Recipes",
        display: { list: true, detail: true },
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
        label: "Cover",
        display: { list: true, detail: true },
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "sourceRecipeCount",
        kind: "number",
        label: "Source recipes",
        display: { detail: true },
        validation: {
          read: z.number().int().min(0),
          create: null,
          update: null,
        },
      },
      {
        key: "needsReextract",
        kind: "boolean",
        label: "Needs re-extraction",
        display: { detail: true },
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
        label: "Physical copy",
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
        default: "generated",
        specialized: "primary-key:CookbookId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      {
        key: "author",
        default: "literal",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      {
        key: "subjects",
        default: "literal",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      "sourceLabel",
      { key: "rawJson", specialized: "json:rawJson" },
      { key: "report", specialized: "json:report" },
      // Stored at upsert (recipe items in the tree), so browse and problem
      // detection never walk the JSON.
      { key: "sourceRecipeCount", default: "literal", defaultValue: 0 },
      { key: "coverImageId", reference: "image" },
      { key: "productId", reference: "product" },
      { key: "importedAt", default: "now" },
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [],
    update: [],
    bulk: [],
    audit: [],
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
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Cookbook.coverImageId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Cookbook.coverImageId", direction: "incoming" }],
      },
    },
    {
      key: "product",
      label: "Product",
      target: "product",
      cardinality: "one",
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
      displaySources: [
        {
          relationPath: ["product"],
          priority: 1,
          ordering: "declared",
          identityEvidence: false,
        },
      ],
      ingress: [{ kind: "self", routeId: "cookbook-cover" }],
      routing: {
        candidateFields: [],
        temporalFields: [],
        lifecycleFilters: [],
        signals: { ocrFields: [], classifierLabels: ["cookbook", "cover"] },
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
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: null,
      references: {
        label: { module: "~/entities/entities", export: "entityLabel" },
        resolver: {
          module: "~/server/repo/shortcode-resolver",
          export: "resolveLiveShortcode",
        },
      },
      filters: {
        module: "~/entities/filter-manifest",
        export: "getEntityFilters",
      },
      search: {
        projection: {
          module: "~/server/repo/search-document",
          export: "refreshSearchDocument",
        },
        semanticText: {
          module: "~/server/repo/search-document",
          export: "getSearchDocumentEmbeddingText",
        },
        dependentRefresh: {
          module: "~/server/services/mutation-side-effects",
          export: "runMutationSideEffects",
        },
      },
    },
  },
});
