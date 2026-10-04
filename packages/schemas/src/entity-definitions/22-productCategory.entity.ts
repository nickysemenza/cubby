import { categoryMappingSchema } from "../spending-classification";
import { recordEmojiField } from "../emoji";
import { z } from "zod";

import { optionalFieldResolutionsSchema } from "../field-resolution.js";
import { spendingCategoryMappingMode } from "../spending-classification.js";
import { spendingCategoryShortcode } from "../identifier-fields.js";
import { productCategoryShortcode } from "../identifier-fields.js";
import { productCategoryFeature } from "../product-category-fields.js";
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
      additionalSectionOverrides: [
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
      read: {
        relations: [
          "parentId",
          "parentName",
          "path",
          "pathLabel",
          "spendingCategoryName",
          "spendingCategoryEmoji",
        ],
        derived: [
          "fieldResolutions",
          "productCount",
          "spendingCategoryMapping",
          "effectiveSpendingCategory",
        ],
        media: ["displayImages"],
        quality: ["dataQuality"],
        dependencies: { derived: ["relations"] },
      },
      viewOverrides: [
        "table",
        { kind: "slot", id: "hierarchy", label: "Hierarchy" },
      ],
      tree: { parentField: "parentId" },
    },
  },
  model: {
    fields: [
      {
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
        display: { list: true, detail: true },
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
            { value: "inherit", label: "Inherit" },
            { value: "mapped", label: "Mapped" },
            { value: "blocked", label: "Keep unresolved" },
          ],
        },
        display: { list: true, detail: true },
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
        display: { list: true, detail: true },
        validation: {
          read: spendingCategoryShortcode.nullable().default(null),
          create: spendingCategoryShortcode.nullable().default(null),
          update: spendingCategoryShortcode.nullable().optional(),
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
        key: "name",
        kind: "text",
        control: { kind: "text", placeholder: "Category name" },
        display: { list: true, detail: true },
        validation: {
          read: z.string().min(1),
          create: z.string().trim().min(1),
          update: z.string().trim().min(1).optional(),
        },
      },
      {
        key: "aliases",
        kind: "text-array",
        control: { kind: "specialized", renderer: "tag-list" },
        display: { detail: true },
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
        display: { detail: true },
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
          list: true,
          detail: true,
          // The declared tree already shows each row under its parent.
          listHidden: true,
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
        display: { detail: true },
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
        control: {
          kind: "select",
          options: [
            {
              value: "food",
              label: "Food",
              description:
                "Expenses with no project fall to the household project, and the unit-mapping check covers these products. Required for products linked to an ingredient or a USDA food.",
            },
            {
              value: "books",
              label: "Books",
              description: "Required for products that carry an ISBN.",
            },
            {
              value: "tools",
              label: "Tools",
              description:
                "Reusable project resources: tool matrix and gallery, wishlist candidates. Data quality expects a model number.",
            },
            {
              value: "tool-consumables",
              label: "Tool consumables",
              description:
                "Blades, bits, abrasives. Classification only: color, icon, and the category-family filter.",
            },
            {
              value: "tool-accessories",
              label: "Tool accessories",
              description:
                "Attachments and add-ons for tools. Classification only: color, icon, and the category-family filter.",
            },
            {
              value: "storage",
              label: "Storage",
              description:
                "Bins, totes, shelving. Data quality expects a model number.",
            },
            {
              value: "hardware",
              label: "Hardware",
              description:
                "Fasteners and fittings. Classification only: color, icon, and the category-family filter.",
            },
            {
              value: "electronics",
              label: "Electronics",
              description:
                "Devices and components. Data quality expects a model number.",
            },
            {
              value: "software",
              label: "Software",
              description:
                "Licenses and subscriptions. Can be used as a reusable project resource.",
            },
            {
              value: "household",
              label: "Household",
              description:
                "General household goods. Data quality expects a model number.",
            },
            {
              value: "supplies",
              label: "Supplies",
              description:
                "Tape, paper, cleaning. Classification only: color, icon, and the category-family filter.",
            },
            {
              value: "apparel",
              label: "Apparel",
              description:
                "Clothing and wearables. Classification only: color, icon, and the category-family filter.",
            },
          ],
          suggest: { basis: ["name", "parentId"] },
        },
        display: {
          list: true,
          detail: true,
          width: "md",
          mobile: { slot: "meta", priority: 10 },
        },
        explanation: {
          ruleId: "productCategory.effective-feature",
          description:
            "A permanent feature binding wins; otherwise the nearest live ancestor supplies the feature. Moving a category changes its ancestor fallback without replacing its own binding.",
          resolver: "field",
          projections: {
            list: "fieldResolutions.feature.value",
            detail: "fieldResolutions.feature.value",
            summary: "fieldResolutions.feature.value",
          },
          sourceDependencies: [
            {
              path: "fieldResolutions.feature.storedValue",
              label: "Permanent feature binding",
            },
            {
              path: "fieldResolutions.feature.fallbackValue",
              label: "Ancestor feature",
            },
            {
              path: "fieldResolutions.feature.sourceEntity",
              label: "Source category",
            },
          ],
          actions: ["editSource"],
        },
        validation: {
          read: productCategoryFeature.nullable(),
          create: productCategoryFeature.nullable().default(null),
          update: productCategoryFeature.nullable().optional(),
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
        key: "path",
        kind: "json",
        display: { detail: true, detailLabelPath: "pathLabel" },
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
          read: z
            .array(
              z.object({
                id: productCategoryShortcode,
                name: z.string().min(1),
              }),
            )
            .min(1)
            .max(3),
          create: null,
          update: null,
        },
      },
      {
        key: "productCount",
        kind: "number",
        display: {
          list: true,
          detail: true,
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
        display: { detail: true },
        validation: { read: z.date(), create: null, update: null },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { detail: true },
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
    ],
    bulk: [],
    audit: [
      "spendingCategoryMode",
      "spendingCategoryId",
      "name",
      "aliases",
      "description",
      "parentId",
      "sortOrder",
      "feature",
    ],
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
      "fieldResolutions",
      "id",
      "name",
      "aliases",
      "description",
      "parentId",
      "sortOrder",
      "feature",
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
      module: "@cubby/schemas/product-category",
      export: "productCategoryOut",
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
        stored: { columns: ["name"] },
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
  search: { enabled: false },
  capabilities: {
    auditable: true,
    images: {
      storage: false,
      displaySourceOverrides: [
        {
          relationPath: ["products"],
          priority: 0,
          ordering: "declared",
          identityEvidence: false,
        },
      ],
    },
    countable: false,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "create", "update", "delete"],
    dataQuality: {
      checks: [
        {
          id: "category_description",
          facet: "content",
          weight: 1,
          label: "Description",
          message: "No description is recorded.",
        },
        {
          id: "category_feature",
          facet: "identity",
          weight: 1,
          label: "Feature",
          message:
            "No feature classification is recorded for this root category.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/product-category",
        export: "productCategoryRepository",
      },
    },
  },
});
