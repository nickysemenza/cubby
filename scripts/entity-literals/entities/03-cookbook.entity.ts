import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "cookbook",
  names: { singular: "Cookbook", plural: "Cookbooks" },
  route: { basePath: "cookbooks" },
  table: "Cookbook",
  identifiers: { brand: "CookbookId", shortcode: "CKB-", legacy: null },
  presentation: { titleField: "title" },
  fields: null,
  filters: { descriptors: [] },
  relations: [
    {
      key: "cover",
      label: "Cover image",
      target: "image",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Cookbook.coverImageId", direction: "outgoing" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "Cookbook.coverImageId", direction: "incoming" }],
      },
    },
    {
      key: "product",
      label: "Product",
      target: "product",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Cookbook.productId", direction: "outgoing" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "Cookbook.productId", direction: "incoming" }],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: true,
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: false },
    bulkUpdate: null,
    merge: false,
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
      lifecycle: {
        policy: {
          module: "~/server/repo/cookbook",
          export: "COOKBOOK_DELETE_EDGE_POLICY",
        },
        runtime: null,
      },
      relationMutation: { attach: null, detach: null },
    },
  },
});
