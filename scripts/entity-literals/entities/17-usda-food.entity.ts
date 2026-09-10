import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "usda-food",
  names: { singular: "USDA Food", plural: "USDA Foods" },
  route: { basePath: "usda", detailParam: "id" },
  table: null,
  identifiers: { brand: null, shortcode: null, legacy: null },
  presentation: { titleField: "description" },
  model: {
    fields: [
      {
        key: "fdc_id",
        kind: "identifier",
        label: "FDC ID",
        display: { list: true, detail: true },
        validation: {
          read: {
            kind: "source",
            source: { module: "@cubby/usda-schemas", export: "fdcId" },
          },
        },
      },
      {
        key: "brandedFoodInfo",
        kind: "json",
        nullable: true,
        label: "Branded food information",
        display: { detail: true },
        validation: {
          read: {
            kind: "source",
            source: {
              module: "@cubby/usda-schemas",
              export: "brandedFoodInfo",
            },
            nullable: true,
          },
        },
      },
      {
        key: "foodInfo",
        kind: "json",
        label: "Food information",
        display: { list: true, detail: true },
        validation: {
          read: {
            kind: "source",
            source: { module: "@cubby/usda-schemas", export: "foodInfo" },
          },
        },
      },
      {
        key: "legacyFoodInfo",
        kind: "json",
        nullable: true,
        label: "Legacy food information",
        display: { detail: true },
        validation: {
          read: {
            kind: "source",
            source: { module: "@cubby/usda-schemas", export: "legacyFoodInfo" },
            nullable: true,
          },
        },
      },
      {
        key: "nutritionInfo",
        kind: "json",
        label: "Nutrition",
        display: { detail: true },
        validation: {
          read: {
            kind: "source",
            source: { module: "@cubby/usda-schemas", export: "nutritionInfo" },
          },
        },
      },
      {
        key: "portionInfoRaw",
        kind: "json",
        label: "Portions",
        display: { detail: true },
        validation: {
          read: {
            kind: "array",
            item: {
              kind: "source",
              source: { module: "@cubby/usda-schemas", export: "foodPortion" },
            },
          },
        },
      },
      {
        key: "inferredUnitMappings",
        kind: "json",
        label: "Inferred unit mappings",
        display: { detail: true },
        validation: {
          read: {
            kind: "array",
            item: {
              kind: "source",
              source: {
                module: "@cubby/schemas/unitmapping",
                export: "unitMappingWithMetadata",
              },
            },
          },
        },
      },
      {
        key: "linkedProducts",
        kind: "json",
        label: "Linked products",
        reference: { entity: "product", multiple: true },
        display: { list: true, detail: true },
        validation: {
          read: {
            kind: "array",
            item: {
              kind: "source",
              source: {
                module: "@cubby/schemas/product",
                export: "productTopLevelOut",
              },
            },
          },
        },
      },
    ],
    storage: [],
    create: [],
    update: [],
    bulk: [],
    audit: [],
    output: [
      "fdc_id",
      "brandedFoodInfo",
      "foodInfo",
      "legacyFoodInfo",
      "nutritionInfo",
      "portionInfoRaw",
      "inferredUnitMappings",
      "linkedProducts",
    ],
  },
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
    mcp: ["get", "list"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: { overrides: { list: "search_usda_foods" } },
    ports: {
      repository: null,
      references: {
        label: { module: "~/entities/entities", export: "entityLabel" },
        resolver: null,
      },
      filters: {
        module: "~/entities/filter-manifest",
        export: "getEntityFilters",
      },
      search: { projection: null, semanticText: null, dependentRefresh: null },
    },
  },
});
