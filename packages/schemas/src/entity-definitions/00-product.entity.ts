import { defineEntity } from "./definition.js";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared/constants";
import { plainDate } from "@cubby/schemas/base-entity";
import {
  externalIdInputs,
  externalIdOut,
  gtin,
} from "@cubby/schemas/external-id";
import {
  imageShortcode,
  ingredientShortcode,
  plantShortcode,
  productShortcode,
  productCategoryShortcode,
} from "../identifier-fields.js";
import { productAttachmentImageOut } from "./field-primitives.js";
import { money } from "@cubby/schemas/money";
import { productLabelNutrition } from "@cubby/schemas/nutrition";
import {
  moneyNullable,
  positiveMoneyNullable,
  productPricingOut,
} from "@cubby/schemas/product-fields";
import { unitMappingInput } from "@cubby/schemas/unitmapping";
import { fdcId } from "@cubby/usda-schemas";
import { z } from "zod";
import { productCategorySummary } from "../product-category-fields";
export default defineEntity({
  key: "product",
  names: { singular: "Product", plural: "Products" },
  route: { basePath: "products" },
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
    icons: { phosphor: "Barcode", sfSymbol: "shippingbox", emoji: "📦" },
    detail: {
      relationFilterOverrides: {
        "project-uses": { descriptor: "usedToolId" },
        "purchased-projects": { descriptor: "purchasedProductId" },
        wishes: { descriptor: "related:wish.candidates" },
        components: { descriptor: "kitId" },
        "containing-kits": { descriptor: "componentId" },
      },
      omitRelations: {
        eaters:
          "Who ate it is per-portion meal data; the Meals table on this page shows each meal and its eaters.",
      },
      hero: {
        actionOverrides: ["edit", "addToInventory", "recordSale", "discard"],
      },
      additionalSectionOverrides: [
        { kind: "slot", id: "import-runs", title: "Item journey" },
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
          id: "tasks",
          title: "Tasks",
          relation: "tasks",
          filter: { descriptor: "subjectProductId" },
          columns: ["name", "status", "dueDate", "trade"],
          sort: { field: "dueDate", direction: "desc" },
        },
        {
          kind: "timeline",
          id: "movements",
          title: "Movements",
          placement: "full",
        },
        { kind: "slot", id: "labels", title: "Labels" },
        { kind: "slot", id: "nutrition", title: "Nutrition" },
        { kind: "slot", id: "unit-mappings", title: "Unit mappings" },
        { kind: "slot", id: "fits-with", title: "Fits with" },
        { kind: "slot", id: "cookbooks", title: "Cookbooks" },
        { kind: "slot", id: "recipe-appearances", title: "Appears in recipes" },
      ],
    },
    list: {
      shelfSubtitleOverride: ["price", "category"],
      actionOverrides: [
        "addToInventory",
        "discard",
        "setStockTracking",
        "printLabels",
        "merge",
        "delete",
      ],
      timeline: { fields: ["purchaseDate"] },
    },
    // Restructures the generated Apple editor too (`GenericEntityEditModel`
    // reads these `EditSection`s the same way) — intended, not a web-only
    // change. Photos & manuals has no `fields` entry: the shell's image
    // block and product's `media` presentation hook render it outside this
    // grouping (`entity-edit-dialog-content.tsx`, `editor-presentations.tsx`).
    edit: {
      sectionOverrides: [
        {
          id: "identity",
          title: "Identity",
          fields: ["name", "model", "manufacturer", "categoryId", "notes"],
        },
        {
          id: "names-and-tags",
          title: "Names & tags",
          fields: ["aliases", "tags"],
        },
        {
          id: "stock-and-price",
          title: "Stock & price",
          fields: ["expectedQuantity", "price", "stockTracked"],
        },
        {
          id: "identifiers",
          title: "Identifiers",
          fields: ["upc", "isbn", "externalIds"],
        },
        {
          id: "nutrition",
          title: "Nutrition",
          collapsed: true,
          fields: [
            "fdc_id",
            "labelNutrition",
            "ingredientId",
            "usdaUnavailable",
            "growsPlantId",
          ],
        },
        {
          id: "unit-conversions",
          title: "Unit conversions",
          fields: ["unitMappings"],
        },
      ],
    },
  },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text" },
        display: {
          list: true,
          detail: true,
          standard: "name",
        },
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
        description:
          "Compatibility or ecosystem tokens only — battery platform, mount, thread, size standard. Never the manufacturer, a classification word, or a path node; those belong in manufacturer/categoryId. `collection:*` entries are managed by Collections. Leave empty when nothing fits.",
        control: {
          kind: "specialized",
          renderer: "product-tags",
          suggest: {
            basis: ["manufacturer", "categoryId", "aliases"],
            mode: "prune",
          },
        },
        display: {
          list: true,
          detail: true,
          listHidden: true,
          renderer: { detail: "product-tags" },
        },
        validation: {
          read: z.array(z.string()),
          create: z
            .array(z.string())
            .default([])
            .describe(
              "Compatibility or ecosystem tokens only — battery platform, mount, thread, size standard. Never the manufacturer, a classification word, or a path node; those belong in manufacturer/categoryId. `collection:*` entries are managed by Collections. Leave empty when nothing fits.",
            ),
          update: z
            .array(z.string())
            .optional()
            .describe(
              "Compatibility or ecosystem tokens only — battery platform, mount, thread, size standard. Never the manufacturer, a classification word, or a path node; those belong in manufacturer/categoryId. `collection:*` entries are managed by Collections. Leave empty when nothing fits.",
            ),
        },
      },
      {
        key: "upc",
        kind: "text",
        nullable: true,
        control: { kind: "specialized", renderer: "upc-lookup", width: "half" },
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
        control: { kind: "text", width: "half" },
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
        control: { kind: "specialized", renderer: "usda-food" },
        display: {
          list: true,
          detail: true,
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
        control: { kind: "text", width: "half" },
        display: {
          list: true,
          detail: true,
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
        control: { kind: "text", width: "half" },
        display: {
          list: true,
          detail: true,
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
        control: { kind: "textarea" },
        display: {
          list: true,
          detail: true,
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
        control: { kind: "number", width: "half" },
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
        key: "categoryId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "productCategory" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: {
            basis: [
              "name",
              "manufacturer",
              "model",
              "notes",
              "classificationEvidence",
            ],
          },
        },
        display: {
          list: true,
          detail: true,
          width: "md",
          renderer: { detail: "product-category" },
          mobile: { slot: "subtitle", priority: 30 },
        },
        validation: {
          read: productCategoryShortcode.nullable(),
          create: productCategoryShortcode.nullable().optional(),
          update: productCategoryShortcode.nullable().optional(),
        },
      },
      {
        key: "category",
        kind: "json",
        nullable: true,
        validation: {
          read: productCategorySummary.nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "classificationEvidence",
        kind: "text",
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "itemImageCount",
        kind: "number",
        validation: {
          read: z.number().int().nonnegative(),
          create: null,
          update: null,
        },
      },
      {
        key: "labelImageCount",
        kind: "number",
        validation: {
          read: z.number().int().nonnegative(),
          create: null,
          update: null,
        },
      },
      {
        key: "ingredientId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "ingredient" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          detail: true,
          renderer: { detail: "product-ingredient" },
        },
        validation: {
          read: null,
          create: ingredientShortcode.nullable().optional(),
          update: ingredientShortcode.nullable().optional(),
        },
      },
      {
        key: "growsPlantId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "plant" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true },
        validation: {
          read: plantShortcode.nullable(),
          create: plantShortcode.nullable().optional(),
          update: plantShortcode.nullable().optional(),
        },
      },
      {
        key: "price",
        kind: "number",
        nullable: true,
        // The detail distinguishes effective valuation from an entered price.
        labelOverride: "Valuation price",
        control: { kind: "number", renderer: "money", width: "half" },
        display: {
          list: true,
          detail: true,
          format: "currency",
        },
        explanation: {
          ruleId: "product.effective-valuation-price",
          description:
            "A manual valuation price wins; otherwise Cubby derives a per-unit price from live priced expenses and their recorded quantities.",
          resolver: "productValuation",
          projections: {
            list: "pricing.effectivePrice",
            detail: "pricing.effectivePrice",
            summary: "pricing.effectivePrice",
          },
          sourceDependencies: [
            { path: "price", label: "Manual valuation price" },
            {
              path: "pricing.derivedPrice",
              label: "Expense-derived unit price",
            },
            { path: "pricing.source", label: "Selected price source" },
            { path: "pricing.partial", label: "Incomplete expense coverage" },
          ],
          actions: ["editSource"],
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
        control: { kind: "specialized", renderer: "unit-mappings" },
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
        // No `display` — same as `unitMappings`, this keeps the generic
        // detail/form renderer from touching it; a bespoke section owns the
        // UI. Unlike `unitMappings` this has a real `readKey`/`read` schema
        // (it's a physical Product column, not a synthesized child-table
        // projection), so it still reaches `productTopLevelFields` (the
        // output roster) for costing/API consumers.
        control: { kind: "specialized", renderer: "label-nutrition" },
        validation: {
          read: productLabelNutrition.nullable(),
          create: productLabelNutrition.nullable().optional(),
          update: productLabelNutrition.nullable().optional(),
        },
      },
      {
        key: "externalIds",
        // Stays `text-array`: the field kind only gates the pruning
        // (`control.suggest.mode: "prune"`) and section-coverage machinery,
        // neither of which cares that the array holds objects rather than
        // strings here — the `external-ids` renderer owns the real
        // `ExternalIdInput[]` shape end to end.
        kind: "text-array",
        control: { kind: "specialized", renderer: "external-ids" },
        provenance: {
          kind: "relation",
          sources: [{ label: "Product identifiers" }],
        },
        explanation: {
          ruleId: "product.external-identifiers",
          description:
            "External IDs are the current live identifier records attached to this product, with their source and canonical display value preserved.",
          readPath: "externalIds",
          sourceDependencies: [
            { path: "externalIds", label: "Product identifier records" },
          ],
        },
        display: {
          list: true,
          detail: true,
          renderer: { detail: "product-external-ids" },
          listHidden: true,
          width: "md",
          mobile: { slot: "meta", priority: 85 },
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
        display: { list: true, listHidden: true },
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
        control: { kind: "checkbox" },
        display: {
          list: true,
          width: "sm",
          listHidden: true,
        },
        validation: {
          read: z.boolean().nullable(),
          create: z.boolean().nullable().optional(),
          update: z.boolean().nullable().optional(),
        },
      },
      {
        // No editor `control`: the generic dialog shell renders the shared
        // photo-capture field itself for any intent whose roster includes
        // this key (`entity-edit-dialog-content.tsx`) — same convention as
        // meal/location's `pendingImageIds`.
        key: "pendingImageIds",
        kind: "identifier",
        reference: { entity: "image", multiple: true },
        validation: {
          read: null,
          create: z.array(imageShortcode).optional(),
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "pendingImagePurposes",
        kind: "json",
        validation: {
          read: null,
          create: z
            .record(imageShortcode, z.enum(["item", "label"]))
            .optional(),
          update: z
            .record(imageShortcode, z.enum(["item", "label"]))
            .optional(),
        },
      },
      {
        key: "removeImageIds",
        kind: "identifier",
        reference: { entity: "image", multiple: true },
        validation: {
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "imageOrder",
        kind: "text",
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
        display: {
          detail: true,
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
        display: {
          list: true,
          detail: true,
          width: "sm",
          renderer: { detail: "product-primary-gtin" },
        },
        provenance: {
          kind: "derived",
          sources: [{ label: "Product identifiers" }],
        },
        explanation: {
          ruleId: "product.primary-gtin",
          description:
            "The primary barcode is selected from this product's normalized external identifiers.",
          readPath: "primaryGtin",
          sourceDependencies: [
            { path: "externalIds", label: "Product identifiers" },
          ],
          actions: ["editSource"],
        },
        validation: {
          read: gtin.nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "labelImages",
        kind: "json",
        validation: {
          read: z.array(productAttachmentImageOut),
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
          sources: [{ entity: "image", relation: "images" }],
        },
        explanation: {
          ruleId: "product.images",
          description:
            "Product images are the current live Image attachments in canonical attachment order; list and summary surfaces use the same selected images through the display-image projection.",
          projections: {
            list: "displayImages",
            detail: "images",
            summary: "displayImages",
          },
          sourceDependencies: [
            { path: "displayImages", label: "Selected product images" },
          ],
        },
        validation: {
          read: z.array(productAttachmentImageOut),
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
        key: "unitPrice",
        kind: "json",
        nullable: true,
        provenance: {
          kind: "derived",
          sources: [{ label: "Product price and unit mappings" }],
        },
        explanation: {
          ruleId: "product.unit-price",
          description:
            "Comparable unit price converts one natural unit through the product's complete current conversion graph, including label or USDA-derived mappings and the effective price edge.",
          resolver: "productValuation",
          projections: { list: "unitPrice", summary: "unitPrice" },
          sourceDependencies: [
            {
              path: "pricing.effectivePrice",
              label: "Effective product price",
            },
            {
              path: "unitPriceMappings",
              label: "Complete unit conversion graph",
            },
          ],
        },
      },
      {
        key: "food",
        kind: "json",
        nullable: true,
        provenance: {
          kind: "derived",
          sources: [{ entity: "usda-food" }],
        },
        explanation: {
          ruleId: "product.usda-food",
          description:
            "USDA food is the current lookup result for this product's explicit FDC identifier or normalized primary barcode.",
          projections: { list: "food", summary: "food" },
          sourceDependencies: [
            { path: "fdc_id", label: "Explicit FDC identifier" },
            { path: "primaryGtin", label: "Primary normalized barcode" },
          ],
        },
      },
      {
        key: "modelPresence",
        kind: "boolean",
        provenance: { kind: "derived", sources: [{ entity: "product" }] },
        explanation: {
          ruleId: "product.model-presence",
          description:
            "Model present reports whether this product has a non-empty model value.",
          projections: { list: "modelPresence", summary: "modelPresence" },
          sourceDependencies: [{ path: "model", label: "Product model" }],
        },
      },
      {
        key: "upcPresence",
        kind: "boolean",
        provenance: {
          kind: "derived",
          sources: [{ label: "Product identifiers" }],
        },
        explanation: {
          ruleId: "product.upc-presence",
          description:
            "UPC present reports whether the product has a primary normalized barcode.",
          projections: { list: "upcPresence", summary: "upcPresence" },
          sourceDependencies: [
            { path: "externalIds", label: "Product identifiers" },
          ],
        },
      },
      {
        key: "notesPresence",
        kind: "boolean",
        provenance: { kind: "derived", sources: [{ entity: "product" }] },
        explanation: {
          ruleId: "product.notes-presence",
          description:
            "Notes present reports whether this product has non-empty notes.",
          projections: { list: "notesPresence", summary: "notesPresence" },
          sourceDependencies: [{ path: "notes", label: "Product notes" }],
        },
      },
      // Read-only, list-only computed values carried on `ProductListItem`
      // (never a stored `Product` column) — each needs the override
      // `productlist.tsx` supplies, per docs/entities.md's "declaration
      // wins" rule.
      {
        key: "expenseTotal",
        kind: "number",
        display: {
          list: true,
          listHidden: true,
          width: "sm",
          format: "signedCurrency",
          mobile: { slot: "trailing", priority: 5 },
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense", relation: "expenses" }],
        },
        explanation: {
          ruleId: "product.net-expense-basis",
          description:
            "Net basis is the sum of cost across this product's live expenses, including negative refund lines.",
          projections: { list: "expenseTotal", summary: "expenseTotal" },
          sourceDependencies: [
            { path: "expenseCount", label: "Live expense count" },
          ],
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
        display: {
          list: true,
          width: "sm",
          mobile: { slot: "meta", priority: 44 },
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "product", relation: "components" }],
        },
        explanation: {
          ruleId: "product.component-count",
          description:
            "The component count is the number of live component relationships for this product.",
          projections: { list: "componentCount", summary: "componentCount" },
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
        // Nested under `quantityLedger.locationCount` on the list row — no
        // flat readKey can reach it, so this needs the override
        // `productlist.tsx` supplies.
        display: { list: true },
        provenance: {
          kind: "derived",
          sources: [{ entity: "location", relation: "locations" }],
        },
        explanation: {
          ruleId: "product.in-service-location-count",
          description:
            "In service counts live locations whose installed product is this product.",
          resolver: "productQuantity",
          projections: {
            list: "quantityLedger.locationCount",
            summary: "quantityLedger.locationCount",
          },
          sourceDependencies: [
            {
              path: "quantityLedger.locationCount",
              label: "Installed location count",
            },
          ],
        },
      },
      {
        key: "ledgerExpectedQuantity",
        kind: "number",
        // Nested under `quantityLedger.expectedQuantity` on the list row.
        display: {
          list: true,
          listHidden: true,
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense", relation: "expenses" }],
        },
        explanation: {
          ruleId: "product.expected-quantity",
          description:
            "Expected quantity is the signed sum of product quantities on live expenses; incomplete quantity evidence is retained in the ledger status.",
          resolver: "productQuantity",
          projections: {
            list: "quantityLedger.expectedQuantity",
            summary: "quantityLedger.expectedQuantity",
          },
          sourceDependencies: [
            { path: "quantityLedger", label: "Expense quantity ledger" },
          ],
        },
      },
      {
        key: "quantityVariance",
        kind: "number",
        nullable: true,
        display: { list: true, listHidden: true },
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense", relation: "expenses" }],
        },
        explanation: {
          ruleId: "product.quantity-variance",
          description:
            "Variance is counted inventory minus expected expense-ledger quantity when both quantities are known.",
          resolver: "productQuantity",
          readPath: "quantityVariance",
          sourceDependencies: [
            { path: "onHandUnits", label: "Counted inventory units" },
            {
              path: "quantityLedger.expectedQuantity",
              label: "Expected ledger quantity",
            },
          ],
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
        display: {
          list: true,
          width: "sm",
          format: "plainDate",
          mobile: { slot: "meta", priority: 55 },
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense", relation: "expenses" }],
        },
        explanation: {
          ruleId: "product.acquisition-date",
          description:
            "Purchase date is the earliest acquisition date among this product's live positive-quantity expenses.",
          projections: { list: "purchaseDate", summary: "purchaseDate" },
          sourceDependencies: [
            { path: "expenseCount", label: "Live expense count" },
          ],
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
        display: {
          list: true,
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense", relation: "expenses" }],
        },
        explanation: {
          ruleId: "product.expense-count",
          description:
            "Expense count is the number of live expenses linked to this product.",
          projections: { list: "expenseCount", summary: "expenseCount" },
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
          listHidden: true,
          mobile: { slot: "trailing", priority: 0 },
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "inventory", relation: "inventory" }],
        },
        explanation: {
          ruleId: "product.on-hand-units",
          description:
            "On-hand units are the sum of live inventory quantities after applying each entry's unit mapping; unknown mappings make the result unavailable.",
          resolver: "productQuantity",
          readPath: "onHandUnits",
          sourceDependencies: [
            { path: "inventoryEntry", label: "Live inventory entries" },
          ],
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
      { key: "shortcode", kind: "text" },
      {
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
      },
    ],
    storage: [
      {
        key: "id",
        specialized: "primary-key:ProductId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      {
        key: "aliases",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      "manufacturer",
      "fdc_id",
      "model",
      "expectedQuantity",
      "notes",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
      { key: "ingredientId", reference: "ingredient" },
      { key: "growsPlantId", reference: "plant" },
      { key: "categoryId", reference: "productCategory" },
      {
        key: "tags",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      { key: "price", specialized: "real" },
      "usdaUnavailable",
      "stockTracked",
      { key: "labelNutrition", specialized: "json:labelNutrition" },
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
      "categoryId",
      "ingredientId",
      "growsPlantId",
      "price",
      "unitMappings",
      "labelNutrition",
      "externalIds",
      "usdaUnavailable",
      "stockTracked",
      "pendingImageIds",
      "pendingImagePurposes",
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
      "categoryId",
      "ingredientId",
      "growsPlantId",
      "price",
      "unitMappings",
      "labelNutrition",
      "externalIds",
      "usdaUnavailable",
      "stockTracked",
      "pendingImageIds",
      "pendingImagePurposes",
      "removeImageIds",
      "imageOrder",
    ],
    bulk: ["stockTracked"],
    audit: [
      "name",
      "aliases",
      "tags",
      "manufacturer",
      "categoryId",
      "externalIds",
      "fdc_id",
      "model",
      "expectedQuantity",
      "ingredientId",
      "growsPlantId",
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
        "categoryId",
        "fdc_id",
        "price",
        "notes",
        "location",
        "ingredient",
        "expenseTotal",
        "expenseCount",
        "ledgerExpectedQuantity",
        "quantityVariance",
        "purchaseDate",
        "related:product.projects",
        "related:product.vendors",
        "related:product.purchases",
      ],
      computed: [
        "categoryId",
        "location",
        "ingredient",
        "expenseTotal",
        "expenseCount",
        "quantityVariance",
        "purchaseDate",
        "related:product.projects",
        "related:product.vendors",
        "related:product.purchases",
      ],
      groupable: ["categoryId"],
    },
    intents: {
      fields: {
        // The list's "New" dialog and the picker's "Create product" open
        // `capture`; for product that is the whole editor (as the retired
        // create page was), so classification, ingredient links, and unit
        // conversions can be set at creation instead of a second edit.
        capture: [
          "name",
          "aliases",
          "tags",
          "manufacturer",
          "model",
          "categoryId",
          "ingredientId",
          "growsPlantId",
          "upc",
          "isbn",
          "fdc_id",
          "expectedQuantity",
          "price",
          "stockTracked",
          "unitMappings",
          "labelNutrition",
          "externalIds",
          "usdaUnavailable",
          "notes",
          "pendingImageIds",
          "pendingImagePurposes",
          "removeImageIds",
          "imageOrder",
        ],
        full: [
          "name",
          "aliases",
          "tags",
          "manufacturer",
          "model",
          "categoryId",
          "ingredientId",
          "growsPlantId",
          "upc",
          "isbn",
          "fdc_id",
          "expectedQuantity",
          "price",
          "stockTracked",
          "unitMappings",
          "labelNutrition",
          "externalIds",
          "usdaUnavailable",
          "notes",
          "pendingImageIds",
          "pendingImagePurposes",
          "removeImageIds",
          "imageOrder",
        ],
        // The compact "Show product details" panel on quick-inventory-add
        // (a bespoke multi-entity form, not the generic editor): everything
        // `full` covers except identity (name/manufacturer render outside
        // this panel) and the fields owned by the shell's own image block.
        quickDetails: [
          "model",
          "notes",
          "categoryId",
          "upc",
          "isbn",
          "fdc_id",
          "expectedQuantity",
          "ingredientId",
          "unitMappings",
        ],
        identity: ["name", "aliases", "manufacturer", "model", "categoryId"],
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
      "categoryId",
      "growsPlantId",
      "images",
      "externalIds",
      "price",
      "pricing",
      "usdaUnavailable",
      "stockTracked",
      "labelNutrition",
      "createdAt",
      "updatedAt",
      "category",
      "itemImageCount",
      "labelImageCount",
      "labelImages",
      "classificationEvidence",
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
        columnId: "categoryFeature",
        field: "categoryFeatureFilter",
        kind: "multiselect",
        placeholder: "Filter category family...",
        optionsKey: "productCategoryFamilies",
        nullable: { field: "categoryPresenceFilter", label: "classification" },
      },
      {
        columnId: "categoryId",
        urlKey: "category",
        field: "categoryFilter",
        kind: "idMulti",
        placeholder: "Filter classification...",
        brandRef: { entity: "productCategory" },
        optionsKey: "productCategories",
        nullable: { field: "categoryPresenceFilter", label: "classification" },
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
        columnId: "growsPlant",
        field: "growsPlantIdFilter",
        kind: "idMulti",
        placeholder: "Filter by plant grown...",
        brandRef: { entity: "plant" },
      },
      {
        columnId: "expenseCount",
        urlKey: "expenses",
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
        columnId: "ledgerExpectedQuantity",
        field: "expectedQuantity",
        urlKey: "expectedQuantity",
        wire: {
          kind: "range",
          from: "expectedQuantityMin",
          to: "expectedQuantityMax",
        },
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
        // Kits containing a component: parents on its `ProductComponent` rows.
        columnId: "componentId",
        kind: "idMulti",
        placeholder: "Filter by component...",
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
        brandRef: { entity: "expense" },
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
        brandRef: { entity: "inventory" },
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
        brandRef: { entity: "wish" },
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
        brandRef: { entity: "task" },
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
        brandRef: { entity: "meal" },
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
        brandRef: { entity: "ledgerParty" },
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
      key: "category",
      label: "Classification",
      target: "productCategory",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Product.categoryId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Product.categoryId", direction: "incoming" }],
      },
    },
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
      key: "grows-plant",
      label: "Grows plant",
      target: "plant",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Product.growsPlantId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Product.growsPlantId", direction: "incoming" }],
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
          { edge: "EntityAttachment.subjectEntityId", direction: "incoming" },
          { edge: "EntityAttachment.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "EntityAttachment.imageId", direction: "incoming" },
          { edge: "EntityAttachment.subjectEntityId", direction: "outgoing" },
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
    // Identity carries the weight: `dataQualityScore asc` is the enrichment
    // worklist (it replaced the bespoke `identity_strength` sort), so a
    // product with no manufacturer or external id sorts before one that
    // only lacks a photo.
    dataQuality: {
      exceptions: true,
      listOrder: 7,
      checks: [
        {
          id: "product_manufacturer",
          facet: "identity",
          weight: 3,
          label: "Manufacturer",
          message: "Manufacturer is not recorded.",
        },
        {
          id: "product_external_id",
          facet: "identity",
          weight: 3,
          label: "External ID",
          message:
            "No barcode, ASIN, or other external identifier is recorded.",
        },
        {
          id: "product_category",
          facet: "identity",
          weight: 2,
          label: "Category",
          message: "Product category is not recorded.",
        },
        {
          id: "product_model",
          facet: "identity",
          weight: 2,
          label: "Model",
          message: "Manufacturer model is not recorded.",
        },
        {
          id: "product_price",
          facet: "ledger",
          weight: 2,
          label: "Price (stocked)",
          message: "Stocked product has no price to value it by.",
        },
        {
          id: "product_image",
          facet: "provenance",
          label: "No image (stocked)",
          message: "No product image is attached.",
        },
        {
          id: "amazon_asin",
          facet: "provenance",
          label: "Amazon ASIN",
          message: "Amazon-linked product has no Amazon ASIN.",
        },
        {
          id: "product_unpurchased",
          facet: "provenance",
          label: "Not purchased",
          message: "Stocked product has no Purchase or acquiring Expense.",
        },
        {
          id: "duplicate_external_id",
          facet: "integrity",
          kind: "defect",
          label: "Duplicate external ID",
          message:
            "An exact external identifier is shared with another live product.",
        },
      ],
    },
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
      timeline: {
        module: "~/server/repo/product/movement-timeline",
        export: "productTimeline",
      },
      search: "document",
    },
  },
});
