import { defineEdge } from "./edges";
import { attachedImageInputs } from "./image-description-inputs";
import { aliasList, idField, readOnly, timestampField } from "./field-policy";
import { categoryMappingSchema } from "../spending-classification";
import { recordEmojiField } from "../emoji";
import { z } from "zod";
import { spendingCategoryMappingMode } from "../spending-classification.js";
import { spendingCategoryShortcode } from "../identifier-fields.js";
import { productCategoryShortcode } from "../identifier-fields.js";
import {
  PRODUCT_CATEGORY_MAX_DEPTH,
  productCategoryFeature,
  rawProductCategorySummary,
} from "../product-category-fields.js";
import { defineEntity, defineEntityModel } from "./definition.js";
import { labelField } from "./label-field.js";

export const { definition, readSchemas } = defineEntityModel({
  key: "productCategory",
  edges: [
    defineEdge({
      key: "Product.categoryId",
      from: "product",
      to: "productCategory",
      cardinality: "one",
      inverse: {
        key: "productCategory.incoming.Product.categoryId",
        from: "productCategory",
        to: "product",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "Product.categoryId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "product",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "reference",
        label: "products",
        description:
          "A product retains its chosen most-specific category until it is explicitly reassigned.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "disposition",
            disposition: {
              code: "block-products",
              effect: "block",
              description:
                "Products retain their selected category until reassigned.",
            },
            handler: null,
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "ProductCategory.parentId",
      from: "productCategory",
      to: "productCategory",
      cardinality: "one",
      inverse: {
        key: "productCategory.incoming.ProductCategory.parentId",
        from: "productCategory",
        to: "productCategory",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "ProductCategory.parentId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "productCategory",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "hierarchy",
        label: "child categories",
        description:
          "A child category is classified beneath this parent in the bounded product taxonomy.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "disposition",
            disposition: {
              code: "block-child-categories",
              effect: "block",
              description:
                "Move or delete child categories before deleting their parent.",
            },
            handler: null,
            before: {
              module: "~/server/domains/product-category/repo/product-category",
              export: "refuseBoundCategories",
            },
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "PhotoGroupProposal.productCreateCategoryId",
      from: "row:PhotoGroupProposal",
      to: "productCategory",
      cardinality: "one",
      inverse: {
        key: "productCategory.incoming.PhotoGroupProposal.productCreateCategoryId",
        from: "productCategory",
        to: "row:PhotoGroupProposal",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "PhotoGroupProposal.productCreateCategoryId",
        constrained: true,
      },
      ownership: {
        kind: "column",
        column: "PhotoGroupProposal.runId",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "metadata",
        label: "photo group proposals",
        description:
          "The category a proposed photo group's new Product will be filed under.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "disposition",
            disposition: {
              code: "clear-proposal-category",
              effect: "detach",
              description:
                "Deleting a category clears it from a proposed photo group's new Product, which is then created unclassified.",
            },
            handler: null,
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
  ],

  names: { singular: "Product Category", plural: "Product Categories" },
  route: {
    basePath: "product-categories",
    listColumns: {
      module: "~/features/product-category/list-columns",
      export: "productCategoryListOverride",
    },
    listReadProjection: {
      module: "~/features/product-category/list-read",
      export: "productCategoryListReadProjection",
    },
  },
  table: "ProductCategory",
  identifiers: { brand: "ProductCategoryId", shortcode: "CAT-" },
  presentation: {
    recordEmojiField: "emoji",
    recordGlyph: { field: "effectiveFeature", options: "feature" },
    titleField: "name",
    detail: {
      summary: [
        {
          kind: "fields",
          id: "category-position",
          title: "Category position",
          fields: ["path"],
        },
        {
          kind: "records",
          id: "products",
          title: "Products",
          viewKey: "relation:products",
        },
        {
          kind: "records",
          id: "child-categories",
          title: "Child categories",
          viewKey: "relation:children",
        },
        {
          kind: "fields",
          id: "spending-classification",
          title: "Spending classification",
          fields: ["effectiveSpendingCategory"],
        },
        {
          kind: "chart",
          id: "monthly-spend",
          title: "Spend over 12 months",
          viewKey: "expenses",
        },
      ],

      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Record",
          fields: [
            "emoji",
            "spendingCategoryMode",
            "spendingCategoryId",
            "name",
            "aliases",
            "description",
            "parentId",
            "sortOrder",
            "feature",
            "stockTracked",
          ],
        },
        {
          kind: "fields",
          id: "coverage",
          title: "Coverage and summaries",
          fields: [
            "effectiveSpendingCategory",
            "path",
            "productCount",
            "createdAt",
            "updatedAt",
          ],
        },
        {
          kind: "slot",
          id: "spending-classification",
          title: "Spending classification",
        },
      ],
    },
    domain: null,
    description: "An editable product classification path.",
    emptyState: {
      title: "No product categories yet",
      description:
        "Create a root category, then add optional groups and types.",
      actionLabel: "Add product category",
    },
    icons: { phosphor: "Tag", sfSymbol: "tag", emoji: "🏷️" },
    list: {
      primarySearch: {
        key: "name",
        placeholder: "Search product categories...",
      },
      rail: [{ field: "productCount" }],
      savedViews: [
        {
          id: "needs-classification",
          label: "Needs classification",
          description: "Records missing an effective spending category",
          filters: [{ id: "needsClassification", value: "true" }],
        },
      ],
      views: ["table"],
      viewAliases: { hierarchy: "table" },
      tree: { toggle: true, defaultNested: true },
    },
  },
  model: {
    hierarchy: {
      parentField: "parentId",
      // A three-level tree: at most two levels below any category.
      maxDepth: PRODUCT_CATEGORY_MAX_DEPTH - 1,
    },
    fields: [
      {
        display: { detail: false, list: false },
        key: "spendingCategoryMapping",
        kind: "json",
        validation: readOnly(categoryMappingSchema.optional()),
      },
      {
        key: "effectiveSpendingCategory",
        kind: "identifier",
        nullable: true,
        reference: { entity: "spendingCategory" },
        display: {
          columnGroup: "Spending policy",
          columnLabel: "Spending",
        },
        explanation: {
          ruleId: "productCategory.effective-spending-category",
          evidence: { kind: "scalar", inheritField: "spendingCategoryId" },
          description:
            "A category's own mapping (or block) wins; otherwise the nearest mapped ancestor within three levels supplies it.",
          projections: {
            list: "effectiveSpendingCategory",
            detail: "effectiveSpendingCategory",
            summary: "effectiveSpendingCategory",
          },
          sourceDependencies: [
            {
              path: "fields.effectiveSpendingCategory.result.decision.provenance.source",
              label: "Source",
            },
            {
              path: "fields.effectiveSpendingCategory.current.controls.reset.preview.result.decision.outcome.value",
              label: "Inherited value",
            },
          ],
        },
        validation: readOnly(categoryMappingSchema.shape.category.optional()),
      },
      {
        key: "spendingCategoryName",
        kind: "text",
        nullable: true,
        validation: readOnly(z.string().nullable().optional()),
      },
      {
        display: { detail: false, list: false },
        key: "spendingCategoryEmoji",
        kind: "text",
        nullable: true,
        validation: readOnly(z.string().nullable().optional()),
      },

      {
        audit: false,
        ...recordEmojiField,
        control: {
          ...recordEmojiField.control,
          suggest: {
            ...recordEmojiField.control.suggest,
            basis: ["name", "description", "parentId"],
          },
        },
      },

      {
        key: "spendingCategoryMode",
        description:
          'Preview with spendingClassification.preview (action "productCategory"), then apply with spendingClassification.apply and the preview fingerprint. On the web, use Spending classification.',
        kind: "enum",
        control: {
          kind: "select",
          options: [
            {
              value: "inherit",
              label: "Inherit",
              glyph: {
                phosphor: "ArrowBendDownRight",
                sfSymbol: "arrow.turn.down.right",
              },
            },
            {
              value: "mapped",
              label: "Mapped",
              color: "domain-finance",
              glyph: { phosphor: "Tag", sfSymbol: "tag" },
            },
            {
              value: "blocked",
              label: "Keep unresolved",
              color: "warning",
              glyph: { phosphor: "MinusCircle", sfSymbol: "minus.circle" },
            },
          ],
        },
        display: {
          columnGroup: "Spending policy",
          columnLabel: "Spending mode",
          list: false,
          optionRole: "category",
          optionColor: "neutral-status",
        },
        validation: {
          read: spendingCategoryMappingMode.default("inherit"),
          create: spendingCategoryMappingMode.default("inherit"),
        },
      },
      {
        key: "spendingCategoryId",
        description:
          'Preview with spendingClassification.preview (action "productCategory"), then apply with spendingClassification.apply and the preview fingerprint. On the web, use Spending classification.',
        kind: "identifier",
        nullable: true,
        reference: { entity: "spendingCategory" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          columnGroup: "Spending policy",
          labelPath: "spendingCategoryName",
          list: false,
        },
        // `blocked` keeps the category unresolved: an explicit None.
        resolution: {
          inherit: {
            mode: {
              field: "spendingCategoryMode",
              inherit: "inherit",
              none: ["blocked"],
            },
            from: ["hierarchy"],
          },
        },
        validation: {
          read: spendingCategoryShortcode.nullable().default(null),
          create: spendingCategoryShortcode.nullable().default(null),
        },
      },
      {
        key: "name",
        kind: "text",
        control: { kind: "text", placeholder: "Category name" },
        display: {},
        validation: {
          read: z.string().min(1),
          create: z.string().trim().min(1),
          update: z.string().trim().min(1).optional(),
        },
      },
      {
        key: "aliases",
        kind: "text-array",
        collection: { key: "value" },
        control: { kind: "specialized", renderer: "tag-list" },
        display: { list: false },
        validation: {
          read: z.array(z.string()),
          create: aliasList.default([]),
          update: aliasList.optional(),
        },
      },
      {
        key: "description",
        kind: "text",
        nullable: true,
        control: { kind: "textarea" },
        display: { list: false },
        validation: {
          read: z.string().nullable(),
          create: z.string().trim().nullable().default(null),
          update: z.string().trim().nullable().optional(),
        },
      },
      {
        key: "parentId",
        description:
          'Preview with spendingClassification.preview (action "productCategory"), then apply with spendingClassification.apply and the preview fingerprint. On the web, use Spending classification.',
        kind: "identifier",
        nullable: true,
        reference: { entity: "productCategory" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          columnGroup: "Classification",
          listHidden: true,
          labelPath: "parentName",
        },
        validation: {
          read: productCategoryShortcode.nullable(),
          create: productCategoryShortcode.nullable().default(null),
        },
      },
      {
        key: "sortOrder",
        kind: "number",
        control: { kind: "number" },
        display: { list: false },
        validation: {
          read: z.number().int(),
          create: z.number().int().default(0),
          update: z.number().int().optional(),
        },
      },
      {
        key: "feature",
        kind: "enum",
        nullable: true,
        // No mode field: a category without its own feature inherits.
        resolution: { inherit: { from: ["hierarchy"] } },
        control: {
          kind: "select",
          options: [
            {
              value: "services",
              glyph: { phosphor: "Receipt", sfSymbol: "doc.text" },
              label: "Services",
              description:
                "Utilities, insurance, subscriptions and obligations: track charges without physical stock or unit valuation",
            },
            {
              value: "food",
              glyph: {
                phosphor: "ForkKnife",
                sfSymbol: "fork.knife",
              },
              label: "Food",
              description:
                "Edible/consumable products tracked against nutrition (USDA-linkable)",
            },
            {
              value: "books",
              glyph: {
                phosphor: "BookOpen",
                sfSymbol: "book",
              },
              label: "Books",
              description: "Books, manuals, and other bound reading matter",
            },
            {
              value: "music",
              glyph: {
                phosphor: "VinylRecord",
                sfSymbol: "music.note",
              },
              label: "Music",
              description: "Vinyl records, CDs and other recorded music",
            },
            {
              value: "tools",
              glyph: {
                phosphor: "Wrench",
                sfSymbol: "wrench.and.screwdriver",
              },
              label: "Tools",
              description: "Durable hand or power tools",
            },
            {
              value: "tool-consumables",
              glyph: {
                phosphor: "Disc",
                sfSymbol: "opticaldisc",
              },
              label: "Tool consumables",
              description:
                "Consumed alongside tool use: blades, bits, abrasives",
            },
            {
              value: "tool-accessories",
              glyph: {
                phosphor: "Gear",
                sfSymbol: "gearshape",
              },
              label: "Tool accessories",
              description: "Non-consumed attachments and add-ons for tools",
            },
            {
              value: "storage",
              glyph: {
                phosphor: "Archive",
                sfSymbol: "archivebox",
              },
              label: "Storage",
              description:
                "Bins, totes, shelving, and other organizational containers",
            },
            {
              value: "hardware",
              glyph: {
                phosphor: "Lightning",
                sfSymbol: "bolt",
              },
              label: "Hardware",
              description: "Fasteners, fittings, and small hardware components",
            },
            {
              value: "electronics",
              glyph: {
                phosphor: "Cpu",
                sfSymbol: "cpu",
              },
              label: "Electronics",
              description: "Electronic devices and components",
            },
            {
              value: "software",
              glyph: {
                phosphor: "Package",
                sfSymbol: "shippingbox",
              },
              label: "Software",
              description: "Software, licenses, and digital subscriptions",
            },
            {
              value: "household",
              glyph: {
                phosphor: "Couch",
                sfSymbol: "sofa",
              },
              label: "Household",
              description:
                "General household goods with no more specific feature",
            },
            {
              value: "supplies",
              glyph: {
                phosphor: "Sparkle",
                sfSymbol: "sparkles",
              },
              label: "Supplies",
              description:
                "Consumable general-purpose supplies (tape, paper, cleaning, …)",
            },
            {
              value: "apparel",
              glyph: {
                phosphor: "TShirt",
                sfSymbol: "tshirt",
              },
              label: "Apparel",
              description: "Clothing, footwear, and wearable accessories",
            },
            {
              value: "planting",
              glyph: {
                phosphor: "Plant",
                sfSymbol: "leaf",
              },
              label: "Planting stock",
              description:
                "Seeds, starts, bulbs and other stock that grows a Plant",
            },
          ],
          // A feature decides which fields a whole subtree of Products may carry.
          suggest: {
            basis: ["name", "parentId"],
            apply: "review",
            rules: [
              `You are a product-category classification assistant. Given a category's name and its parent category, determine which behavior namespace it belongs to.

Rules:
1. Match the category's own subject, not an ancestor's — a feature binds to the nearest category that carries one and descendants inherit it, so only assign a feature this category itself should own.
2. Prefer the most specific feature that fits over "household", the catch-all — reserve "household" for a genuinely general-purpose category with no more specific behavior.
3. A consumable used alongside a tool (blades, bits, abrasives) is "tool-consumables"; a durable attachment for one is "tool-accessories"; the tool itself is "tools".`,
            ],
          },
        },
        display: {
          listHidden: true,
          columnGroup: "Classification",
          width: "md",
          mobile: { slot: "meta", priority: 10 },
          optionRole: "category",
          optionColor: "neutral-status",
          optionGlyph: { phosphor: "ForkKnife", sfSymbol: "fork.knife" },
        },
        explanation: {
          ruleId: "productCategory.effective-feature",
          description:
            "A permanent feature binding wins; otherwise the nearest live ancestor supplies the feature. Moving a category changes its ancestor fallback without replacing its own binding.",
          resolver: "field",
          projections: {
            list: "feature",
            detail: "feature",
            summary: "feature",
          },
          sourceDependencies: [
            {
              path: "fields.feature.current.assignment.value",
              label: "Permanent feature binding",
            },
            {
              path: "fields.feature.current.controls.reset.preview.result.decision.outcome.value",
              label: "Ancestor feature",
            },
            {
              path: "fields.feature.result.decision.provenance.source",
              label: "Source category",
            },
          ],
        },
        validation: {
          read: productCategoryFeature.nullable(),
          create: productCategoryFeature.nullable().default(null),
          update: productCategoryFeature.nullable().optional(),
        },
      },
      {
        // ADR 0013: a default for the whole subtree; a Product's own decision
        // still wins over it.
        key: "stockTracked",
        kind: "boolean",
        nullable: true,
        label: "Stock tracking",
        control: { kind: "checkbox" },
        display: { columnGroup: "Classification", listHidden: true },
        resolution: {
          reset: { stockTracked: null },
          redundancy: "eligible",
          inherit: { from: ["hierarchy"] },
        },
        explanation: {
          ruleId: "productCategory.effective-stock-tracking",
          description:
            "A category's own stock-tracking decision wins; otherwise the nearest live ancestor with a decision supplies it. With neither, the category is undecided.",
          resolver: "field",
          projections: {
            list: "stockTracked",
            detail: "stockTracked",
            summary: "stockTracked",
          },
          sourceDependencies: [
            {
              path: "fields.stockTracked.current.assignment.value",
              label: "Category decision",
            },
            {
              path: "fields.stockTracked.current.controls.reset.preview.result.decision.outcome.value",
              label: "Ancestor decision",
            },
            {
              path: "fields.stockTracked.result.decision.provenance.source",
              label: "Source category",
            },
          ],
        },
        validation: {
          read: z.boolean().nullable(),
          create: z.boolean().nullable().optional(),
          update: z.boolean().nullable().optional(),
        },
      },
      {
        key: "parentName",
        kind: "text",
        nullable: true,
        provenance: {
          kind: "derived",
          sources: [{ label: "Parent category" }],
        },
        explanation: {
          ruleId: "productCategory.parentName",
          description: "The current name of this category's immediate parent.",
        },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "effectiveFeature",
        kind: "text",
        nullable: true,
        display: { list: false, detail: false },
        provenance: {
          kind: "derived",
          sources: [{ label: "Category ancestry" }],
        },
        explanation: {
          ruleId: "productCategory.effective-feature",
          description:
            "The category's permanent feature binding or nearest live ancestor fallback.",
        },
        validation: readOnly(productCategoryFeature.nullable()),
      },
      {
        key: "path",
        kind: "json",
        display: { list: false, detailLabelPath: "pathLabel" },
        provenance: {
          kind: "derived",
          sources: [{ label: "Category ancestry" }],
        },
        explanation: {
          ruleId: "productCategory.path",
          description:
            "The root-to-category classification path, including this category.",
        },
        validation: readOnly(rawProductCategorySummary.shape.path),
      },
      {
        key: "productCount",
        kind: "number",
        display: {
          columnGroup: "Catalog",
          columnBar: true,
          width: "sm",
          mobile: { slot: "meta", priority: 20 },
        },
        provenance: {
          kind: "derived",
          sources: [
            { entity: "product" },
            { label: "Descendant Product Categories" },
          ],
        },
        explanation: {
          ruleId: "productCategory.product-count",
          description:
            "Live products in this category or any category below it.",
          readPath: "productCount",
        },
        validation: readOnly(z.number().int().min(0)),
      },
      idField(productCategoryShortcode),
      timestampField("createdAt"),
      timestampField("updatedAt"),
      { output: false, key: "shortcode", kind: "text" },
      { output: false, key: "deletedAt", kind: "timestamp", nullable: true },
      // Server-composed text for the structured detail field above (`display.detailLabelPath`).
      labelField("pathLabel", "Category ancestry"),
    ],
    storage: [
      "emoji",
      {
        key: "spendingCategoryMode",
        specialized: "enum:spendingCategoryMode",
        defaultValue: "inherit",
      },
      "spendingCategoryId",
      {
        key: "id",
        specialized: "primary-key:ProductCategoryId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      {
        key: "aliases",
        defaultValue: "'{}'::text[]",
      },
      "description",
      "parentId",
      { key: "sortOrder", defaultValue: 0 },
      { key: "feature", specialized: "enum:feature" },
      "stockTracked",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],

    derived: {
      // No effective spending category, direct or inherited.
      needsClassification: { type: "boolean" },
      // The mapping in effect, inherited through category ancestors.
      effectiveSpendingCategoryId: { via: "spendingCategory" },
    },
    sort: {
      fields: ["sortOrder", "name", "updatedAt"],
      directionOverride: "asc",
    },
    intents: {
      fields: {
        capture: ["emoji", "name", "parentId"],
        // The spending-classification workspace owns parentId,
        // spendingCategoryMode and spendingCategoryId after creation: a change
        // is previewed and applied there. Create takes parentId from capture.
        full: [
          "emoji",
          "name",
          "aliases",
          "description",
          "sortOrder",
          "feature",
          "stockTracked",
        ],
        identity: ["emoji", "name"],
      },
      create: ["capture", "full"],
      update: ["full", "identity"],
    },
  },

  storage: {
    indexes: [
      {
        name: "ProductCategory_parent_name_key",
        on: ["parentId", "name"],
        unique: true,
        where: "{deletedAt} IS NULL",
      },
      {
        name: "ProductCategory_feature_live_unique",
        on: ["feature"],
        unique: true,
        where: "{deletedAt} IS NULL AND {feature} IS NOT NULL",
      },
      { on: ["feature"] },
    ],
    checks: [
      { column: "spendingCategoryMode" },
      {
        name: "ProductCategory_spending_mapping_check",
        sql: "({spendingCategoryMode} = 'mapped') = ({spendingCategoryId} IS NOT NULL)",
      },
      { name: "ProductCategory_sortOrder_check", sql: "{sortOrder} >= 0" },
      { column: "feature", nullClause: true },
    ],
  },
  filters: {
    audit: true,

    descriptors: [
      {
        columnId: "spendingCategoryMode",
        kind: "multiselect",
        deriveSchema: true,
        placeholder: "Filter by spending category mode...",
      },

      {
        columnId: "feature",
        kind: "multiselect",
        deriveSchema: true,
        placeholder: "Filter by feature...",
      },

      {
        columnId: "stockTracked",
        kind: "boolean",
        deriveSchema: true,
        placeholder: "Filter by stock tracking...",
        options: [
          { value: "true", label: "Tracked" },
          { value: "false", label: "Not tracked" },
        ],
      },
      {
        columnId: "effectiveSpendingCategory",
        field: "effectiveSpendingCategoryId",
        urlKey: "spendingCategory",
        kind: "idMulti",
        placeholder: "Effective spending category",
        optionsKey: "spendingCategory",
        brandRef: { entity: "spendingCategory" },
        deriveSchema: true,
        derived: "effectiveSpendingCategoryId",
      },
      {
        columnId: "needsClassification",
        field: "needsClassification",
        urlKey: "needsClassification",
        kind: "boolean",
        placeholder: "Needs classification",
        deriveSchema: true,
      },
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search product categories...",
        deriveSchema: true,
        anyOf: ["name"],
      },
    ],
  },

  search: false,
  capabilities: {
    images: {
      storage: false,
      displaySourceOverrides: [
        {
          relationPath: ["products"],
        },
      ],
    },
    countable: false,
    delete: { mode: "soft", bulk: true },
    merge: false,
    // A Product's effective feature (`productCategory.effective-feature`)
    // decides which identity fields it may carry. A write whose evidence a
    // feature refuses files the Product under the one feature that admits it;
    // ISBN evidence is derived from Product's identifier collection; the
    // barcode entry field itself is valid for every category.
    classificationPolicies: [
      {
        classifier: "feature",
        target: { entity: "product", reference: "categoryId" },
        fields: [
          {
            field: "ingredientId",
            byValue: { food: "unknown" },
            otherwise: "not_allowed",
          },
          {
            field: "fdc_id",
            byValue: { food: "unknown" },
            otherwise: "not_allowed",
          },
          {
            field: "projectTool",
            relation: true,
            byValue: {
              tools: "unknown",
              "tool-accessories": "unknown",
              software: "unknown",
            },
            otherwise: "not_allowed",
          },
          {
            // Groceries come from plants too; only planting stock grows one.
            field: "growsPlantId",
            byValue: { planting: "unknown" },
            otherwise: "not_allowed",
          },
          {
            field: "plantingSource",
            relation: true,
            byValue: { food: "not_allowed" },
            otherwise: "unknown",
            refusal:
              "A planting source Product must be a garden product, not a food Product. Choose a garden Product or change the Product category before using it as a planting source.",
          },
        ],
      },
    ],
    dataQuality: {
      inputs: [
        {
          table: "Product",
          match: { categoryId: "id" },
          columns: ["deletedAt", "id"],
          path: [{ table: "ProductCategory", from: "id", to: "id" }],
        },
        ...attachedImageInputs([
          { table: "Product", from: "id", to: "categoryId" },
          { table: "ProductCategory", from: "id", to: "id" },
        ]),
        {
          table: "Product",
          match: { categoryId: "id" },
          columns: ["deletedAt", "brandId"],
          path: [{ table: "ProductCategory", from: "id", to: "id" }],
        },
        {
          table: "Vendor",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Product", from: "brandId", to: "categoryId" },
            { table: "ProductCategory", from: "id", to: "id" },
          ],
        },
        ...attachedImageInputs([
          { table: "Vendor", from: "id", to: "id" },
          { table: "Product", from: "brandId", to: "categoryId" },
          { table: "ProductCategory", from: "id", to: "id" },
        ]),
        {
          table: "SpendingCategory",
          match: { id: "id" },
          columns: ["deletedAt"],
          path: [
            {
              table: "ProductCategory",
              from: "spendingCategoryId",
              to: "id",
            },
          ],
        },
      ],

      checks: [
        {
          id: "category_description",
          satisfiedLabel: "Description recorded",
          placement: { field: "description" },
          facet: "content",
          label: "Description",
          message: "No description is recorded.",
        },
        {
          id: "category_feature",
          satisfiedLabel: "Feature classified",
          placement: { field: "feature" },
          facet: "identity",
          label: "Feature",
          message:
            "No feature classification is recorded for this root category.",
        },
        {
          id: "category_spending_category",
          satisfiedLabel: "Spending category resolved",
          placement: { field: "effectiveSpendingCategory" },
          facet: "linkage",
          label: "Spending category",
          message:
            "No spending category is mapped here or inherited, and none is deliberately kept unresolved.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/product-category/repo/product-category",
        export: "productCategoryRepository",
      },
    },
  },
});

export default defineEntity(
  definition,
  (r) => ({
    edges: [
      r.declare(
        r
          .field("spendingCategoryId")
          .named("spendingCategory", "Mapped spending category"),
        "spendingCategory.product-categories",
      ),
      r.declare(
        r.field("parentId").named("parent", "Parent category"),
        "productCategory.children",
      ),
      r.declare(
        r
          .path("product", "many", [
            { edge: "Product.categoryId", direction: "incoming" },
          ])
          .named("products", "Products", { view: { defaultVisible: true } }),
        "product.category",
      ),
      r.declare(
        r
          .path("productCategory", "many", [
            { edge: "ProductCategory.parentId", direction: "incoming" },
          ])
          .named("children", "Subcategories"),
        "productCategory.parent",
      ),
    ],
  }),
  readSchemas,
);
