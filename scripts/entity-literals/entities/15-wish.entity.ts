import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "wish",
  names: { singular: "Wish", plural: "Wishlist" },
  route: { basePath: "wishes" },
  table: "Wish",
  identifiers: { brand: "WishId", shortcode: "WSH-", legacy: null },
  presentation: { titleField: "name" },
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
      },
      {
        columnId: "acquired",
        kind: "boolean",
        placeholder: "Filter by status...",
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
