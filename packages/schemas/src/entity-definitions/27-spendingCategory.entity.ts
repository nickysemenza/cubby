import { productCategoryShortcode } from "../identifier-fields";
import { recordEmojiField } from "../emoji";
import { z } from "zod";
import { spendingCategoryShortcode as code } from "../identifier-fields";
import { productExpectation } from "../purchase-evidence-policy";
import { defineEntity } from "./definition";

const expectation = z.enum(["unknown", "required", "not_expected"]);
export default defineEntity({
  key: "spendingCategory",
  names: { singular: "Spending Category", plural: "Spending Categories" },
  route: { basePath: "spending-categories" },
  table: "SpendingCategory",
  identifiers: { brand: "SpendingCategoryId", shortcode: "SPC-" },
  presentation: {
    recordEmojiField: "emoji",
    titleField: "name",
    domain: "finance",
    description:
      "Spending classification and household itemization expectations.",
    emptyState: {
      title: "No spending categories yet",
      description:
        "Classify spending and decide which purchases should be itemized.",
      actionLabel: "Add spending category",
    },
    icons: { phosphor: "Tag", sfSymbol: "tag", emoji: "🏷️" },
    detail: {},
    list: {
      read: {
        relations: ["parentId", "productCategories"],
        media: ["displayImages"],
        quality: ["dataQuality"],
      },
      tree: { parentField: "parentId" },
    },
  },
  model: {
    fields: [
      {
        key: "productCategories",
        kind: "identifier",
        reference: {
          entity: "productCategory",
          multiple: true,
          scope: [
            { sourceField: "id", targetField: "effectiveSpendingCategoryId" },
          ],
        },
        display: {
          list: true,
          detail: true,
          width: "lg",
          referencePreviewLimit: 2,
        },
        validation: {
          read: z
            .array(
              z.object({
                id: productCategoryShortcode,
                name: z.string(),
                emoji: z.string().nullable(),
                inherited: z.boolean(),
              }),
            )
            .optional(),
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
            basis: ["name", "parentId"],
          },
        },
      },

      {
        key: "name",
        kind: "text",
        control: { kind: "text" },
        display: { list: true, detail: true },
        validation: {
          read: z.string(),
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
        key: "parentId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "spendingCategory" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true },
        validation: {
          read: code.nullable(),
          create: code.nullable().default(null),
          update: code.nullable().optional(),
        },
      },
      {
        key: "itemizationExpectation",
        kind: "enum",
        control: {
          kind: "select",
          suggest: {
            basis: ["name", "parentId"],
            rules: [
              `Suggest whether the household expects these purchases to be itemized: recorded as the order's own item lines, each goods line naming its Product. Online orders with retrievable order history (Amazon, Home Depot) are expected (required). Restaurant meals, groceries, in-store shops whose receipts are usually not kept, one-amount services, subscriptions and friend reimbursements are not_expected. No policy ever requires a receipt document. Use the actual purchase/source description when available; broad or mixed vendor/category evidence without a clear purpose remains unknown. Return a reviewed proposal only; never overwrite explicit decisions.`,
            ],
          },
          options: [
            {
              value: "unknown",
              label: "Unclassified",
              description:
                "Insufficient or mixed evidence; leave itemization expectation unclassified",
            },
            {
              value: "required",
              label: "Expected",
              description:
                "Household expects the order's item lines with their Products",
            },
            {
              value: "not_expected",
              label: "Not expected",
              description:
                "Household does not expect item lines; one amount is enough",
            },
          ],
        },
        display: {
          columnLabel: "Evidence",
          list: true,
          detail: true,
        },
        validation: {
          read: expectation,
          create: expectation.default("unknown"),
          update: expectation.optional(),
        },
      },
      {
        key: "productExpectation",
        kind: "enum",
        control: {
          kind: "select",
          suggest: {
            basis: ["name", "parentId"],
            rules: [
              `Suggest Product expectation independently from itemization expectation using the spending category and parent context. Durable goods such as tools, furniture, clothing and tracked software require Product records (required). Groceries, services and friend reimbursements do not require one but may link one (not_expected). Restaurant meals, event tickets, rides and donations can never be a Product (not_allowed); choose not_allowed only when every Expense in the category is such spending. A mixed or unclear category must remain unknown. Do not infer that every itemized purchase requires Products. Return a reviewed proposal only; never overwrite explicit decisions.`,
            ],
          },
          options: [
            {
              value: "unknown",
              label: "Unclassified",
              description:
                "Insufficient or mixed evidence; leave Product expectation unclassified",
            },
            {
              value: "required",
              label: "Expected",
              description:
                "Durable goods such as tools, furniture, clothing, and tracked software need a Product record",
            },
            {
              value: "not_expected",
              label: "Not expected",
              description:
                "Groceries, services, and friend reimbursements do not need a Product record, but may link one",
            },
            {
              value: "not_allowed",
              label: "Not allowed",
              description:
                "Restaurant meals, event tickets, rides and donations never link a Product",
            },
          ],
        },
        display: {
          columnLabel: "Products",
          list: true,
          detail: true,
        },
        validation: {
          read: productExpectation,
          create: productExpectation.default("unknown"),
          update: productExpectation.optional(),
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: { read: code, create: null, update: null },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        validation: { read: z.date(), create: null, update: null },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        validation: { read: z.date(), create: null, update: null },
      },
      { key: "shortcode", kind: "text" },
      { key: "deletedAt", kind: "timestamp", nullable: true },
    ],
    storage: [
      "emoji",
      { key: "id", specialized: "primary-key:SpendingCategoryId" },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      { key: "aliases", defaultValue: "'{}'::text[]" },
      { key: "parentId", reference: "spendingCategory" },
      {
        key: "itemizationExpectation",
        specialized: "enum:itemizationExpectation",
        defaultValue: "unknown",
      },
      {
        key: "productExpectation",
        specialized: "enum:productExpectation",
        defaultValue: "unknown",
      },
      "createdAt",
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "emoji",
      "name",
      "aliases",
      "parentId",
      "itemizationExpectation",
      "productExpectation",
    ],
    update: [
      "emoji",
      "name",
      "aliases",
      "parentId",
      "itemizationExpectation",
      "productExpectation",
    ],
    bulk: [],
    audit: [
      "name",
      "aliases",
      "parentId",
      "itemizationExpectation",
      "productExpectation",
    ],
    output: [
      "productCategories",
      "emoji",
      "id",
      "name",
      "aliases",
      "parentId",
      "itemizationExpectation",
      "productExpectation",
      "createdAt",
      "updatedAt",
    ],
    sort: { fields: ["name", "updatedAt"] },
    intents: {
      fields: {
        capture: [
          "emoji",
          "name",
          "itemizationExpectation",
          "productExpectation",
        ],
        full: [
          "emoji",
          "name",
          "aliases",
          "parentId",
          "itemizationExpectation",
          "productExpectation",
        ],
      },
      create: ["capture", "full"],
      update: ["full"],
    },
  },
  fields: {
    create: {
      module: "@cubby/schemas/spending-category",
      export: "spendingCategoryCreateInput",
    },
    update: {
      module: "@cubby/schemas/spending-category",
      export: "spendingCategoryUpdateData",
    },
    output: {
      module: "@cubby/schemas/spending-category",
      export: "spendingCategoryOut",
    },
  },
  storage: {
    checks: [
      { column: "itemizationExpectation" },
      { column: "productExpectation" },
    ],
  },
  filters: {
    schema: {
      module: "@cubby/schemas/spending-category",
      export: "spendingCategoryFilterFields",
    },
    audit: true,
    descriptors: [
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search spending categories...",
        deriveSchema: true,
        stored: { columns: ["name"] },
      },
      {
        columnId: "parentId",
        placeholder: "Filter by parent...",
        kind: "idMulti",
        brandRef: { entity: "spendingCategory" },
        deriveSchema: true,
        stored: true,
      },
    ],
  },
  relations: [
    {
      key: "parent",
      label: "Parent category",
      target: "spendingCategory",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "SpendingCategory.parentId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "SpendingCategory.parentId", direction: "incoming" }],
      },
    },
    {
      key: "children",
      label: "Subcategories",
      target: "spendingCategory",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "SpendingCategory.parentId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "SpendingCategory.parentId", direction: "outgoing" }],
      },
    },
    {
      key: "purchases",
      label: "Purchases",
      target: "purchase",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Purchase.spendingCategoryId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Purchase.spendingCategoryId", direction: "outgoing" }],
      },
    },
    {
      key: "expenses",
      label: "Expense overrides",
      target: "expense",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Expense.spendingCategoryId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Expense.spendingCategoryId", direction: "outgoing" }],
      },
    },
    {
      key: "transactions",
      label: "Transactions",
      target: "financialTransaction",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "FinancialTransaction.spendingCategoryId",
            direction: "incoming",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "FinancialTransaction.spendingCategoryId",
            direction: "outgoing",
          },
        ],
      },
    },
  ],
  search: false,
  capabilities: {
    images: { storage: false },
    countable: false,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: true,
    dataQuality: {
      checks: [
        {
          id: "spending_category_itemization_expectation",
          satisfiedLabel: "Itemization expectation classified",
          placement: { field: "itemizationExpectation" },
          facet: "paperwork",
          exceptions: "forbidden",
          weight: 2,
          label: "Itemization expectation",
          message:
            "Whether spending in this category should be itemized is unclassified.",
        },
        {
          id: "spending_category_product_expectation",
          satisfiedLabel: "Product expectation classified",
          placement: { field: "productExpectation" },
          facet: "identity",
          exceptions: "forbidden",
          weight: 1,
          label: "Product expectation",
          message:
            "Whether lines in this category need a Product identity is unclassified.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/spending-category/repo/spending-category",
        export: "spendingCategoryRepository",
      },
    },
  },
});
