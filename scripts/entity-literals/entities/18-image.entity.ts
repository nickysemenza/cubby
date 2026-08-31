import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "image",
  names: { singular: "Image", plural: "Images" },
  route: { basePath: "images" },
  table: "Image",
  identifiers: { brand: "ImageId", shortcode: "IMG-", legacy: null },
  presentation: { titleField: "filename" },
  fields: {
    create: null,
    update: { module: "@cubby/schemas/image", export: "imageUpdateInput" },
    output: { module: "@cubby/schemas/image", export: "imageOut" },
    list: {
      module: "@cubby/schemas/image",
      export: "imageWithEntitySchema",
    },
    detail: {
      module: "@cubby/schemas/image",
      export: "imageWithEntitySchema",
    },
  },
  filters: {
    schema: { module: "@cubby/schemas/image", export: "imageFilterFields" },
    descriptors: [
      {
        columnId: "filename",
        field: "nameFilter",
        kind: "text",
        placeholder: "Filter by filename...",
      },
      {
        columnId: "status",
        kind: "multiselect",
        placeholder: "Filter by upload status...",
        options: [
          { value: "PENDING", label: "Pending", color: "var(--slate)" },
          { value: "UPLOADED", label: "Uploaded", color: "var(--positive)" },
          { value: "FAILED", label: "Failed", color: "var(--destructive)" },
        ],
      },
      {
        columnId: "entity",
        field: "referencePresenceFilter",
        kind: "presence",
        placeholder: "Filter references...",
        options: [
          { value: "has", label: "Has reference", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "createdAt",
        kind: "range",
        placeholder: "Filter by created date...",
        options: [
          { value: "olderThan1h", label: "Older than 1 hour" },
          { value: "30d", label: "Last 30 days" },
          { value: "90d", label: "Last 90 days" },
          { value: "ytd", label: "Year to date" },
          { value: "1y", label: "Last 12 months" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveImageCreatedDate",
        },
      },
      {
        columnId: "updatedAt",
        kind: "range",
        placeholder: "Filter by updated date...",
        options: [
          { value: "30d", label: "Last 30 days" },
          { value: "90d", label: "Last 90 days" },
          { value: "ytd", label: "Year to date" },
          { value: "1y", label: "Last 12 months" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveUpdatedDate",
        },
      },
    ],
  },
  relations: [],
  search: { enabled: false },
  capabilities: {
    auditable: false,
    images: false,
    countable: true,
    softDelete: true,
    delete: { mode: "hard", bulk: true },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "update", "delete"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: {
        module: "~/server/repo/image.entity-adapter",
        export: "imageEntityAdapter",
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
      search: { projection: null, semanticText: null, dependentRefresh: null },
    },
  },
});
