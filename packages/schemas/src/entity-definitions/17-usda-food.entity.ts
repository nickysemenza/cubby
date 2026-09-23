import { defineEntity } from "./definition.js";
import { unitMappingWithMetadata } from "@cubby/schemas/unitmapping";
import {
  brandedFoodInfo,
  dataTypeEnum,
  dataTypeLabel,
  fdcId,
  foodInfo,
  foodPortion,
  legacyFoodInfo,
  nutritionInfo,
} from "@cubby/usda-schemas";
import { z } from "zod";
import { productTopLevelOut } from "../product-output-fields.js";
export default defineEntity({
  key: "usda-food",
  names: { singular: "USDA Food", plural: "USDA Foods" },
  route: { basePath: "usda", detailParam: "id", list: null, detail: null },
  table: null,
  identifiers: { brand: null, shortcode: null },
  presentation: {
    titleField: "description",
    domain: "pantry",
    description: "USDA foods available for product nutrition links.",
    emptyState: {
      title: "Nothing found in the USDA database",
      description: "Search for a food to pull in its nutrition details.",
    },
    icons: { lucide: "Apple", sfSymbol: "leaf.fill", emoji: "🍎" },
    detail: {
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Overview",
          fields: [
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
      ],
    },
    list: {
      primarySearch: {
        key: "nameFilter",
        placeholder: "Search USDA foods...",
      },
    },
  },
  model: {
    fields: [
      {
        key: "fdc_id",
        kind: "identifier",
        label: "FDC ID",
        display: { list: true, detail: true },
        provenance: {
          kind: "derived",
          sources: [{ label: "USDA identifiers" }],
        },
        explanation: {
          ruleId: "usda-food.fdc-id",
          description:
            "This identifier comes from the current USDA food record.",
          readPath: "fdc_id",
          sourceDependencies: [
            { path: "fdc_id", label: "USDA food identifier" },
          ],
        },
        validation: {
          read: fdcId,
          create: null,
          update: null,
        },
      },
      {
        // The food's name, lifted out of `foodInfo` when the web layer enriches
        // a USDA row so a generic surface (native row titles, `titleField`, the
        // `description` sort) can read it without knowing the JSON shape.
        key: "description",
        kind: "text",
        label: "Description",
        validation: {
          read: z.string(),
          create: null,
          update: null,
        },
      },
      {
        key: "brandedFoodInfo",
        kind: "json",
        nullable: true,
        label: "Branded food information",
        display: { detail: true },
        provenance: {
          kind: "derived",
          sources: [{ label: "USDA food record" }],
        },
        explanation: {
          ruleId: "usda-food.branded-food-info",
          description:
            "Branded food information is normalized from the current USDA food record when the record is branded.",
          readPath: "brandedFoodInfo",
          sourceDependencies: [
            {
              path: "brandedFoodInfo",
              label: "Current USDA branded food record",
            },
          ],
        },
        validation: {
          read: brandedFoodInfo.nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "foodInfo",
        kind: "json",
        label: "Food information",
        display: { list: true, detail: true },
        provenance: {
          kind: "derived",
          sources: [{ label: "USDA food record" }],
        },
        explanation: {
          ruleId: "usda-food.food-info",
          description:
            "Food information is normalized from the current USDA food record returned by the USDA reader.",
          readPath: "foodInfo",
          sourceDependencies: [
            { path: "foodInfo", label: "Current USDA food record" },
          ],
        },
        validation: {
          read: foodInfo,
          create: null,
          update: null,
        },
      },
      {
        key: "legacyFoodInfo",
        kind: "json",
        nullable: true,
        label: "Legacy food information",
        display: { detail: true },
        provenance: {
          kind: "derived",
          sources: [{ label: "USDA food record" }],
        },
        explanation: {
          ruleId: "usda-food.legacy-food-info",
          description:
            "Legacy food information is normalized from the current USDA food record when that legacy shape is present.",
          readPath: "legacyFoodInfo",
          sourceDependencies: [
            {
              path: "legacyFoodInfo",
              label: "Current USDA legacy food record",
            },
          ],
        },
        validation: {
          read: legacyFoodInfo.nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "nutritionInfo",
        kind: "json",
        label: "Nutrition",
        display: { detail: true },
        provenance: {
          kind: "derived",
          sources: [{ label: "USDA food record" }],
        },
        explanation: {
          ruleId: "usda-food.nutrition",
          description:
            "Nutrition is normalized from the nutrient values in the current USDA food record.",
          readPath: "nutritionInfo",
          sourceDependencies: [
            { path: "nutritionInfo", label: "Current USDA nutrient values" },
          ],
        },
        validation: {
          read: nutritionInfo,
          create: null,
          update: null,
        },
      },
      {
        key: "portionInfoRaw",
        kind: "json",
        label: "Portions",
        display: { detail: true },
        provenance: {
          kind: "derived",
          sources: [{ label: "USDA food record" }],
        },
        explanation: {
          ruleId: "usda-food.portions",
          description:
            "Portions are the serving measures supplied by the current USDA food record.",
          readPath: "portionInfoRaw",
          sourceDependencies: [
            { path: "portionInfoRaw", label: "Current USDA portions" },
          ],
        },
        validation: {
          read: z.array(foodPortion),
          create: null,
          update: null,
        },
      },
      {
        key: "inferredUnitMappings",
        kind: "json",
        label: "Inferred unit mappings",
        display: { detail: true },
        provenance: {
          kind: "derived",
          sources: [{ label: "USDA portion inference" }],
        },
        explanation: {
          ruleId: "usda-food.inferred-unit-mappings",
          description:
            "Unit mappings are inferred from the portions in the current USDA food record.",
          readPath: "inferredUnitMappings",
          sourceDependencies: [
            { path: "portionInfoRaw", label: "USDA portions" },
          ],
        },
        validation: {
          read: z.array(unitMappingWithMetadata),
          create: null,
          update: null,
        },
      },
      {
        key: "linkedProducts",
        kind: "json",
        label: "Linked products",
        reference: { entity: "product", multiple: true },
        display: { list: true, detail: true },
        explanation: {
          ruleId: "usda-food.linked-products",
          description:
            "Linked products are live Cubby products whose food identifier resolves to this USDA record.",
          readPath: "linkedProducts",
          sourceDependencies: [
            { path: "linkedProducts", label: "Linked Cubby products" },
          ],
        },
        validation: {
          read: z.array(productTopLevelOut),
          create: null,
          update: null,
        },
      },
    ],
    storage: [],
    create: [],
    update: [],
    bulk: [],
    audit: [],
    // `fdc_id`/`description` are plain top-level fields with a scalar read,
    // so they sort directly. `data_type` lives inside the `foodInfo` JSON
    // blob rather than as its own field, `relevance` is a search-only
    // synthetic score with no field at all, and `linkedProducts` — though a
    // declared field — is an array with no orderable scalar projection
    // (usda.service.ts sorts it by a correlated count). All three are
    // `computed`, same as a product's `expenseTotal`/`quantityVariance`.
    sort: {
      fields: [
        "fdc_id",
        "description",
        "data_type",
        "relevance",
        "linkedProducts",
      ],
      default: "fdc_id",
      computed: ["data_type", "relevance", "linkedProducts"],
    },
    output: [
      "fdc_id",
      "description",
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
  filters: {
    descriptors: [
      {
        columnId: "nameFilter",
        field: "nameFilter",
        kind: "text",
        placeholder: "Search USDA foods...",
        urlOnly: true,
        wire: { kind: "param", name: "nameFilter" },
      },
      {
        columnId: "dataTypeFilter",
        field: "dataTypeFilter",
        kind: "select",
        placeholder: "Filter by USDA data type...",
        options: dataTypeEnum.options.map((value) => ({
          value,
          label: dataTypeLabel(value),
        })),
        // USDA's standalone read keeps dataTypeFilter scalar and uses dataTypes
        // for plural values; the generic derived select schema is one-or-many.
        urlOnly: true,
        wire: { kind: "param", name: "dataTypeFilter" },
      },
      {
        columnId: "foodsOnly",
        kind: "boolean",
        placeholder: "Filter to foods...",
        options: [
          { value: "true", label: "Foods only" },
          { value: "false", label: "All records" },
        ],
        urlOnly: true,
        wire: { kind: "param", name: "foodsOnly" },
      },
      {
        columnId: "linkedProductsOnly",
        kind: "boolean",
        placeholder: "Filter by linked products...",
        options: [
          { value: "true", label: "Linked to products" },
          { value: "false", label: "Any linkage" },
        ],
        urlOnly: true,
        wire: { kind: "param", name: "linkedProductsOnly" },
      },
    ],
  },
  relations: [],
  search: { enabled: false },
  capabilities: {
    auditable: false,
    images: { storage: false },
    countable: false,
    softDelete: false,
    delete: null,
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: null, merge: null },
    mcp: ["get", "list"],
  },
  extensions: {
    mcpNames: { overrides: { list: "search_usda_foods" } },
    ports: {
      repository: null,
      references: {
        label: { module: "~/entities/entities", export: "entityLabel" },
        resolver: null,
      },
    },
  },
});
