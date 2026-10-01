import { z } from "zod";
import { spendingCategoryShortcode as code } from "../identifier-fields";
import { defineEntity } from "./definition";

const expectation = z.enum(["unknown", "required", "not_expected"]);
export default defineEntity({
  key: "spendingCategory",
  names: { singular: "Spending Category", plural: "Spending Categories" },
  route: { basePath: "spending-categories" },
  table: "SpendingCategory",
  identifiers: { brand: "SpendingCategoryId", shortcode: "SPC-" },
  presentation: {
    titleField: "name",
    domain: "finance",
    description: "Spending classification and household evidence expectations.",
    emptyState: {
      title: "No spending categories yet",
      description:
        "Classify spending and decide which purchases need receipt lines.",
      actionLabel: "Add spending category",
    },
    icons: { phosphor: "Tag", sfSymbol: "tag", emoji: "🏷️" },
    detail: {},
    list: {
      read: { relations: ["parentId"], media: ["displayImages"] },
      tree: { parentField: "parentId" },
    },
  },
  model: {
    fields: [
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
        key: "evidenceExpectation",
        kind: "enum",
        control: {
          kind: "select",
          suggest: { basis: ["name", "parentId"] },
          options: [
            { value: "unknown", label: "Unclassified" },
            { value: "required", label: "Expected" },
            { value: "not_expected", label: "Not expected" },
          ],
        },
        display: { list: true, detail: true },
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
          suggest: { basis: ["name", "parentId"] },
          options: [
            { value: "unknown", label: "Unclassified" },
            { value: "required", label: "Expected" },
            { value: "not_expected", label: "Not expected" },
          ],
        },
        display: { list: true, detail: true },
        validation: {
          read: expectation,
          create: expectation.default("unknown"),
          update: expectation.optional(),
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
      { key: "id", specialized: "primary-key:SpendingCategoryId" },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      { key: "aliases", defaultValue: "'{}'::text[]" },
      { key: "parentId", reference: "spendingCategory" },
      {
        key: "evidenceExpectation",
        specialized: "enum:evidenceExpectation",
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
      "name",
      "aliases",
      "parentId",
      "evidenceExpectation",
      "productExpectation",
    ],
    update: [
      "name",
      "aliases",
      "parentId",
      "evidenceExpectation",
      "productExpectation",
    ],
    bulk: [],
    audit: [
      "name",
      "aliases",
      "parentId",
      "evidenceExpectation",
      "productExpectation",
    ],
    output: [
      "id",
      "name",
      "aliases",
      "parentId",
      "evidenceExpectation",
      "productExpectation",
      "createdAt",
      "updatedAt",
    ],
    sort: { fields: ["name", "updatedAt"], directionOverride: "asc" },
    intents: {
      fields: {
        capture: ["name", "evidenceExpectation", "productExpectation"],
        full: [
          "name",
          "aliases",
          "parentId",
          "evidenceExpectation",
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
      { column: "evidenceExpectation" },
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
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/spending-category",
        export: "spendingCategoryRepository",
      },
    },
  },
});
