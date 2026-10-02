import { defineEntity } from "./definition.js";
import { cookbookProductSummary } from "@cubby/schemas/cookbook-fields";
import { cookbookShortcode } from "../identifier-fields.js";
import { imageOut } from "./field-primitives.js";
import { z } from "zod";
export default defineEntity({
  key: "cookbook",
  names: { singular: "Cookbook", plural: "Cookbooks" },
  route: {
    basePath: "cookbooks",
    // No kernel `get`: the detail reads the cookbook summary query.
    detailOverride: {
      query: {
        module: "~/entity/cookbook-queries",
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
        control: { kind: "text", placeholder: "Cookbook title" },
        display: { list: true, detail: true },
        validation: {
          read: z.string(),
          create: null,
          update: z.string().trim().min(1).optional(),
        },
      },
      {
        key: "author",
        kind: "text-array",
        control: { kind: "specialized", renderer: "tag-list" },
        display: { list: true, detail: true },
        validation: {
          read: z.array(z.string()),
          create: null,
          update: z.array(z.string().trim().min(1)).optional(),
        },
      },
      {
        key: "subjects",
        kind: "text-array",
        control: { kind: "specialized", renderer: "tag-list" },
        display: { list: true, detail: true },
        validation: {
          read: z.array(z.string()),
          create: null,
          update: z.array(z.string().trim().min(1)).optional(),
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
        // The list shows the cover as the standard image column (`images`).
        display: { detail: true },
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
        key: "images",
        kind: "json",
        display: { list: true, standard: "image" },
        provenance: {
          kind: "derived",
          sources: [{ entity: "image", relation: "cover" }],
        },
        validation: { read: z.array(imageOut), create: null, update: null },
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
      { key: "productId", reference: "product" },
      { key: "importedAt", defaultOverride: "now" },
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [],
    update: ["name", "author", "subjects"],
    bulk: [],
    audit: ["name", "author", "subjects"],
    sort: {
      fields: ["name", "recipeCount", "createdAt", "updatedAt"],
      computed: ["recipeCount"],
      // A shelf reads alphabetically, not by import date.
      defaultOverride: "name",
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
    update: {
      module: "@cubby/schemas/recipe",
      export: "cookbookUpdateInput",
    },
    output: { module: "@cubby/schemas/recipe", export: "cookbookSummary" },
    list: { module: "@cubby/schemas/recipe", export: "cookbookSummary" },
    detail: { module: "@cubby/schemas/recipe", export: "cookbookSummary" },
  },
  // The book a set of EPUB-extracted recipes came from. Holds the full
  // assembled `ImportRecipe[]` JSON so recipes can be re-derived without
  // re-running the LLM; a cookbook is always born from a full import, so
  // every content column is NOT NULL. `productId` links it to the physical
  // book on the shelf. Matching is always human-confirmed — never auto-link on
  // a title prefix: two books can share a leading title word and differ.
  storage: {
    indexes: [
      { on: ["name"], unique: true, where: "{deletedAt} IS NULL" },
      { on: ["createdAt"] },
      { trigram: "name" },
    ],
    relations: {
      recipes: { many: "recipe" },
      attachments: { many: "entityAttachment" },
      product: "productId",
    },
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
          { edge: "EntityAttachment.entityId", direction: "incoming" },
          { edge: "EntityAttachment.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "EntityAttachment.imageId", direction: "incoming" },
          { edge: "EntityAttachment.entityId", direction: "outgoing" },
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
    // Born only from an EPUB import and deleted with its recipes by that
    // import workflow; the kernel serves reads and title/author/subject edits.
    mcp: ["get", "list", "update"],
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
      repository: {
        module: "~/server/repo/cookbook.repository",
        export: "cookbookRepository",
      },
      search: "document",
    },
  },
});
