import { z } from "zod";

import { optionalFieldResolutionsSchema } from "../field-resolution.js";
import { productCategoryShortcode } from "../identifier-fields.js";
import { productCategoryFeature } from "../product-category-fields.js";
import { defineEntity } from "./definition.js";

export default defineEntity({
  key: "productCategory",
  names: { singular: "Product Category", plural: "Product Categories" },
  route: {
    basePath: "product-categories",
    create: "dialog",
    list: true,
    detail: true,
  },
  table: "ProductCategory",
  identifiers: { brand: "ProductCategoryId", shortcode: "CAT-" },
  presentation: {
    titleField: "name",
    domain: null,
    description: "An editable product classification path.",
    emptyState: {
      title: "No product categories yet",
      description:
        "Create a root category, then add optional groups and types.",
      actionLabel: "Add product category",
    },
    icons: { lucide: "Tags", sfSymbol: "tag", emoji: "🏷️" },
    detail: {
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Overview",
          placement: "supporting",
          fields: [
            "name",
            "aliases",
            "description",
            "parentId",
            "sortOrder",
            "feature",
            "path",
            "productCount",
            "createdAt",
            "updatedAt",
          ],
        },
        {
          kind: "relation",
          id: "products",
          title: "Products",
          relation: "products",
          filter: { descriptor: "category" },
          columns: ["name", "manufacturer", "category", "onHandUnits"],
        },
      ],
    },
    list: {
      views: ["table", { kind: "slot", id: "hierarchy", label: "Hierarchy" }],
      tree: { parentField: "parentId" },
      actions: ["delete"],
    },
  },
  model: {
    fields: [
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
        label: "Parent category",
        reference: { entity: "productCategory" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          list: true,
          detail: true,
          columnId: "parentName",
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
        display: {
          detail: true,
          renderer: { detail: "product-category-path" },
        },
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
        label: "Products",
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
      { key: "shortcode", kind: "text", readKey: null },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
    ],
    storage: [
      {
        key: "id",
        default: "generated",
        specialized: "primary-key:ProductCategoryId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      { key: "aliases", default: "literal", defaultValue: "'{}'::text[]" },
      "description",
      { key: "parentId", reference: "productCategory" },
      { key: "sortOrder", default: "literal", defaultValue: 0 },
      { key: "feature", specialized: "enum:feature" },
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "name",
      "aliases",
      "description",
      "parentId",
      "sortOrder",
      "feature",
    ],
    update: [
      "name",
      "aliases",
      "description",
      "parentId",
      "sortOrder",
      "feature",
    ],
    bulk: [],
    audit: [
      "name",
      "aliases",
      "description",
      "parentId",
      "sortOrder",
      "feature",
    ],
    sort: {
      fields: ["name", "sortOrder", "updatedAt"],
      default: "sortOrder",
      direction: "asc",
    },
    intents: {
      fields: {
        capture: ["name", "parentId"],
        full: [
          "name",
          "aliases",
          "description",
          "parentId",
          "sortOrder",
          "feature",
        ],
        identity: ["name", "parentId"],
      },
      create: ["capture", "full"],
      update: ["full", "identity"],
    },
    output: [
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
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/product-category",
      export: "productCategoryFilterFields",
    },
    descriptors: [
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
  ],
  search: { enabled: false },
  capabilities: {
    auditable: true,
    images: { storage: false },
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
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: {
        module: "~/server/repo/product-category.entity-adapter",
        export: "productCategoryEntityAdapter",
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
      search: { projection: null, semanticText: null, dependentRefresh: null },
    },
  },
});
