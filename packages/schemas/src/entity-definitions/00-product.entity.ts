import { defineEntity } from "./definition.js";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { plainDate } from "@cubby/schemas/base-entity";
import { dataQuality } from "@cubby/schemas/data-quality";
import {
  externalIdInputs,
  externalIdOut,
  gtin,
} from "@cubby/schemas/external-id";
import {
  imageShortcode,
  ingredientShortcode,
  productShortcode,
} from "../identifier-fields.js";
import { imageOut } from "./field-primitives.js";
import { money } from "@cubby/schemas/money";
import { productLabelNutrition } from "@cubby/schemas/nutrition";
import {
  moneyNullable,
  positiveMoneyNullable,
  productCategory,
  productPricingOut,
} from "@cubby/schemas/product-fields";
import { unitMappingInput } from "@cubby/schemas/unitmapping";
import { fdcId } from "@cubby/usda-schemas";
import { z } from "zod";
export default defineEntity({
  key: "product",
  names: { singular: "Product", plural: "Products" },
  route: { basePath: "products", create: "page", list: true, detail: true },
  table: "Product",
  identifiers: { brand: "ProductId", shortcode: "PRD-" },
  presentation: {
    titleField: "name",
    // Pantry/Inventory wayfinding, not a Product status colour; USDA data
    // follows the product catalog onto the same line.
    domain: "pantry",
    description: "Specific household products and their identity.",
    emptyState: {
      title: "Nothing on the shelves yet",
      description:
        "Add the things you own to track what you have and what it's worth. Scan a barcode or add one by hand.",
      actionLabel: "Add Product",
    },
    icons: { lucide: "Barcode", sfSymbol: "shippingbox", emoji: "📦" },
    detail: {
      hero: {
        images: true,
        actions: ["edit", "addToInventory", "recordSale", "discard"],
      },
      sections: [
        {
          kind: "fields",
          id: "basic-information",
          title: "Basic information",
          placement: "supporting",
          fields: [
            "name",
            "id",
            "manufacturer",
            "model",
            "price",
            "category",
            "primaryGtin",
            "fdc_id",
            "ingredientId",
            "growsIngredientId",
            "externalIds",
            "tags",
            "notes",
          ],
        },
        {
          kind: "relation",
          id: "plantings",
          title: "Plantings",
          relation: "plantings",
          filter: { descriptor: "sourceProductId" },
          hideWhenEmpty: true,
        },
        {
          kind: "relation",
          id: "stocked-at",
          title: "Stocked at",
          relation: "inventory",
          filter: { descriptor: "productId" },
          columns: ["amount", "placement", "verifiedAt"],
        },
        {
          kind: "relation",
          id: "expense-history",
          title: "Expense history",
          relation: "expenses",
          filter: { descriptor: "productId" },
          columns: ["name", "cost", "date", "lineKind", "project"],
          sort: { field: "date", direction: "desc" },
        },
        {
          kind: "relation",
          id: "purchases",
          title: "Purchases",
          relation: "purchases",
          filter: { descriptor: "productId" },
          columns: ["vendor", "displayLabel", "date", "statedTotal"],
          sort: { field: "date", direction: "desc" },
        },
        {
          kind: "relation",
          id: "kit-components",
          title: "Kit components",
          relation: "components",
          filter: { descriptor: "kitId" },
          columns: ["name", "manufacturer", "onHandUnits"],
        },
        {
          kind: "relation",
          id: "vendors",
          title: "Vendors",
          relation: "vendors",
          filter: { descriptor: "productId" },
          columns: ["name", "purchaseCount", "spend", "latestPurchaseDate"],
        },
        {
          kind: "relation",
          id: "project-uses",
          title: "Used on projects",
          relation: "project-uses",
          filter: { descriptor: "usedToolId" },
          columns: ["name", "status", "kind", "startDate"],
        },
        {
          kind: "relation",
          id: "tasks",
          title: "Tasks",
          relation: "tasks",
          filter: { descriptor: "subjectProduct" },
          columns: ["name", "status", "dueDate", "trade"],
          sort: { field: "dueDate", direction: "desc" },
        },
        {
          kind: "timeline",
          id: "movements",
          title: "Movements",
          placement: "full",
        },
        { kind: "slot", id: "nutrition", title: "Nutrition" },
        // `unitMappings` is composed onto the detail read beside the generated
        // read map (it is not a read-projection field), so it cannot be a
        // `fields` section.
        { kind: "slot", id: "unit-mappings", title: "Unit mappings" },
        { kind: "slot", id: "fits-with", title: "Fits with" },
        { kind: "slot", id: "cookbooks", title: "Cookbooks" },
        { kind: "slot", id: "recipe-appearances", title: "Appears in recipes" },
      ],
    },
    list: {
      views: ["table", "shelf", "timeline"],
      shelf: { subtitle: ["price", "category"] },
      actions: [
        "addToInventory",
        "discard",
        "setStockTracking",
        "printLabels",
        "merge",
        "delete",
      ],
      timeline: { fields: ["purchaseDate"] },
    },
  },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text", section: "identity-name" },
        display: { list: true, detail: true, standard: "name", detailOrder: 0 },
        validation: {
          read: z
            .string()
            .describe("Product name")
            .meta({ mock: "commerce.productName" }),
          create: z
            .string()
            .trim()
            .min(1, "Product name is required")
            .describe("Product name")
            .meta({ mock: "commerce.productName" }),
          update: z
            .string()
            .trim()
            .min(1, "Product name is required")
            .describe("Product name")
            .meta({ mock: "commerce.productName" })
            .optional(),
        },
      },
      {
        key: "aliases",
        kind: "text-array",
        control: { kind: "specialized", renderer: "tag-list" },
        validation: {
          read: z.array(z.string()),
          create: z.array(z.string()).default([]),
          update: z.array(z.string()).optional(),
        },
      },
      {
        key: "tags",
        kind: "text-array",
        control: { kind: "specialized", renderer: "tag-list" },
        display: {
          list: true,
          listOrder: 16,
          detail: true,
          detailOrder: 10,
          listHidden: true,
          renderer: { detail: "product-tags" },
        },
        validation: {
          read: z.array(z.string()),
          create: z.array(z.string()).default([]),
          update: z.array(z.string()).optional(),
        },
      },
      {
        key: "upc",
        kind: "text",
        nullable: true,
        readKey: null,
        control: { kind: "text" },
        provenance: {
          kind: "relation",
          sources: [{ label: "Product identifiers" }],
        },
        validation: {
          read: null,
          create: gtin.nullable().optional(),
          update: gtin.nullable().optional(),
        },
      },
      {
        key: "isbn",
        kind: "text",
        nullable: true,
        readKey: null,
        control: { kind: "text" },
        provenance: {
          kind: "relation",
          sources: [{ label: "Product identifiers" }],
        },
        // Plain string: check-digit validation + GTIN-14 normalization now
        // happen at the repository boundary (`resolvePrimaryProductCodeInput`
        // in `apps/web/src/server/repo/product/update-helpers.ts`), not here —
        // `packages/schemas` cannot depend on the WASM boundary that
        // validation needs (see `@cubby/recipebridge`).
        validation: {
          read: null,
          create: z.string().trim().nullable().optional(),
          update: z.string().trim().nullable().optional(),
        },
      },
      {
        key: "fdc_id",
        kind: "number",
        nullable: true,
        // Was "USDA FDC ID"; the list column has always headed this "FDC" —
        // declaration wins, so the detail label follows the list now too.
        label: "FDC",
        control: { kind: "number" },
        display: {
          list: true,
          listOrder: 3,
          detail: true,
          detailOrder: 7,
          width: "sm",
          renderer: { detail: "product-fdc-id" },
          format: "external-link",
          listHidden: true,
        },
        validation: {
          read: fdcId.nullable(),
          create: fdcId.nullable().optional(),
          update: fdcId.nullable().optional(),
        },
      },
      {
        key: "manufacturer",
        kind: "text",
        control: { kind: "text", section: "manufacturer" },
        display: {
          list: true,
          listOrder: 1,
          detail: true,
          detailOrder: 2,
          width: "md",
          mobile: { slot: "subtitle", priority: 20 },
          listHidden: true,
        },
        validation: {
          read: z.string(),
          // Defaults rather than requires: most generic groceries and
          // receipt lines have no maker, and demanding an explicit
          // "(unspecified)" from every MCP create only produced typos.
          create: z.string().default(UNSPECIFIED_MANUFACTURER),
          update: z.string().optional(),
        },
      },
      {
        key: "model",
        kind: "text",
        nullable: true,
        control: { kind: "text", section: "identity-model" },
        display: {
          list: true,
          listOrder: 4,
          detail: true,
          detailOrder: 3,
          width: "md",
          listHidden: true,
        },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().optional(),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        control: { kind: "textarea", section: "notes" },
        display: {
          list: true,
          detail: true,
          listOrder: 5,
          width: "md",
          listHidden: true,
        },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().optional(),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "expectedQuantity",
        kind: "number",
        nullable: true,
        control: { kind: "number" },
        // The list now shows the ledger's computed expectedQuantity
        // (`ledgerExpectedQuantity`, aliased to this same "expectedQuantity"
        // column id) instead of this raw stored override — this field stays
        // create/update-only.
        validation: {
          read: z.number().nullable(),
          create: z.number().nullable().optional(),
          update: z.number().nullable().optional(),
        },
      },
      {
        key: "category",
        kind: "enum",
        nullable: true,
        control: {
          kind: "select",
          section: "category",
          suggest: { basis: ["name", "manufacturer"] },
        },
        display: {
          list: true,
          listOrder: 0,
          detail: true,
          detailOrder: 5,
          width: "sm",
          mobile: { slot: "subtitle", priority: 30 },
        },
        validation: {
          read: productCategory.nullable(),
          create: productCategory.nullable().optional(),
          update: productCategory.nullable().optional(),
        },
      },
      {
        key: "ingredientId",
        kind: "identifier",
        nullable: true,
        label: "Ingredient",
        readKey: null,
        reference: { entity: "ingredient" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          detail: true,
          detailOrder: 8,
          renderer: { detail: "product-ingredient" },
        },
        validation: {
          read: null,
          create: ingredientShortcode.nullable().optional(),
          update: ingredientShortcode.nullable().optional(),
        },
      },
      {
        key: "growsIngredientId",
        kind: "identifier",
        nullable: true,
        label: "Grows",
        reference: { entity: "ingredient" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true },
        validation: {
          read: ingredientShortcode.nullable(),
          create: ingredientShortcode.nullable().optional(),
          update: ingredientShortcode.nullable().optional(),
        },
      },
      {
        key: "price",
        kind: "number",
        nullable: true,
        // Stays "Valuation price": the detail page's `EntityBasicInfo`
        // override for this field supplies no label of its own (unlike
        // `primaryGtin`'s dynamic ISBN/UPC label), so this declared label is
        // still its detail label — asserted by
        // product-basic-info-filter.unit.test.tsx, a file outside this
        // migration's ownership. The list column has always headed this
        // "Price" instead; since an override's plain-string header is always
        // replaced by this label, productlist.tsx's override supplies a
        // header FUNCTION for this one column to opt out of that
        // substitution and keep "Price" on the list without touching the
        // detail label.
        label: "Valuation price",
        control: { kind: "number", renderer: "money" },
        display: {
          list: true,
          listOrder: 9,
          detail: true,
          detailOrder: 4,
          format: "currency",
        },
        validation: {
          read: moneyNullable.describe(
            "Manual per-item valuation/replacement-price override; null resumes the Expense-derived fallback.",
          ),
          create: positiveMoneyNullable.optional(),
          update: positiveMoneyNullable.optional(),
        },
      },
      {
        key: "unitMappings",
        kind: "json",
        readKey: null,
        control: { kind: "specialized", renderer: "structured-field" },
        provenance: {
          kind: "relation",
          sources: [{ label: "Unit mappings" }],
        },
        validation: {
          read: null,
          create: z.array(unitMappingInput).default([]),
          update: z.array(unitMappingInput).optional(),
        },
      },
      {
        key: "labelNutrition",
        kind: "json",
        nullable: true,
        label: "Label nutrition",
        // No `display` — same as `unitMappings`, this keeps the generic
        // detail/form renderer from touching it; a bespoke section owns the
        // UI. Unlike `unitMappings` this has a real `readKey`/`read` schema
        // (it's a physical Product column, not a synthesized child-table
        // projection), so it still reaches `productTopLevelFields` (the
        // output roster) for costing/API consumers.
        control: { kind: "specialized", renderer: "structured-field" },
        validation: {
          read: productLabelNutrition.nullable(),
          create: productLabelNutrition.nullable().optional(),
          update: productLabelNutrition.nullable().optional(),
        },
      },
      {
        key: "externalIds",
        kind: "text-array",
        label: "External IDs",
        control: { kind: "specialized", renderer: "tag-list" },
        provenance: {
          kind: "relation",
          sources: [{ label: "Product identifiers" }],
        },
        display: {
          list: true,
          listOrder: 8,
          detail: true,
          detailOrder: 9,
          renderer: { detail: "product-external-ids" },
          listHidden: true,
        },
        validation: {
          read: z.array(externalIdOut),
          create: externalIdInputs.default([]),
          update: externalIdInputs.optional(),
        },
      },
      {
        key: "usdaUnavailable",
        kind: "boolean",
        nullable: true,
        control: { kind: "checkbox" },
        // Hidden by default via the page's `initialColumnVisibility` — this
        // was already declared `list: true` before this migration, but the
        // page never wired `createEntityDisplayColumns` up to render it.
        display: { list: true, listOrder: 18, listHidden: true },
        validation: {
          read: z.boolean().nullable(),
          create: z.boolean().nullable().optional(),
          update: z.boolean().nullable().optional(),
        },
      },
      {
        key: "stockTracked",
        kind: "boolean",
        nullable: true,
        // Default label would be "Stock Tracked"; the list column has always
        // headed this "Stock tracking".
        label: "Stock tracking",
        control: { kind: "checkbox" },
        display: { list: true, listOrder: 6, width: "sm", listHidden: true },
        validation: {
          read: z.boolean().nullable(),
          create: z.boolean().nullable().optional(),
          update: z.boolean().nullable().optional(),
        },
      },
      {
        key: "pendingImageIds",
        kind: "identifier",
        label: "Pending Image IDs",
        readKey: null,
        reference: { entity: "image", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        validation: {
          read: null,
          create: z.array(imageShortcode).optional(),
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "removeImageIds",
        kind: "identifier",
        label: "Remove Image IDs",
        readKey: null,
        reference: { entity: "image", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        validation: {
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "imageOrder",
        kind: "text",
        readKey: null,
        control: { kind: "specialized", renderer: "image-order" },
        provenance: {
          kind: "relation",
          sources: [{ entity: "image", relation: "images" }],
        },
        validation: {
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "id",
        kind: "identifier",
        label: "Shortcode",
        display: {
          detail: true,
          detailOrder: 1,
          renderer: { detail: "product-id" },
        },
        validation: {
          read: productShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "primaryGtin",
        kind: "text",
        nullable: true,
        // Was "UPC" — the list column has always headed this "Barcode /
        // ISBN" (it edits either an ISBN or a UPC). The detail page's own
        // "UPC"/"ISBN-13" label is a dynamic override, so it is unaffected.
        label: "Barcode / ISBN",
        display: {
          list: true,
          listOrder: 2,
          detail: true,
          detailOrder: 6,
          width: "sm",
          renderer: { detail: "product-primary-gtin" },
        },
        provenance: {
          kind: "derived",
          sources: [{ label: "Product identifiers" }],
        },
        validation: {
          read: gtin.nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "images",
        kind: "json",
        display: { list: true, standard: "image", columnId: "image" },
        provenance: {
          kind: "derived",
          sources: [{ entity: "image", relation: "images" }],
        },
        validation: {
          read: z.array(imageOut),
          create: null,
          update: null,
        },
      },
      {
        key: "pricing",
        kind: "json",
        validation: {
          read: productPricingOut,
          create: null,
          update: null,
        },
      },
      {
        key: "dataQuality",
        kind: "json",
        // Default label would be "Data Quality"; the list column has always
        // headed this "Data quality".
        label: "Data quality",
        display: { list: true, listOrder: 7, listHidden: true },
        provenance: { kind: "derived", sources: [{ entity: "product" }] },
        validation: {
          read: dataQuality,
          create: null,
          update: null,
        },
      },
      // Read-only, list-only computed values carried on `ProductListItem`
      // (never a stored `Product` column) — each needs the override
      // `productlist.tsx` supplies, per docs/entities.md's "declaration
      // wins" rule.
      {
        key: "expenseTotal",
        kind: "number",
        label: "Net basis",
        display: { list: true, listOrder: 10, listHidden: true },
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense", relation: "expenses" }],
        },
        validation: {
          read: money,
          create: null,
          update: null,
        },
      },
      {
        key: "componentCount",
        kind: "number",
        label: "Components",
        display: { list: true, listOrder: 12, columnId: "components" },
        provenance: {
          kind: "derived",
          sources: [{ entity: "product", relation: "components" }],
        },
        validation: {
          read: z.number().int().nonnegative(),
          create: null,
          update: null,
        },
      },
      {
        key: "servingAsLocations",
        kind: "number",
        label: "In service",
        // Nested under `quantityLedger.locationCount` on the list row — no
        // flat readKey can reach it, so this needs the override
        // `productlist.tsx` supplies.
        readKey: null,
        display: { list: true, listOrder: 11 },
        provenance: {
          kind: "derived",
          sources: [{ entity: "location", relation: "locations" }],
        },
      },
      {
        key: "ledgerExpectedQuantity",
        kind: "number",
        label: "Expected",
        // Nested under `quantityLedger.expectedQuantity` on the list row.
        // Aliased to the "expectedQuantity" column id — the stored
        // `expectedQuantity` field above no longer renders a list column, so
        // this is the sole claimant of that (persisted) column id now.
        readKey: null,
        display: {
          list: true,
          listOrder: 13,
          columnId: "expectedQuantity",
          listHidden: true,
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense", relation: "expenses" }],
        },
      },
      {
        key: "quantityVariance",
        kind: "number",
        nullable: true,
        label: "Variance",
        display: { list: true, listOrder: 14, listHidden: true },
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense", relation: "expenses" }],
        },
        validation: {
          read: z.number().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "purchaseDate",
        kind: "date",
        nullable: true,
        // Default label would be "Purchase Date"; the list column has
        // always headed this "Purchase date".
        label: "Purchase date",
        display: { list: true, listOrder: 15 },
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense", relation: "expenses" }],
        },
        validation: {
          read: plainDate.nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "expenseCount",
        kind: "number",
        label: "Expenses",
        display: { list: true, listOrder: 17, columnId: "expenses" },
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense", relation: "expenses" }],
        },
        validation: {
          read: z.number().int(),
          create: null,
          update: null,
        },
      },
      {
        // Never its own column before this migration — a plain, generic,
        // hidden-by-default addition (same shape as the task entity's
        // `dueEndDate`/`sortOrder`), not part of the read-only cluster above.
        key: "onHandUnits",
        kind: "number",
        nullable: true,
        display: {
          list: true,
          listOrder: 19,
          listHidden: true,
          mobile: { slot: "trailing", priority: 0 },
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "inventory", relation: "inventory" }],
        },
        validation: {
          read: z.number().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
      },
      { key: "shortcode", kind: "text", readKey: null },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
      { key: "dataExceptions", kind: "json", readKey: null },
    ],
    storage: [
      { key: "id", default: "generated", specialized: "primary-key:ProductId" },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      {
        key: "aliases",
        default: "literal",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      "manufacturer",
      "fdc_id",
      "model",
      "expectedQuantity",
      "notes",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
      { key: "ingredientId", reference: "ingredient" },
      { key: "growsIngredientId", reference: "ingredient" },
      { key: "category", specialized: "enum:category" },
      {
        key: "tags",
        default: "literal",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      { key: "price", specialized: "real" },
      "usdaUnavailable",
      "stockTracked",
      { key: "labelNutrition", specialized: "json:labelNutrition" },
      {
        key: "dataExceptions",
        default: "literal",
        defaultValue: "'[]'::jsonb",
        specialized: "json:dataExceptions",
      },
    ],
    create: [
      "name",
      "aliases",
      "tags",
      "upc",
      "isbn",
      "fdc_id",
      "manufacturer",
      "model",
      "notes",
      "expectedQuantity",
      "category",
      "ingredientId",
      "growsIngredientId",
      "price",
      "unitMappings",
      "labelNutrition",
      "externalIds",
      "usdaUnavailable",
      "stockTracked",
      "pendingImageIds",
    ],
    update: [
      "name",
      "aliases",
      "tags",
      "upc",
      "isbn",
      "fdc_id",
      "manufacturer",
      "model",
      "notes",
      "expectedQuantity",
      "category",
      "ingredientId",
      "growsIngredientId",
      "price",
      "unitMappings",
      "labelNutrition",
      "externalIds",
      "usdaUnavailable",
      "stockTracked",
      "pendingImageIds",
      "removeImageIds",
      "imageOrder",
    ],
    bulk: ["stockTracked"],
    audit: [
      "name",
      "aliases",
      "tags",
      "manufacturer",
      "category",
      "externalIds",
      "fdc_id",
      "model",
      "expectedQuantity",
      "ingredientId",
      "growsIngredientId",
      "price",
      "labelNutrition",
    ],
    sort: {
      fields: [
        "createdAt",
        "updatedAt",
        "name",
        "manufacturer",
        "model",
        "primaryGtin",
        "category",
        "fdc_id",
        "price",
        "notes",
        "location",
        "ingredient",
        "expenseTotal",
        "expenses",
        "expectedQuantity",
        "quantityVariance",
        "purchaseDate",
        "related:product.projects",
        "related:product.vendors",
        "related:product.purchases",
        "identity_strength",
      ],
      default: "createdAt",
      computed: [
        "location",
        "ingredient",
        "expenseTotal",
        "expenses",
        "quantityVariance",
        "purchaseDate",
        "related:product.projects",
        "related:product.vendors",
        "related:product.purchases",
        "identity_strength",
      ],
      groupable: ["category"],
    },
    intents: {
      fields: {
        capture: ["name", "manufacturer"],
        full: [
          "name",
          "aliases",
          "manufacturer",
          "model",
          "category",
          "ingredientId",
          "growsIngredientId",
          "upc",
          "fdc_id",
          "price",
          "stockTracked",
          "unitMappings",
          "labelNutrition",
          "notes",
        ],
        identity: ["name", "aliases", "manufacturer", "model", "category"],
        price: ["price"],
        stock: ["stockTracked"],
      },
      create: ["capture", "full"],
      update: ["full", "identity", "price", "stock"],
    },
    output: [
      "id",
      "name",
      "aliases",
      "tags",
      "primaryGtin",
      "fdc_id",
      "manufacturer",
      "model",
      "notes",
      "expectedQuantity",
      "category",
      "growsIngredientId",
      "images",
      "externalIds",
      "price",
      "pricing",
      "usdaUnavailable",
      "stockTracked",
      "labelNutrition",
      "dataQuality",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: { module: "@cubby/schemas/product", export: "productCreateInput" },
    update: { module: "@cubby/schemas/product", export: "productUpdateData" },
    output: { module: "@cubby/schemas/product", export: "productTopLevelOut" },
    list: { module: "@cubby/schemas/product", export: "productListItemOut" },
    detail: { module: "@cubby/schemas/product", export: "productWithFoodOut" },
    mcpOutput: {
      module: "@cubby/schemas/product",
      export: "productTopLevelMcpEntityOut",
    },
    mcpList: {
      module: "@cubby/schemas/product",
      export: "productListItemMcpEntityOut",
    },
    mcpDetail: {
      module: "@cubby/schemas/product",
      export: "productWithFoodMcpEntityOut",
    },
  },
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/product", export: "productFilterFields" },
    descriptors: [
      {
        columnId: "name",
        field: "nameFilter",
        kind: "text",
        placeholder: "Filter by name...",
        deriveSchema: true,
        stored: true,
        schemaDescription: "Filter by product name",
      },
      {
        columnId: "manufacturer",
        field: "manufacturerExact",
        kind: "multiselect",
        placeholder: "Filter by manufacturer...",
        deriveSchema: true,
        stored: true,
        optionsKey: "manufacturers",
      },
      {
        columnId: "manufacturerSearch",
        field: "manufacturerFilter",
        kind: "text",
        placeholder: "Search manufacturer...",
        urlOnly: true,
        deriveSchema: true,
        schemaDescription: "Filter by manufacturer",
        stored: { columns: ["manufacturer"] },
      },
      {
        columnId: "primaryGtin",
        field: "upcFilter",
        kind: "text",
        placeholder: "Filter by UPC...",
        deriveSchema: true,
        schemaDescription:
          "Filter by UPC/barcode — matches ANY of the product's barcodes",
      },
      {
        columnId: "model",
        field: "modelFilter",
        kind: "text",
        placeholder: "Filter by model...",
        deriveSchema: true,
        stored: true,
        schemaDescription:
          "Filter by model number — a tool's real identity when the name is generic.",
      },
      {
        columnId: "modelPresence",
        field: "modelPresenceFilter",
        kind: "presence",
        placeholder: "Filter model presence...",
        deriveSchema: true,
        stored: { columns: ["model"] },
        options: [
          { value: "has", label: "Has model", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "upcPresence",
        field: "upcPresenceFilter",
        kind: "presence",
        placeholder: "Filter UPC presence...",
        options: [
          { value: "has", label: "Has UPC", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "category",
        field: "categoryFilter",
        kind: "multiselect",
        placeholder: "Filter by category...",
        deriveSchema: true,
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/product-fields",
          export: "productCategory",
        },
        schemaDescription: "Filter by category",
        optionsRef: {
          module: "~/app/_components/products/product-category-icons",
          export: "productCategoryOptionsWithTheme",
        },
        nullable: { field: "categoryPresenceFilter", label: "category" },
      },
      {
        columnId: "location",
        field: "locationIdFilter",
        kind: "idMulti",
        placeholder: "Filter locations...",
        optionsKey: "productLocations",
        brandRef: { entity: "location" },
        nullable: { field: "inventoryPresenceFilter", label: "inventory" },
      },
      {
        columnId: "servingAsLocations",
        field: "servingAsLocationPresenceFilter",
        kind: "presence",
        placeholder: "Filter in service...",
        options: [
          { value: "has", label: "Has in service as a location", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "ingredient",
        field: "ingredientIdFilter",
        kind: "idMulti",
        placeholder: "Filter ingredient...",
        optionsKey: "productIngredients",
        brandRef: { entity: "ingredient" },
        nullable: { field: "ingredientPresenceFilter", label: "ingredient" },
      },
      {
        columnId: "growsIngredient",
        field: "growsIngredientIdFilter",
        kind: "idMulti",
        placeholder: "Filter by crop grown...",
        optionsKey: "productIngredients",
        brandRef: { entity: "ingredient" },
      },
      {
        columnId: "expenses",
        kind: "range",
        wire: {
          kind: "range",
          from: "expenseCountMin",
          to: "expenseCountMax",
          presence: "expensePresenceFilter",
        },
        placeholder: "Filter expenses...",
        options: [
          { value: "has", label: "Has expenses", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "1", label: "1+ expenses" },
          { value: "2", label: "2+ expenses" },
          { value: "5", label: "5+ expenses" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveExpenseCount",
        },
      },
      {
        columnId: "expenseTotal",
        kind: "range",
        placeholder: "Filter net basis...",
        options: [
          { value: "positive", label: "Positive basis" },
          { value: "zero", label: "Zero basis" },
          { value: "negative", label: "Credit / negative" },
          { value: "gte100", label: "$100 and up" },
          { value: "gte500", label: "$500 and up" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveNetBasis",
        },
      },
      {
        columnId: "expectedQuantity",
        kind: "range",
        placeholder: "Filter expected quantity...",
        deriveSchema: true,
        options: [
          { value: "negative", label: "Negative (sold more than bought)" },
          { value: "zero", label: "Zero (none expected)" },
          { value: "positive", label: "One or more expected" },
          { value: "gte5", label: "5 or more expected" },
          { value: "unknown", label: "Has lines with no quantity" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveExpectedQuantity",
        },
      },
      {
        columnId: "quantityVariance",
        kind: "range",
        wire: { kind: "param", name: "quantityVarianceFilter" },
        placeholder: "Filter shelf vs. ledger...",
        options: [
          { value: "mismatched", label: "Shelf disagrees with ledger" },
          { value: "matched", label: "Shelf matches ledger" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveQuantityVariance",
        },
      },
      {
        columnId: "notes",
        field: "notesFilter",
        kind: "text",
        placeholder: "Search notes...",
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "notesPresence",
        field: "notesPresenceFilter",
        kind: "presence",
        placeholder: "Filter notes presence...",
        deriveSchema: true,
        stored: { columns: ["notes"] },
        options: [
          { value: "has", label: "Has notes", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "dataQuality",
        field: "dataStatus",
        kind: "select",
        placeholder: "Filter data quality...",
        options: [
          { value: "complete", label: "Complete", color: "var(--slate)" },
          { value: "needs_data", label: "Needs data", color: "var(--warning)" },
          { value: "defect", label: "Defect", color: "var(--destructive)" },
        ],
      },
      {
        columnId: "dataGaps",
        field: "dataGap",
        kind: "multiselect",
        placeholder: "Filter data gaps...",
        options: [
          { value: "product_manufacturer", label: "Manufacturer" },
          { value: "product_category", label: "Category" },
          { value: "product_model", label: "Model" },
          { value: "product_image", label: "No image (stocked)" },
          { value: "amazon_asin", label: "Amazon ASIN" },
          { value: "duplicate_external_id", label: "Duplicate external ID" },
        ],
      },
      {
        columnId: "externalIds",
        field: "externalIdSource",
        kind: "multiselect",
        placeholder: "Filter by external ID source...",
        optionsKey: "externalIdSources",
        nullable: { field: "externalIdPresenceFilter", label: "external ID" },
      },
      {
        columnId: "purchaseDate",
        kind: "range",
        placeholder: "Filter by purchase date...",
        options: [
          { value: "has", label: "Has purchase date", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "30d", label: "Last 30 days" },
          { value: "90d", label: "Last 90 days" },
          { value: "ytd", label: "Year to date" },
          { value: "1y", label: "Last 12 months" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveProductPurchaseDateFilter",
        },
      },
      {
        columnId: "price",
        kind: "range",
        wire: { kind: "param", name: "pricePresenceFilter" },
        placeholder: "Filter price...",
        options: [
          { value: "has", label: "Has price", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "none-real", label: "No price (excluding buckets)" },
          { value: "none-bucket", label: "No price (buckets only)" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolvePrice",
        },
      },
      {
        columnId: "food",
        field: "usdaPresenceFilter",
        kind: "presence",
        placeholder: "Filter USDA...",
        options: [
          { value: "has", label: "Has USDA key", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "image",
        field: "imagePresenceFilter",
        kind: "presence",
        placeholder: "Filter images...",
        options: [
          { value: "has", label: "Has image", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "inventoryMultiplicity",
        field: "inventoryMultiplicity",
        kind: "select",
        placeholder: "Filter inventory multiplicity...",
        options: [
          {
            value: "duplicate_within_placement",
            label: "Duplicate within placement",
          },
        ],
      },
      {
        columnId: "kitAccounting",
        field: "kitAccounting",
        kind: "select",
        placeholder: "Filter kit accounting...",
        options: [{ value: "double_counted", label: "Counted twice" }],
      },
      {
        columnId: "ownershipReconciliation",
        field: "ownershipReconciliation",
        kind: "select",
        placeholder: "Filter ownership reconciliation...",
        options: [
          {
            value: "disposed_still_on_hand",
            label: "Disposed but still on hand",
          },
        ],
      },
      {
        columnId: "conversionCoverage",
        field: "conversionCoverage",
        kind: "select",
        placeholder: "Filter conversion coverage...",
        options: [{ value: "partial", label: "Partial coverage" }],
      },
      {
        columnId: "conversionTopology",
        field: "conversionTopology",
        kind: "select",
        placeholder: "Filter conversion topology...",
        options: [{ value: "islanded", label: "Islanded mappings" }],
      },
      {
        columnId: "unitMappingQuality",
        field: "unitMappingPresenceFilter",
        kind: "presence",
        placeholder: "Filter mappings...",
        options: [
          { value: "has", label: "Has mappings", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "stockTracked",
        field: "stockTrackedPresenceFilter",
        kind: "presence",
        placeholder: "Filter stock tracking...",
        deriveSchema: true,
        schemaDescription:
          "Filter to products whose stockTracked decision is undecided (none) or has been made either way (has).",
        stored: true,
        options: [
          { value: "none", label: "Undecided" },
          { value: "has", label: "Reviewed" },
        ],
      },
      {
        columnId: "components",
        field: "componentPresenceFilter",
        kind: "presence",
        placeholder: "Filter kits...",
        options: [
          { value: "has", label: "Is a kit" },
          { value: "none", label: "Not a kit" },
        ],
      },
      {
        columnId: "tags",
        field: "tagFilters",
        kind: "multiselect",
        placeholder: "Filter by tag...",
        optionsKey: "tags",
        deriveSchema: true,
        schemaDescription: "Match products carrying any of these tags",
        stored: { array: true },
        nullable: { field: "tagsPresenceFilter", label: "tags" },
      },
      {
        columnId: "related:product.vendors",
        field: "vendorId",
        urlKey: "related-vendor",
        kind: "idMulti",
        placeholder: "Filter by vendor...",
        optionsKey: "productVendors",
        brandRef: { entity: "vendor" },
        nullable: { field: "vendorPresenceFilter", label: "vendor" },
      },
      {
        columnId: "related:product.projects",
        field: "projectId",
        urlKey: "related-project",
        kind: "idMulti",
        placeholder: "Filter by project...",
        optionsKey: "project",
        brandRef: { entity: "project" },
        nullable: { field: "projectPresenceFilter", label: "project" },
      },
      {
        columnId: "related:product.usedOnProjects",
        field: "usedOnProjectSearch",
        urlKey: "related-usedOnProject",
        kind: "text",
        placeholder: "Search related used on projects...",
      },
      {
        // Components of a kit: products on the kit's `ProductComponent` rows.
        columnId: "kitId",
        kind: "idMulti",
        placeholder: "Filter by kit...",
        brandRef: { entity: "product" },
        urlOnly: true,
      },
      {
        columnId: "usedOnProjectId",
        kind: "idMulti",
        placeholder: "Filter by related used on projects id...",
        brandRef: { entity: "project" },
        urlOnly: true,
      },
      {
        columnId: "usedOnProjectPresenceFilter",
        kind: "presence",
        placeholder: "Filter related used on projects presence...",
        urlOnly: true,
      },
      {
        columnId: "related:product.purchases",
        field: "purchaseId",
        urlKey: "related-purchase",
        kind: "idMulti",
        placeholder: "Filter by purchase...",
        optionsKey: "productPurchases",
        brandRef: { entity: "purchase" },
        nullable: { field: "purchasePresenceFilter", label: "purchase" },
      },
      {
        columnId: "related:product.expenses",
        field: "expenseSearch",
        urlKey: "related-expense",
        kind: "text",
        placeholder: "Search related expenses...",
      },
      {
        columnId: "expenseId",
        kind: "idMulti",
        placeholder: "Filter by related expenses id...",
        urlOnly: true,
      },
      {
        columnId: "expensePresenceFilter",
        kind: "presence",
        placeholder: "Filter related expenses presence...",
        urlOnly: true,
      },
      {
        columnId: "related:product.inventory",
        field: "relatedInventorySearch",
        urlKey: "related-relatedInventory",
        kind: "text",
        placeholder: "Search related inventory...",
      },
      {
        columnId: "relatedInventoryId",
        kind: "idMulti",
        placeholder: "Filter by related inventory id...",
        urlOnly: true,
      },
      {
        columnId: "relatedInventoryPresenceFilter",
        kind: "presence",
        placeholder: "Filter related inventory presence...",
        urlOnly: true,
      },
      {
        columnId: "related:product.wishes",
        field: "wishSearch",
        urlKey: "related-wish",
        kind: "text",
        placeholder: "Search related wishlist candidates...",
      },
      {
        columnId: "wishId",
        kind: "idMulti",
        placeholder: "Filter by related wishlist candidates id...",
        urlOnly: true,
      },
      {
        columnId: "wishPresenceFilter",
        kind: "presence",
        placeholder: "Filter related wishlist candidates presence...",
        urlOnly: true,
      },
      {
        columnId: "related:product.tasks",
        kind: "range",
        wire: {
          kind: "range",
          from: "taskDueFrom",
          to: "taskDueTo",
          presence: "taskPresenceFilter",
        },
        placeholder: "Filter tasks...",
        options: [
          { value: "has", label: "Has task", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "open", label: "Has open task" },
          {
            value: "not_started",
            label: "Not started",
            color: "var(--chart-neutral)",
          },
          { value: "later", label: "Later", color: "var(--chart-2)" },
          {
            value: "in_progress",
            label: "In progress",
            color: "var(--chart-1)",
          },
          {
            value: "blocked",
            label: "Blocked",
            color: "var(--chart-negative)",
          },
          { value: "done", label: "Done", color: "var(--chart-positive)" },
          { value: "overdue", label: "Overdue" },
          { value: "week", label: "Due this week" },
          { value: "30d", label: "Due in 30 days" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveProductTaskFilter",
        },
      },
      {
        columnId: "taskId",
        kind: "idMulti",
        placeholder: "Filter by related tasks id...",
        urlOnly: true,
      },
      {
        columnId: "related:product.meals",
        field: "mealSearch",
        urlKey: "related-meal",
        kind: "text",
        placeholder: "Search related meals...",
      },
      {
        columnId: "mealId",
        kind: "idMulti",
        placeholder: "Filter by related meals id...",
        urlOnly: true,
      },
      {
        columnId: "mealPresenceFilter",
        kind: "presence",
        placeholder: "Filter related meals presence...",
        urlOnly: true,
      },
      {
        columnId: "related:product.eaters",
        field: "eaterSearch",
        urlKey: "related-eater",
        kind: "text",
        placeholder: "Search related eaters...",
      },
      {
        columnId: "eaterId",
        kind: "idMulti",
        placeholder: "Filter by related eaters id...",
        urlOnly: true,
      },
      {
        columnId: "eaterPresenceFilter",
        kind: "presence",
        placeholder: "Filter related eaters presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "ingredient",
      label: "Ingredient",
      target: "ingredient",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Product.ingredientId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Product.ingredientId", direction: "incoming" }],
      },
    },
    {
      key: "grows-ingredient",
      label: "Grows ingredient",
      target: "ingredient",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Product.growsIngredientId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Product.growsIngredientId", direction: "incoming" }],
      },
    },
    {
      key: "plantings",
      label: "Plantings",
      target: "planting",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Planting.sourceProductId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Planting.sourceProductId", direction: "outgoing" }],
      },
    },
    {
      key: "project-uses",
      label: "Used on projects",
      target: "project",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "ProjectToolUsage.productId", direction: "incoming" },
          { edge: "ProjectToolUsage.projectId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "ProjectToolUsage.projectId", direction: "incoming" },
          { edge: "ProjectToolUsage.productId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "vendors",
      label: "Vendors",
      target: "vendor",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "Expense.productId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "outgoing" },
          { edge: "Purchase.vendorId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Purchase.vendorId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "incoming" },
          { edge: "Expense.productId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "purchased-projects",
      label: "Projects",
      target: "project",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "Expense.productId", direction: "incoming" },
          { edge: "Expense.projectId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Expense.projectId", direction: "incoming" },
          { edge: "Expense.productId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "purchases",
      label: "Purchases",
      target: "purchase",
      cardinality: "many",
      sourceKey: "expense",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "Expense.productId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Expense.purchaseId", direction: "incoming" },
          { edge: "Expense.productId", direction: "outgoing" },
        ],
      },
      sources: [
        {
          key: "explicit",
          label: "Explicit purchase link",
          provenance: {
            kind: "local-path",
            steps: [
              { edge: "PurchaseProduct.productId", direction: "incoming" },
              {
                edge: "PurchaseProduct.purchaseId",
                direction: "outgoing",
              },
            ],
          },
          inverse: {
            steps: [
              { edge: "PurchaseProduct.purchaseId", direction: "incoming" },
              { edge: "PurchaseProduct.productId", direction: "outgoing" },
            ],
          },
        },
      ],
    },
    {
      key: "expenses",
      label: "Expenses",
      target: "expense",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Expense.productId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Expense.productId", direction: "outgoing" }],
      },
    },
    {
      key: "inventory",
      label: "Inventory",
      target: "inventory",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "InventoryEntry.productId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "InventoryEntry.productId", direction: "outgoing" }],
      },
    },
    {
      key: "tasks",
      label: "Tasks",
      target: "task",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Task.subjectProductId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Task.subjectProductId", direction: "outgoing" }],
      },
    },
    {
      key: "meals",
      label: "Eaten at meals",
      target: "meal",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealFoodEntry.productId", direction: "incoming" },
          { edge: "MealFoodEntry.mealId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "MealFoodEntry.mealId", direction: "incoming" },
          { edge: "MealFoodEntry.productId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "eaters",
      label: "Eaten by",
      target: "ledgerParty",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealFoodEntry.productId", direction: "incoming" },
          { edge: "MealFoodEntry.ledgerPartyId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "MealFoodEntry.ledgerPartyId", direction: "incoming" },
          { edge: "MealFoodEntry.productId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "wishes",
      label: "Wishlist candidates",
      target: "wish",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "WishCandidate.productId", direction: "incoming" },
          { edge: "WishCandidate.wishId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "WishCandidate.wishId", direction: "incoming" },
          { edge: "WishCandidate.productId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "locations",
      label: "Serving as locations",
      target: "location",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Location.productId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Location.productId", direction: "outgoing" }],
      },
    },
    {
      key: "images",
      label: "Images",
      target: "image",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "ProductImage.productId", direction: "incoming" },
          { edge: "ProductImage.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "ProductImage.imageId", direction: "incoming" },
          { edge: "ProductImage.productId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "components",
      label: "Components",
      target: "product",
      cardinality: "many",
      sourceKey: "explicit",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "ProductComponent.parentProductId", direction: "incoming" },
          {
            edge: "ProductComponent.componentProductId",
            direction: "outgoing",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "ProductComponent.componentProductId",
            direction: "incoming",
          },
          { edge: "ProductComponent.parentProductId", direction: "outgoing" },
        ],
      },
      mutation: {
        source: "explicit",
        itemSchema: {
          module: "@cubby/schemas/common",
          export: "productComponentRelationItemSchema",
        },
        adapter: {
          module: "~/server/repo/product-components",
          export: "productComponentsRelationAdapter",
        },
        audiences: ["browser", "mcp"],
      },
    },
    {
      key: "containing-kits",
      label: "Containing kits",
      target: "product",
      cardinality: "many",
      sourceKey: "explicit",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "ProductComponent.componentProductId",
            direction: "incoming",
          },
          { edge: "ProductComponent.parentProductId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "ProductComponent.parentProductId", direction: "incoming" },
          {
            edge: "ProductComponent.componentProductId",
            direction: "outgoing",
          },
        ],
      },
    },
    {
      key: "usda-food",
      label: "USDA food",
      target: "usda-food",
      cardinality: "one",
      provenance: {
        kind: "external",
        system: "usda-api",
        sourceColumns: ["ProductExternalId.externalId", "Product.fdc_id"],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    timeline: "custom",
    images: {
      storage: "gallery",
      ingress: [
        { kind: "self", routeId: "product-self" },
        { kind: "createSelf", routeId: "product-new", enabled: true },
      ],
      routing: {
        category: "home",
        candidateFields: ["name", "manufacturer", "model"],
        temporalFields: [],
        lifecycleFilters: [],
        signals: {
          ocrFields: ["name", "manufacturer", "model"],
          classifierLabels: ["container"],
        },
        abstention: { minimumScore: 0.72, minimumMargin: 0.12 },
      },
    },
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: { fields: ["stockTracked"] },
    merge: true,
    operationOwners: { delete: "kernel", merge: "kernel" },
    mcp: [
      "get",
      "list",
      "search",
      "create",
      "update",
      "delete",
      "bulkUpdate",
      "merge",
    ],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: [
      {
        kind: "semantic",
        label: "Similar meaning",
        pair: "product_to_product",
        weight: 1,
        limit: 8,
      },
      {
        kind: "scalarOverlap",
        label: "Shared tag",
        pair: "product_to_product",
        column: "Product.tags",
        popularityCap: 24,
        scoring: "displayOnly",
      },
    ],
    mcpNames: { overrides: { list: "search_products" } },
    ports: {
      repository: {
        module: "~/server/repo/product/entity-adapter",
        export: "productEntityAdapter",
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
      timeline: {
        module: "~/server/repo/product/movement-timeline",
        export: "productTimeline",
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
