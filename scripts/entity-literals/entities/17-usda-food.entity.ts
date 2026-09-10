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
        nullable: false,
        label: "FDC ID",
        description: null,
        readKey: "fdc_id",
        reference: null,
        control: null,
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
        description: null,
        readKey: "brandedFoodInfo",
        reference: null,
        control: null,
        display: { list: false, detail: true },
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
        nullable: false,
        label: "Food information",
        description: null,
        readKey: "foodInfo",
        reference: null,
        control: null,
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
        description: null,
        readKey: "legacyFoodInfo",
        reference: null,
        control: null,
        display: { list: false, detail: true },
        validation: {
          read: {
            kind: "source",
            source: {
              module: "@cubby/usda-schemas",
              export: "legacyFoodInfo",
            },
            nullable: true,
          },
        },
      },
      {
        key: "nutritionInfo",
        kind: "json",
        nullable: false,
        label: "Nutrition",
        description: null,
        readKey: "nutritionInfo",
        reference: null,
        control: null,
        display: { list: false, detail: true },
        validation: {
          read: {
            kind: "source",
            source: {
              module: "@cubby/usda-schemas",
              export: "nutritionInfo",
            },
          },
        },
      },
      {
        key: "portionInfoRaw",
        kind: "json",
        nullable: false,
        label: "Portions",
        description: null,
        readKey: "portionInfoRaw",
        reference: null,
        control: null,
        display: { list: false, detail: true },
        validation: {
          read: {
            kind: "array",
            item: {
              kind: "source",
              source: {
                module: "@cubby/usda-schemas",
                export: "foodPortion",
              },
            },
          },
        },
      },
      {
        key: "inferredUnitMappings",
        kind: "json",
        nullable: false,
        label: "Inferred unit mappings",
        description: null,
        readKey: "inferredUnitMappings",
        reference: null,
        control: null,
        display: { list: false, detail: true },
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
        nullable: false,
        label: "Linked products",
        description: null,
        readKey: "linkedProducts",
        reference: { entity: "product", multiple: true },
        control: null,
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
