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
import { defineEntity } from "./definition.js";
import { labelField } from "./label-field.js";

export default defineEntity({
  key: "productCategory",
  names: { singular: "Product Category", plural: "Product Categories" },
  route: {
    basePath: "product-categories",
  },
  table: "ProductCategory",
  identifiers: { brand: "ProductCategoryId", shortcode: "CAT-" },
  presentation: {
    recordEmojiField: "emoji",
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
      savedViews: [
        {
          id: "needs-classification",
          label: "Needs classification",
          description: "Records missing an effective spending category",
          filters: [{ id: "needsClassification", value: "true" }],
        },
      ],
      views: ["table", { kind: "slot", id: "hierarchy", label: "Hierarchy" }],
      tree: {},
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
        validation: {
          read: categoryMappingSchema.optional(),
          create: null,
          update: null,
        },
      },
      {
        key: "effectiveSpendingCategory",
        kind: "identifier",
        nullable: true,
        reference: { entity: "spendingCategory" },
        display: { columnGroup: "Spending policy", columnLabel: "Spending" },
        explanation: {
          ruleId: "productCategory.effective-spending-category",
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
        validation: {
          read: categoryMappingSchema.shape.category.optional(),
          create: null,
          update: null,
        },
      },
      {
        key: "spendingCategoryName",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable().optional(),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "spendingCategoryEmoji",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable().optional(),
          create: null,
          update: null,
        },
      },

      {
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
          optionRole: "category",
          optionColor: "neutral-status",
        },
        validation: {
          read: spendingCategoryMappingMode.default("inherit"),
          create: spendingCategoryMappingMode.default("inherit"),
          update: spendingCategoryMappingMode.optional(),
        },
      },
      {
        key: "spendingCategoryId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "spendingCategory" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          columnGroup: "Spending policy",
          labelPath: "spendingCategoryName",
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
          update: spendingCategoryShortcode.nullable().optional(),
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
          create: z.array(z.string()).default([]),
          update: z.array(z.string()).optional(),
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
          update: productCategoryShortcode.nullable().optional(),
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
          ],
          suggest: {
            basis: ["name", "parentId"],
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
        labelOverride: "Stock tracking",
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
        validation: { read: z.string().nullable(), create: null, update: null },
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
        validation: {
          read: productCategoryFeature.nullable(),
          create: null,
          update: null,
        },
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
        validation: {
          read: rawProductCategorySummary.shape.path,
          create: null,
          update: null,
        },
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
          sources: [{ entity: "product", relation: "products" }],
        },
        explanation: {
          ruleId: "productCategory.product-count",
          description:
            "Live products in this category or any category below it.",
          readPath: "productCount",
        },
        validation: {
          read: z.number().int().min(0),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "id",
        kind: "identifier",
        validation: {
          read: productCategoryShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { list: false },
        validation: { read: z.date(), create: null, update: null },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { list: false },
        validation: { read: z.date(), create: null, update: null },
      },
      { key: "shortcode", kind: "text" },
      {
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
      },
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
      { key: "spendingCategoryId", reference: "spendingCategory" },
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
      { key: "parentId", reference: "productCategory" },
      { key: "sortOrder", defaultValue: 0 },
      { key: "feature", specialized: "enum:feature" },
      "stockTracked",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
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
    update: [
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
    audit: [
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
        full: [
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
        identity: ["emoji", "name", "parentId"],
      },
      create: ["capture", "full"],
      update: ["full", "identity"],
    },
    output: [
      "spendingCategoryMapping",
      "effectiveSpendingCategory",
      "spendingCategoryName",
      "spendingCategoryEmoji",
      "emoji",
      "spendingCategoryMode",
      "spendingCategoryId",
      "effectiveFeature",
      "id",
      "name",
      "aliases",
      "description",
      "parentId",
      "sortOrder",
      "feature",
      "stockTracked",
      "parentName",
      "path",
      "pathLabel",
      "productCount",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: {
      module: "@cubby/schemas/product-category",
      export: "productCategoryCreateInput",
    },
    update: {
      module: "@cubby/schemas/product-category",
      export: "productCategoryUpdateData",
    },
    output: {
      module: "@cubby/schemas/product-category-raw-read",
      export: "rawProductCategoryOut",
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
    schema: {
      module: "@cubby/schemas/product-category",
      export: "productCategoryFilterFields",
    },
    descriptors: [
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
  relations: [
    {
      key: "spendingCategory",
      label: "Mapped spending category",
      target: "spendingCategory",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "ProductCategory.spendingCategoryId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "ProductCategory.spendingCategoryId", direction: "incoming" },
        ],
      },
    },
    {
      key: "parent",
      label: "Parent category",
      target: "productCategory",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "ProductCategory.parentId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "ProductCategory.parentId", direction: "incoming" }],
      },
    },
    {
      key: "products",
      label: "Products",
      target: "product",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Product.categoryId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Product.categoryId", direction: "outgoing" }],
      },
    },
    {
      key: "children",
      label: "Subcategories",
      target: "productCategory",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "ProductCategory.parentId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "ProductCategory.parentId", direction: "outgoing" }],
      },
    },
  ],
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
            field: "plantingSource",
            relation: true,
            byValue: { food: "not_allowed" },
            otherwise: "unknown",
            refusal:
              "A planting source Product must be a garden product, not a food Product.",
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
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Product", from: "id", to: "categoryId" },
            { table: "ProductCategory", from: "id", to: "id" },
          ],
        },
        {
          table: "Image",
          match: { id: "id" },
          columns: [
            "deletedAt",
            "renderStatus",
            "storageStatus",
            "detectedContentType",
          ],
          path: [
            { table: "EntityAttachment", from: "imageId", to: "entityId" },
            { table: "Product", from: "id", to: "categoryId" },
            { table: "ProductCategory", from: "id", to: "id" },
          ],
        },
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
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Vendor", from: "id", to: "id" },
            { table: "Product", from: "brandId", to: "categoryId" },
            { table: "ProductCategory", from: "id", to: "id" },
          ],
        },
        {
          table: "Image",
          match: { id: "id" },
          columns: [
            "deletedAt",
            "renderStatus",
            "storageStatus",
            "detectedContentType",
          ],
          path: [
            { table: "EntityAttachment", from: "imageId", to: "entityId" },
            { table: "Vendor", from: "id", to: "id" },
            { table: "Product", from: "brandId", to: "categoryId" },
            { table: "ProductCategory", from: "id", to: "id" },
          ],
        },
        {
          table: "SpendingCategory",
          match: { id: "id" },
          columns: ["deletedAt"],
          path: [
            { table: "ProductCategory", from: "spendingCategoryId", to: "id" },
          ],
        },
      ],

      checks: [
        {
          id: "category_description",
          satisfiedLabel: "Description recorded",
          placement: { field: "description" },
          facet: "content",
          weight: 1,
          label: "Description",
          message: "No description is recorded.",
        },
        {
          id: "category_feature",
          satisfiedLabel: "Feature classified",
          placement: { field: "feature" },
          facet: "identity",
          weight: 2,
          label: "Feature",
          message:
            "No feature classification is recorded for this root category.",
        },
        {
          id: "category_spending_category",
          satisfiedLabel: "Spending category resolved",
          placement: { field: "effectiveSpendingCategory" },
          facet: "linkage",
          weight: 2,
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
