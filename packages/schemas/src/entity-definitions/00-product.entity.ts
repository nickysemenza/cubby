import { productChildren } from "../child-tables/product.js";
import { defineEntity } from "./definition.js";
import { PRODUCT_UNCLASSIFIED_GROUP_KEY } from "../group-keys";
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
import { optionalFieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import { productLabelNutrition } from "@cubby/schemas/nutrition";
import {
  moneyNullable,
  positiveMoneyNullable,
  productPricingOut,
} from "@cubby/schemas/product-fields";
import { unitMappingInput } from "@cubby/schemas/unitmapping";
import { fdcId } from "@cubby/usda";
import { FILTER_ANY, FILTER_NONE } from "../filter-sentinel-fields.js";
import { z } from "zod";
import { productCategorySummary } from "../product-category-fields";
import { productKindSchema } from "../product-fields";
import { labelField } from "./label-field";
import { selectControlOptions } from "./select-control-options";
export default defineEntity({
  key: "product",
  names: { singular: "Product", plural: "Products" },
  route: { basePath: "products" },
  table: "Product",
  children: productChildren,
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
      overviewSections: [
        "overview",
        "ownership",
        "notes",
        "labels",
        "stocked-at",
        "movements",
        "purchases",
        "expenses",
      ],
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
      // The generic "No products yet." reads oddly under a self-relation
      // whose target happens to also be Product — say what's missing
      // instead of what type it is.
      emptyOverrides: {
        components: "This isn't a kit yet — no components added.",
        "containing-kits": "Not used as a component in any kit yet.",
      },
      hero: {
        actionOverrides: ["edit", "addToInventory", "recordSale", "discard"],
      },
      additionalSectionOverrides: [
        { kind: "slot", id: "ownership", title: "Ownership & evidence" },
        { kind: "slot", id: "runs", title: "Enrichment history" },
        {
          kind: "fields",
          id: "nutrition-links",
          title: "Nutrition sources",
          fields: ["fdc_id", "ingredientId"],
        },
        {
          kind: "fields",
          id: "notes",
          title: "Notes",
          fields: ["notes"],
          placement: "full",
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
        { kind: "slot", id: "fits-with", title: "Similar products" },
        { kind: "slot", id: "cookbooks", title: "Cookbooks" },
        { kind: "slot", id: "recipe-appearances", title: "Appears in recipes" },
      ],
    },
    list: {
      savedViews: [
        {
          id: "shelf-disagrees",
          label: "Shelf disagrees",
          description: "Stocked products whose count differs from the ledger",
          // Server-scoped to products that are BOTH stocked and in the ledger —
          // see `quantityVarianceFilter` in the product repo. Neither half is
          // optional: without "stocked" this is dominated by things correctly sold
          // off, and without "in the ledger" by stocked products that have no
          // product-linked Expense at all (a provenance gap, not a counting one).
          //
          // A broad shelf-reconciliation worklist: it never converges to zero,
          // which is why it lives here rather than as a Problems section. The
          // narrower acquisition-history gap — more recorded units gone than
          // arrived — is surfaced separately as `negativeExpectedQuantity`.
          filters: [{ id: "quantityVariance", value: "mismatched" }],
          // Snapshots this product set, then recounts every location holding it —
          // full bins, so the pass confirms the whole shelf rather than one row.
          flow: { kind: "recount-worklist", label: "Recount these" },
          // Both hidden by default on a table this wide, so the view has to reveal
          // them — otherwise it selects rows on a signal nothing on screen explains.
          // `servingAsLocations` joins them because a product can now be short
          // while sitting in no inventory row at all: eight 7-gal totes bought,
          // three in service as bins, five nowhere. Without the column the row
          // reads as a bare -5 with an empty Location cell.
          layout: {
            columnVisibility: {
              ledgerExpectedQuantity: true,
              quantityVariance: true,
              servingAsLocations: true,
            },
          },
        },
        {
          id: "unknown-quantities",
          label: "Missing quantities",
          description: "Products whose expense lines don't establish a count",
          // The data-entry backlog behind the `+N?` cue: a receipt that proves the
          // cost but not the count leaves the expected quantity understated, and
          // nothing infers one (a nullable quantity is never read as 1).
          filters: [{ id: "ledgerExpectedQuantity", value: "unknown" }],
          layout: {
            columnVisibility: { ledgerExpectedQuantity: true },
          },
        },
        {
          id: "unlocated",
          label: "Not on a shelf",
          description:
            "Bought, never sold, and held nowhere — not on a shelf, not a bin, not inside a kit",
          // The other half of `shelf-disagrees`, and the half that view cannot
          // reach: `quantityVarianceFilter` is scoped to products that are BOTH
          // stocked and in the ledger, and `onHandUnitsSql` returns NULL for a
          // zero-entry shelf — so a product the ledger says you own with nothing
          // on a shelf matches neither "mismatched" nor "matched". It needs no new
          // server predicate beyond `stockTracked`, only these filters combined.
          //
          // Converges by decision, not by category guessing: `stockTracked: null`
          // is the undecided worklist, so a product leaves this view the moment
          // it's reviewed — marked `false` (no shelf claim wanted: bananas,
          // software) or `true` (shelf records are kept). Without that filter
          // every consumable ever bought stayed "owned" here forever, because
          // inventory never auto-decrements (a tenet); with it, the view shrinks
          // as the operator works through the backlog instead of refilling on
          // every grocery purchase. Still sorted by price so the money surfaces
          // first while the backlog is large; `unlocated-durables` below is the
          // shortcut, not the answer.
          //
          // `servingAsLocations: none` is what keeps this DISJOINT from
          // `shelf-disagrees`. Presence has THREE forms — stock on a shelf, the bin
          // itself, and stock held by a kit's parts — and this view means none of
          // them. Without the second the HDX totes appeared here under "stocked
          // nowhere" while three of them were bins in daily use, and the same rows
          // showed in both views telling different stories.
          //
          // `components: none` is the third, and the same argument one step out. A
          // kit that has been split into a composition record keeps the Expense and
          // holds no stock of its own — the shelf claim moved to its parts — so a
          // decomposed kit is not "stocked nowhere", it is stocked as its
          // components. The parts are also the ACTIONABLE rows: an unstocked
          // component carries its own projected `expectedQuantity` (the kit's units
          // reach it through `productComponent`) and matches this view by itself, so
          // admitting the parent too reports one gap twice and less precisely.
          // Verified on production: all 25 kit parents leave, and every genuinely
          // unaccounted component stays.
          filters: [
            { id: "ledgerExpectedQuantity", value: "positive" },
            { id: "location", value: [FILTER_NONE] },
            { id: "servingAsLocations", value: "none" },
            { id: "stockTracked", value: "none" },
            { id: "components", value: "none" },
          ],
          sort: [{ id: "price", desc: true }],
          // A one-pass triage of exactly these rows: discard, stock, or park.
          flow: { kind: "shelf-triage", label: "Triage these" },
          // Every half of the signal: a filled Expected beside an empty Location,
          // not a bin, not a kit, still undecided on stock tracking.
          // `quantityVariance` is deliberately NOT revealed — on-hand units are
          // NULL for this entire cohort, so it renders `—` on every row, and a dash
          // reads as "unknown" when the actual fact is "none".
          layout: {
            columnVisibility: {
              ledgerExpectedQuantity: true,
              location: true,
              servingAsLocations: true,
              stockTracked: true,
              components: true,
            },
          },
        },
        {
          id: "unlocated-durables",
          label: "Durables not on a shelf",
          description:
            "Tools and storage the ledger says you own, stocked nowhere",
          // A fast path into `unlocated`, not an authority over it: same question,
          // narrowed to the categories whose members are objects you could go find.
          //
          // ⚠️ It has real false negatives, because `category` is a weak proxy for
          // durability. The disappearance that motivated both views — Milwaukee
          // PACKOUT wall plates, hooks and racks — is categorized `supplies` and
          // `hardware`, so none of it would appear here. Widening to those two
          // categories is not the fix: they also carry the screws and shop
          // consumables this view exists to exclude, and doing so lands you back at
          // ~1,600 rows. When a count here looks reassuring, check `unlocated`.
          filters: [
            { id: "ledgerExpectedQuantity", value: "positive" },
            { id: "location", value: [FILTER_NONE] },
            { id: "servingAsLocations", value: "none" },
            { id: "stockTracked", value: "none" },
            { id: "components", value: "none" },
            {
              id: "categoryFeature",
              value: ["tools", "tool-accessories", "storage"],
            },
          ],
          sort: [{ id: "price", desc: true }],
          layout: {
            columnVisibility: {
              ledgerExpectedQuantity: true,
              location: true,
              servingAsLocations: true,
              stockTracked: true,
              components: true,
              categoryId: true,
              categoryFeature: true,
            },
          },
        },
        {
          id: "consumed-on-projects",
          label: "Consumed on projects",
          description:
            "Bought for a project, stocked nowhere — likely built in",
          // A fast path into `unlocated`, not an authority over it — the same
          // relationship `unlocated-durables` has, aimed at the opposite half of
          // the backlog. Where that view narrows to things you could go find, this
          // one gathers the material that went INTO the house: the drainage
          // composite buried behind the foundation, the walnut plywood milled into
          // cabinets, the gas line in the ground.
          //
          // Project attachment is the signal, and it is EVIDENCE rather than proof.
          // The cohort is genuinely mixed — a whole Amazon order attributed to a
          // project drags its dog treats and socks along, and a Lutron dimmer sits
          // beside the wire nuts — so this view deliberately does not decide
          // anything. It sorts the backlog so the decision is cheap, and the row
          // still leaves only when `stockTracked` is answered or an InventoryEntry
          // appears. Blanket-sweeping what lands here is the mistake it exists to
          // make visible, not to automate.
          //
          // Costs no new server predicate: `FILTER_ANY` on the related-projects
          // column expands to `projectPresenceFilter: "has"`, which
          // `relatedWhereConditions` already implements generically.
          filters: [
            { id: "ledgerExpectedQuantity", value: "positive" },
            { id: "location", value: [FILTER_NONE] },
            { id: "servingAsLocations", value: "none" },
            { id: "stockTracked", value: "none" },
            { id: "components", value: "none" },
            { id: "related:product.projects", value: [FILTER_ANY] },
          ],
          sort: [{ id: "price", desc: true }],
          layout: {
            // `related:product.projects` is `defaultVisible: false` in the related
            // registry, and a filtered column that cannot be seen reads as an
            // unexplained row count.
            columnVisibility: {
              ledgerExpectedQuantity: true,
              location: true,
              servingAsLocations: true,
              stockTracked: true,
              components: true,
              "related:product.projects": true,
            },
          },
        },
        {
          id: "kits",
          label: "Kits",
          description: "Products made of other products",
          // A category, not a defect — so no `problem` key. Nothing here converges
          // to zero and nothing here is wrong; buying a combo kit is the normal
          // way these arrive.
          //
          // Earns a view because no other facet finds them: kit categories are
          // scattered across `hardware`, `tools`, `storage`, and `household`, since
          // a kit takes the category of what it contains.
          filters: [{ id: "components", value: "has" }],
          layout: {
            // `components` is the filtered column and must be revealed. `expected`
            // and `price` come along because a kit's own numbers are the ones that
            // project down to its parts — the kit keeps one Expense, and that row
            // is what gives every component its cost basis and its units.
            columnVisibility: {
              components: true,
              ledgerExpectedQuantity: true,
              price: true,
            },
          },
        },
        {
          id: "unpriced-stocked",
          label: "Stocked but unpriced",
          description: "On a shelf, with no price to value it by",
          // `product_price`'s own `expected` is exactly this pairing (placement
          // 'stock', not a `misc:` bucket) — see checks/product.ts. Unpriced stock
          // is invisible to the location valuation rollup: a null price yields a
          // null entry valuation and the rollup omits it.
          //
          // NARROWER than the old `location: FILTER_ANY` leg: that admitted any
          // placement (including `installed`), while the check's `hasStock` is
          // `placement = 'stock'` only. An installed, unpriced fixture no longer
          // appears here.
          filters: [{ id: "dataGaps", value: ["product_price"] }],
          problem: {
            key: "productsMissingPrice",
            title: "Stocked products with no price",
            description:
              "On a shelf but carrying no price, so they are silently missing from every location's value.",
            emptyMessage: "Every stocked product has a price.",
          },
          layout: {
            columnVisibility: { dataGaps: true, price: true, location: true },
          },
        },
        {
          id: "unpriced-buckets",
          label: "Unpriced buckets",
          description: "`misc:` piles on a shelf, which have no unit price",
          // Split from the view above rather than folded into it: a bucket is a
          // heterogeneous pile and is *expected* to be unpriced, so counting it as
          // a gap leaves that section permanently red. The per-location summary
          // makes the same split (`miscNoPrice`, not `missingPricing`).
          filters: [
            { id: "location", value: [FILTER_ANY] },
            { id: "price", value: "none-bucket" },
          ],
          problem: {
            key: "unvaluedBucketProducts",
            title: "Unvalued misc buckets",
            description:
              "Bucket rows on a shelf with no price. Pricing one is optional — it just makes its location's total less of an underestimate.",
            emptyMessage: "Every misc bucket carries a price.",
          },
          layout: {
            columnVisibility: { price: true, location: true },
          },
        },
        {
          id: "unmapped",
          label: "No way to cost it",
          description: "No price, no USDA key, and no unit mapping",
          // Every path to a cost or a conversion is absent at once: no price to
          // scale, no USDA key to look a food up by, no manual edge to convert
          // through. Any ONE of them would make the product usable, which is why
          // the three are AND-ed rather than reported separately.
          filters: [
            { id: "price", value: "none-real" },
            { id: "food", value: "none" },
            { id: "unitMappingQuality", value: "none" },
            { id: "categoryFeature", value: ["food", FILTER_NONE] },
          ],
          problem: {
            key: "productsWithoutMappings",
            title: "Products with no conversion path",
            description:
              "No price, no USDA key, and no unit mapping — nothing can cost or convert these, so any recipe using them is under-covered.",
            emptyMessage:
              "Every food product has at least one conversion path.",
          },
          layout: {
            columnVisibility: {
              price: true,
              food: true,
              unitMappingQuality: true,
              categoryId: true,
              categoryFeature: true,
            },
          },
        },
        {
          id: "over-exited",
          label: "Exit exceeds history",
          description:
            "Recorded exits exceed the available acquisition history",
          // This view is the `expectedQuantityMax: -1` worklist, and the detector
          // that separately re-derived the same predicate with a grouped HAVING is
          // gone.
          //
          // Deliberately LOOSER than "sold but still stocked", which keys on
          // disposal Purchases. Not an inconsistency — a different question. "Was
          // this sold off entirely?" treats a refund as innocent noise, which on
          // live data it usually is; "do the units balance?" treats a return of 8
          // outlet boxes as 8 real units going back to the store, and most negative
          // lines in this ledger are exactly that, sitting inside a Purchase that
          // nets positive. Requiring a disposal Purchase here missed most of the
          // exited units.
          //
          // The card reads `quantityLedger` off the list row, which carries the
          // unknown-quantity counts field-for-field. They change what the row
          // MEANS: unquantified acquisition lines are data-entry debt (the missing
          // count almost certainly explains the gap), while a fully quantified
          // ledger is a genuine contradiction. Reporting the bare number would
          // flatten those into the same red row.
          filters: [{ id: "ledgerExpectedQuantity", value: "negative" }],
          problem: {
            key: "negativeExpectedQuantity",
            title: "Exits exceed recorded acquisitions",
            description:
              "Recorded exits exceed recorded arrivals. Older acquisitions may predate the ledger, so review the available history before correcting a quantity.",
            emptyMessage:
              "No product has more recorded exits than acquisitions.",
          },
          layout: {
            columnVisibility: { ledgerExpectedQuantity: true },
          },
        },
      ],
      read: {
        media: [
          "images",
          "labelImages",
          "itemImageCount",
          "labelImageCount",
          "displayImages",
        ],
        quality: [
          "dataQuality",
          "classificationEvidence",
          "dataGaps",
          "modelPresence",
          "notesPresence",
        ],
        relations: [
          "categoryId",
          "growsPlantId",
          "category",
          "ingredient",
          "inventoryEntry",
          "externalIds",
          "unitMappings",
          "primaryGtin",
          "upcPresence",
        ],
        derived: [
          "price",
          "pricing",
          "fieldResolutions",
          "usdaUnavailable",
          "unitPrice",
          "unitPriceMappings",
          "food",
          "expenseCount",
          "componentCount",
          "expenseTotal",
          "purchaseDate",
          "quantityLedger",
          "onHandUnits",
          "quantityVariance",
          "ledgerExpectedQuantityLabel",
          "quantityVarianceLabel",
          "unitPriceLabel",
        ],
      },
      totalOverrides: [
        { id: "price", label: "Prices", keys: ["price"], format: "currency" },
        {
          id: "expenseTotal",
          label: "Expenses",
          keys: ["expenseTotal"],
          format: "currency",
        },
      ],
      shelfSubtitleOverride: ["price", "category"],
      actionOverrides: [
        "addToInventory",
        "discard",
        "bulkEdit",
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
          fields: [
            "expectedQuantity",
            "price",
            "stockTracked",
            "kind",
            "acquisitionOrigin",
          ],
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
        key: "acquisitionOrigin",
        kind: "enum",
        control: {
          kind: "select",
          options: [
            { value: "unknown", label: "Unclassified" },
            { value: "purchased", label: "Purchased" },
            { value: "gift", label: "Gift" },
            { value: "previously_owned", label: "Previously owned" },
          ],
        },
        display: { list: true, detail: true },
        validation: {
          read: z
            .enum(["unknown", "purchased", "gift", "previously_owned"])
            .default("unknown"),
          create: z
            .enum(["unknown", "purchased", "gift", "previously_owned"])
            .default("unknown"),
          update: z
            .enum(["unknown", "purchased", "gift", "previously_owned"])
            .optional(),
        },
      },
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
          labelPath: "tags[]",
          renderer: { list: "tag-links", detail: "product-tags" },
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
        // The create schema defaults a missing maker, but the form still
        // asks for one.
        control: { kind: "text", width: "half", required: true },
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
        key: "categoryFeature",
        kind: "text",
        nullable: true,
        labelOverride: "Category family",
        // The first node of the category path: the family a product rolls up to.
        display: {
          list: true,
          listHidden: true,
          readPath: "category.path[0].name",
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "productCategory", relation: "category" }],
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
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: {
            basis: ["name", "manufacturer", "categoryId", "notes"],
          },
        },
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
        resolution: {
          reset: { price: null },
          redundancy: "eligible",
        },
        explanation: {
          ruleId: "product.effective-valuation-price",
          description:
            "A manual valuation price wins; otherwise Cubby derives a per-unit price from live priced expenses and their recorded quantities.",
          projections: {
            list: "fieldResolutions.price.value",
            detail: "fieldResolutions.price.value",
            summary: "fieldResolutions.price.value",
          },
          sourceDependencies: [
            {
              path: "fieldResolutions.price.storedValue",
              label: "Manual valuation price",
            },
            {
              path: "fieldResolutions.price.fallbackValue",
              label: "Expense-derived unit price",
            },
            {
              path: "fieldResolutions.price.source",
              label: "Selected price source",
            },
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
        // Optional and independent of `stockTracked`: unset means undecided,
        // with no completeness check. It only informs project suggestions and
        // worklist filters; it never rewrites existing Expenses.
        key: "kind",
        kind: "enum",
        nullable: true,
        control: { kind: "select", options: selectControlOptions.productKind },
        display: { list: true, detail: true, listHidden: true },
        validation: {
          read: productKindSchema.nullable(),
          create: productKindSchema.nullable().optional(),
          update: productKindSchema.nullable().optional(),
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
        key: "fieldResolutions",
        kind: "json",
        validation: {
          read: optionalFieldResolutionsSchema,
          create: null,
          update: null,
        },
      },
      {
        key: "unitPrice",
        kind: "json",
        nullable: true,
        labelOverride: "Unit price",
        // Display-only: the list query exposes no server sort for this value.
        display: { list: true, labelPath: "unitPriceLabel", width: "sm" },
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
        labelOverride: "USDA Food",
        display: {
          list: true,
          labelPath: "food.foodInfo.description",
          renderer: { list: "usda-food-link" },
        },
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
        labelOverride: "Model present",
        display: {
          list: true,
          listHidden: true,
          width: "xs",
          readPath: "modelPresence",
          format: "presence",
          valueOptions: [
            { value: "yes", label: "Has model", color: "var(--slate)" },
            {
              value: "no",
              label: "No model",
              color: "var(--muted-foreground)",
            },
          ],
        },
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
        labelOverride: "UPC present",
        display: {
          list: true,
          listHidden: true,
          width: "xs",
          readPath: "upcPresence",
          format: "presence",
          valueOptions: [
            { value: "yes", label: "Has UPC", color: "var(--slate)" },
            { value: "no", label: "No UPC", color: "var(--muted-foreground)" },
          ],
        },
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
        labelOverride: "Notes present",
        display: {
          list: true,
          listHidden: true,
          width: "xs",
          readPath: "notesPresence",
          format: "presence",
          valueOptions: [
            { value: "yes", label: "Has notes", color: "var(--slate)" },
            {
              value: "no",
              label: "No notes",
              color: "var(--muted-foreground)",
            },
          ],
        },
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
        // flat readKey reaches it, so it reads by path.
        display: {
          list: true,
          width: "sm",
          readPath: "quantityLedger.locationCount",
          format: "count",
          mobile: { slot: "meta", priority: 43 },
        },
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
        // Nested under `quantityLedger.expectedQuantity` on the list row; the
        // server-composed label discloses the ledger's unquantified lines
        // beside the number.
        display: {
          list: true,
          listHidden: true,
          readPath: "quantityLedger.expectedQuantity",
          labelPath: "ledgerExpectedQuantityLabel",
          width: "sm",
          mobile: { slot: "meta", priority: 45 },
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
      labelField("ledgerExpectedQuantityLabel", "Expense quantity ledger"),
      labelField("quantityVarianceLabel", "Counted inventory and ledger"),
      labelField("unitPriceLabel", "Product price and unit mappings"),
      {
        key: "quantityVariance",
        kind: "number",
        nullable: true,
        // Shelf minus ledger; the label is absent when the product isn't
        // stocked or its entries carry more than one unit.
        display: {
          list: true,
          listHidden: true,
          labelPath: "quantityVarianceLabel",
          width: "sm",
          mobile: { slot: "meta", priority: 44 },
        },
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
          width: "sm",
          mobile: { slot: "meta", priority: 50, interactive: true },
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
        key: "acquisitionOrigin",
        specialized: "enum:acquisitionOrigin",
        defaultValue: "unknown",
      },
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
      { key: "kind", specialized: "enum:productKind" },
      { key: "labelNutrition", specialized: "json:labelNutrition" },
    ],
    create: [
      "acquisitionOrigin",
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
      "kind",
      "pendingImageIds",
      "pendingImagePurposes",
    ],
    update: [
      "acquisitionOrigin",
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
      "kind",
      "pendingImageIds",
      "pendingImagePurposes",
      "removeImageIds",
      "imageOrder",
    ],
    bulk: ["stockTracked"],
    audit: [
      "acquisitionOrigin",
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
      // The web list groups products by category; `labelField` names the
      // relation whose formatted path is the group's label (the field
      // itself only carries the category id).
      grouping: {
        field: "categoryId",
        nullGroupKey: PRODUCT_UNCLASSIFIED_GROUP_KEY,
        labelField: "category",
      },
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
          "kind",
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
          "acquisitionOrigin",
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
          "kind",
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
      "acquisitionOrigin",
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
      "fieldResolutions",
      "usdaUnavailable",
      "stockTracked",
      "kind",
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
  storage: {
    indexes: [
      {
        on: ["name", "manufacturer"],
        unique: true,
        where: "{deletedAt} IS NULL",
      },
      { on: ["createdAt"] },
      // No GIN on `aliases` (here, Ingredient, or Location): every alias filter
      // is `unnest(aliases) ILIKE`, which an array GIN cannot serve — those
      // index @>/&&/= ANY. EXPLAIN confirms a seq scan with a per-row SubPlan
      // either way, so the index was pure write cost.
      { trigram: "name" },
      { trigram: "manufacturer" },
      { on: ["name", "manufacturer"] },
      {
        name: "Product_name_active_idx",
        on: ["name"],
        where: "{deletedAt} IS NULL",
      },
      {
        name: "Product_manufacturer_active_idx",
        on: ["manufacturer"],
        where: "{deletedAt} IS NULL",
      },
    ],
    // Values come from the `kind` select options. Widening the value array
    // widens this CHECK: ship the migration before the code that writes it.
    checks: [{ column: "kind", nullClause: true }],
    relations: {
      category: "categoryId",
      ingredient: { field: "ingredientId", relationName: "ProductIngredient" },
      growsPlant: "growsPlantId",
      unitMappings: { many: "productUnitMappings" },
      mealFoodEntries: { many: "mealFoodEntry" },
      conversionCoverage: { one: "productConversionCoverage" },
      externalIds: {
        many: "entityExternalId",
        relationName: "productExternalIds",
      },
      inventoryEntry: { many: "inventoryEntry" },
      images: { many: "entityAttachment" },
      expenses: { many: "expense" },
      // Locations that ARE an instance of this product (a bin, tote, rack).
      // Distinct from `inventoryEntry`, which is stock held AT a location.
      locations: { many: "location" },
      // Cookbooks whose physical copy this product is. `many` only because
      // Drizzle models the reverse of a nullable FK that way — in practice
      // it's 0 or 1.
      cookbooks: { many: "cookbook" },
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
          module: "~/entity/filter-behavior",
          export: "resolveExpenseCount",
        },
      },
      {
        columnId: "expenseTotal",
        kind: "range",
        placeholder: "Filter net basis...",
        options: [
          {
            value: "positive",
            label: "Positive basis",
            expand: { expenseTotalMin: 0.01 },
          },
          {
            value: "zero",
            label: "Zero basis",
            expand: { expenseTotalMin: 0, expenseTotalMax: 0 },
          },
          {
            value: "negative",
            label: "Credit / negative",
            expand: { expenseTotalMax: -0.01 },
          },
          {
            value: "gte100",
            label: "$100 and up",
            expand: { expenseTotalMin: 100 },
          },
          {
            value: "gte500",
            label: "$500 and up",
            expand: { expenseTotalMin: 500 },
          },
        ],
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
          {
            value: "negative",
            label: "Negative (sold more than bought)",
            expand: { expectedQuantityMax: -1 },
          },
          {
            value: "zero",
            label: "Zero (none expected)",
            expand: { expectedQuantityMin: 0, expectedQuantityMax: 0 },
          },
          {
            value: "positive",
            label: "One or more expected",
            expand: { expectedQuantityMin: 1 },
          },
          {
            value: "gte5",
            label: "5 or more expected",
            expand: { expectedQuantityMin: 5 },
          },
          {
            value: "unknown",
            label: "Has lines with no quantity",
            expand: { unknownQuantityLinesFilter: "has" },
          },
        ],
      },
      {
        columnId: "quantityVariance",
        kind: "range",
        wire: { kind: "param", name: "quantityVarianceFilter" },
        placeholder: "Filter shelf vs. ledger...",
        options: [
          {
            value: "mismatched",
            label: "Shelf disagrees with ledger",
            expand: { quantityVarianceFilter: "mismatched" },
          },
          {
            value: "matched",
            label: "Shelf matches ledger",
            expand: { quantityVarianceFilter: "matched" },
          },
        ],
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
          module: "~/entity/filter-behavior",
          export: "resolveProductPurchaseDateFilter",
        },
      },
      {
        columnId: "price",
        kind: "range",
        wire: { kind: "param", name: "pricePresenceFilter" },
        placeholder: "Filter price...",
        options: [
          {
            value: "has",
            label: "Has price",
            meta: true,
            expand: { pricePresenceFilter: "has" },
          },
          {
            value: "none",
            label: "(none)",
            meta: true,
            expand: { pricePresenceFilter: "none" },
          },
          {
            value: "none-real",
            label: "No price (excluding buckets)",
            expand: { pricePresenceFilter: "none", miscBucketFilter: "none" },
          },
          {
            value: "none-bucket",
            label: "No price (buckets only)",
            expand: { pricePresenceFilter: "none", miscBucketFilter: "has" },
          },
        ],
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
        columnId: "kind",
        urlKey: "kinds",
        kind: "multiselect",
        placeholder: "Filter by kind...",
        deriveSchema: true,
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/product-fields",
          export: "productKindSchema",
        },
        // Worklist only: `none` finds Products with no kind yet. It is not a
        // data-quality check.
        nullable: { field: "kindPresenceFilter", label: "kind" },
        options: [
          { value: "consumable", label: "Consumable" },
          { value: "durable", label: "Durable" },
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
        // Components of a kit: products on the kit's `productComponent` links.
        columnId: "kitId",
        kind: "idMulti",
        placeholder: "Filter by kit...",
        brandRef: { entity: "product" },
        urlOnly: true,
      },
      {
        // Kits containing a component: parents on its `productComponent` links.
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
          module: "~/entity/filter-behavior",
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
          { edge: "EntityLink[projectTool].to", direction: "incoming" },
          { edge: "EntityLink[projectTool].from", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "EntityLink[projectTool].from", direction: "incoming" },
          { edge: "EntityLink[projectTool].to", direction: "outgoing" },
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
              { edge: "EntityLink[purchaseProduct].to", direction: "incoming" },
              {
                edge: "EntityLink[purchaseProduct].from",
                direction: "outgoing",
              },
            ],
          },
          inverse: {
            steps: [
              {
                edge: "EntityLink[purchaseProduct].from",
                direction: "incoming",
              },
              { edge: "EntityLink[purchaseProduct].to", direction: "outgoing" },
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
          { edge: "EntityLink[wishCandidate].to", direction: "incoming" },
          { edge: "EntityLink[wishCandidate].from", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "EntityLink[wishCandidate].from", direction: "incoming" },
          { edge: "EntityLink[wishCandidate].to", direction: "outgoing" },
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
          { edge: "EntityAttachment.entityId", direction: "incoming" },
          { edge: "EntityAttachment.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "EntityAttachment.imageId", direction: "incoming" },
          { edge: "EntityAttachment.entityId", direction: "outgoing" },
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
          { edge: "EntityLink[productComponent].from", direction: "incoming" },
          {
            edge: "EntityLink[productComponent].to",
            direction: "outgoing",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "EntityLink[productComponent].to",
            direction: "incoming",
          },
          { edge: "EntityLink[productComponent].from", direction: "outgoing" },
        ],
      },
      mutation: {
        source: "explicit",
        itemSchema: {
          module: "@cubby/schemas/common",
          export: "productComponentRelationItemSchema",
        },
        rowSchema: {
          module: "@cubby/schemas/product-components",
          export: "productComponentOut",
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
            edge: "EntityLink[productComponent].to",
            direction: "incoming",
          },
          { edge: "EntityLink[productComponent].from", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "EntityLink[productComponent].from", direction: "incoming" },
          {
            edge: "EntityLink[productComponent].to",
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
        sourceColumns: ["EntityExternalId.externalId", "Product.fdc_id"],
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
          id: "product_orphaned",
          facet: "integrity",
          kind: "defect",
          scoring: "unscored",
          exceptions: "forbidden",
          label: "Unused product",
          message:
            "No live inventory, ingredient, composition, or other retaining evidence uses this Product.",
        },
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
          coverage: "productsWithNoImages",
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
        // Empty path = the Product's own gallery photos (inventory photos attach to the
        // Product); label-purpose attachments are excluded by the matcher.
        visualEvidence: [{ relationPath: [], priority: 1, ordering: "newest" }],
      },
    },
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: { fields: ["stockTracked"] },
    merge: true,
    operationOwners: { delete: "kernel", merge: "kernel" },
    // Receipt lines name products loosely; a miss is the caller's decision
    // (create, merge, or pick a candidate), never an automatic row.
    resolve: {
      match: ["name", "aliases"],
      createMissing: false,
      candidates: 3,
    },
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
        module: "~/server/repo/product/repository",
        export: "productRepository",
      },
      timeline: {
        module: "~/server/repo/product/movement-timeline",
        export: "productTimeline",
      },
      search: "document",
    },
  },
});
