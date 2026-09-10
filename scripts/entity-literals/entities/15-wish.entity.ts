import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "wish",
  names: { singular: "Wish", plural: "Wishlist" },
  route: { basePath: "wishes" },
  table: "Wish",
  identifiers: { brand: "WishId", shortcode: "WSH-", legacy: null },
  presentation: { titleField: "name" },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text" },
        display: { list: true, detail: true, standard: "name" },
        validation: {
          kind: "string",
          trim: true,
          min: 1,
          max: 200,
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        control: { kind: "textarea" },
        display: { list: true, detail: true },
        validation: {
          kind: "string",
          nullable: true,
          read: true,
          create: { defaultValue: null },
          update: true,
        },
      },
      {
        key: "candidateProductIds",
        kind: "identifier",
        label: "Candidate Product IDs",
        readKey: null,
        reference: { entity: "product", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        validation: {
          kind: "array",
          item: {
            kind: "source",
            source: {
              module: "@cubby/schemas/identifiers",
              export: "productShortcode",
            },
          },
          create: { defaultValue: [] },
          update: true,
        },
      },
      {
        key: "acquired",
        kind: "boolean",
        readKey: null,
        control: { kind: "checkbox", section: "details" },
        validation: { update: { kind: "boolean" } },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: {
            kind: "source",
            source: {
              module: "@cubby/schemas/identifiers",
              export: "wishShortcode",
            },
          },
        },
      },
      {
        key: "acquiredAt",
        kind: "timestamp",
        nullable: true,
        display: { list: true, detail: true },
        validation: { read: { kind: "timestamp", nullable: true } },
      },
      {
        key: "candidates",
        kind: "json",
        validation: {
          read: {
            kind: "array",
            item: {
              kind: "source",
              source: {
                module: "@cubby/schemas/wish-fields",
                export: "wishCandidateOut",
              },
            },
          },
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { detail: true },
        validation: { read: { kind: "timestamp" } },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { detail: true },
        validation: { read: { kind: "timestamp" } },
      },
      { key: "shortcode", kind: "text", readKey: null },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
    ],
    storage: [
      { key: "id", default: "generated", specialized: "primary-key:WishId" },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      "notes",
      "acquiredAt",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: ["name", "notes", "candidateProductIds"],
    update: ["name", "notes", "candidateProductIds", "acquired"],
    bulk: [],
    audit: ["name", "notes", "acquiredAt", "candidateProductIds"],
    output: [
      "id",
      "name",
      "notes",
      "acquiredAt",
      "candidates",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: { module: "@cubby/schemas/wish", export: "wishCreateInput" },
    update: { module: "@cubby/schemas/wish", export: "wishUpdateData" },
    output: { module: "@cubby/schemas/wish", export: "wishOut" },
  },
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/wish", export: "wishFilterFields" },
    descriptors: [
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search wishlist...",
        deriveSchema: true,
        schemaFromRead: true,
      },
      {
        columnId: "acquired",
        kind: "boolean",
        placeholder: "Filter by status...",
        deriveSchema: true,
        options: [
          { value: "false", label: "Wanted" },
          { value: "true", label: "Acquired" },
        ],
      },
      {
        columnId: "related:wish.candidates",
        field: "candidateProductId",
        urlKey: "related-product",
        kind: "idMulti",
        placeholder: "Filter by candidate product...",
        optionsKey: "wishCandidates",
        nullable: { field: "productPresenceFilter", label: "candidate" },
      },
      {
        columnId: "productId",
        kind: "idMulti",
        placeholder: "Filter by candidate product id...",
        urlOnly: true,
      },
      {
        columnId: "productPresenceFilter",
        kind: "presence",
        placeholder: "Filter candidate presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "candidates",
      label: "Tool candidates",
      target: "product",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "WishCandidate.wishId", direction: "incoming" },
          { edge: "WishCandidate.productId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "WishCandidate.productId", direction: "incoming" },
          { edge: "WishCandidate.wishId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: false,
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "search", "create", "update", "delete"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: { plural: "wishes" },
    ports: {
      repository: {
        module: "~/server/repo/wish.entity-adapter",
        export: "wishEntityAdapter",
      },
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
