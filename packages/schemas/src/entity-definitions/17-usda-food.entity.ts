import { defineEntity } from "./definition.js";
import { unitMappingWithMetadata } from "@cubby/schemas/unitmapping";
import {
  brandedFoodInfo,
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
  },
  model: {
    fields: [
      {
        key: "fdc_id",
        kind: "identifier",
        label: "FDC ID",
        display: { list: true, detail: true },
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
  filters: { descriptors: [] },
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
