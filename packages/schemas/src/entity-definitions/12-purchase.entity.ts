import { defineEntity } from "./definition.js";
import { plainDate } from "@cubby/schemas/base-entity";
import { dataQuality } from "@cubby/schemas/data-quality";
import { financialReconciliationSummary } from "@cubby/schemas/financial-reconciliation";
import {
  imageShortcode,
  purchaseShortcode,
  vendorShortcode,
} from "../identifier-fields.js";
import { imageUrlSummary } from "@cubby/schemas/image-summary";
import { money, wholeCentAmount } from "@cubby/schemas/money";
import {
  purchaseImages,
  purchaseReconciliation,
} from "@cubby/schemas/purchase-fields";
import { numericRangeFields } from "@cubby/schemas/base-entity";
import { z } from "zod";
export const filterSchemas = {
  displayLabelSearch: z
    .string()
    .optional()
    .describe("Substring match on the human display label only"),
  ...numericRangeFields("expenseTotal"),
};
export default defineEntity({
  key: "purchase",
  names: { singular: "Purchase", plural: "Purchases" },
  route: { basePath: "purchases" },
  table: "Purchase",
  identifiers: { brand: "PurchaseId", shortcode: "PUR-", legacy: null },
  presentation: { titleField: "displayLabel" },
  model: {
    fields: [
      {
        key: "vendorId",
        kind: "identifier",
        label: "Vendor",
        reference: { entity: "vendor" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          list: true,
          detail: true,
          detailOrder: 0,
          columnId: "vendor",
        },
        validation: {
          read: vendorShortcode,
          create: vendorShortcode,
          update: vendorShortcode.optional(),
        },
      },
      {
        key: "orderId",
        kind: "text",
        nullable: true,
        label: "Order #",
        control: { kind: "text", section: "identity" },
        display: { list: true, detail: true, detailOrder: 1 },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "displayLabel",
        kind: "text",
        nullable: true,
        label: "Display label",
        control: { kind: "text", section: "identity" },
        display: { list: true, detail: true, detailOrder: 2 },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().optional(),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "date",
        kind: "date",
        control: { kind: "date", section: "schedule" },
        display: { list: true, detail: true, detailOrder: 3 },
        validation: {
          read: plainDate.describe("The vendor order or receipt date"),
          create: plainDate,
          update: plainDate.optional(),
        },
      },
      {
        key: "statedTotal",
        kind: "number",
        nullable: true,
        label: "Stated total",
        control: { kind: "number", renderer: "money" },
        display: { list: true, detail: true, detailOrder: 4 },
        validation: {
          read: wholeCentAmount.nullable(),
          create: wholeCentAmount.nullable().default(null),
          update: wholeCentAmount.nullable().optional(),
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        control: { kind: "textarea" },
        display: { list: true, detail: true, detailOrder: 5 },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
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
        validation: {
          read: null,
          create: null,
          update: z
            .array(imageShortcode)
            .describe("existing document ids in display order")
            .optional(),
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: purchaseShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "vendorName",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "vendorLogo",
        kind: "json",
        nullable: true,
        validation: {
          read: imageUrlSummary.nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "orderUrl",
        kind: "text",
        nullable: true,
        validation: {
          read: z.url().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "expenseCount",
        kind: "number",
        display: { list: true },
        validation: {
          read: z.number().int(),
          create: null,
          update: null,
        },
      },
      {
        key: "unpricedExpenseCount",
        kind: "number",
        validation: {
          read: z.number().int(),
          create: null,
          update: null,
        },
      },
      {
        key: "expenseTotal",
        kind: "number",
        display: { list: true },
        validation: {
          read: money,
          create: null,
          update: null,
        },
      },
      {
        key: "reconciliation",
        kind: "json",
        display: { list: true, columnId: "reconciliation" },
        validation: {
          read: purchaseReconciliation,
          create: null,
          update: null,
        },
      },
      {
        key: "financialReconciliation",
        kind: "json",
        validation: {
          read: financialReconciliationSummary,
          create: null,
          update: null,
        },
      },
      {
        key: "documentCount",
        kind: "number",
        display: { list: true },
        validation: {
          read: z.number().int(),
          create: null,
          update: null,
        },
      },
      {
        key: "images",
        kind: "json",
        validation: {
          read: purchaseImages,
          create: null,
          update: null,
        },
      },
      {
        key: "dataQuality",
        kind: "json",
        display: { list: true, columnId: "dataQuality" },
        validation: {
          read: dataQuality,
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
      { key: "dataExceptions", kind: "json", readKey: null },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
    ],
    storage: [
      {
        key: "id",
        default: "generated",
        specialized: "primary-key:PurchaseId",
      },
      { key: "shortcode", specialized: "shortcode" },
      { key: "vendorId", reference: "vendor" },
      "orderId",
      "displayLabel",
      "date",
      { key: "statedTotal", specialized: "double-precision" },
      "notes",
      {
        key: "dataExceptions",
        default: "literal",
        defaultValue: "'[]'::jsonb",
        specialized: "json:dataExceptions",
      },
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "vendorId",
      "orderId",
      "displayLabel",
      "date",
      "statedTotal",
      "notes",
      "pendingImageIds",
    ],
    update: [
      "vendorId",
      "orderId",
      "displayLabel",
      "date",
      "statedTotal",
      "notes",
      "pendingImageIds",
      "removeImageIds",
      "imageOrder",
    ],
    bulk: [],
    audit: [
      "vendorId",
      "orderId",
      "displayLabel",
      "date",
      "statedTotal",
      "notes",
    ],
    output: [
      "id",
      "vendorId",
      "orderId",
      "displayLabel",
      "date",
      "statedTotal",
      "notes",
      "vendorName",
      "vendorLogo",
      "orderUrl",
      "expenseCount",
      "unpricedExpenseCount",
      "expenseTotal",
      "reconciliation",
      "financialReconciliation",
      "documentCount",
      "images",
      "dataQuality",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: {
      module: "@cubby/schemas/purchase",
      export: "purchaseCreateInput",
    },
    update: { module: "@cubby/schemas/purchase", export: "purchaseUpdateData" },
    output: { module: "@cubby/schemas/purchase", export: "purchaseOut" },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/purchase",
      export: "purchaseFilterFields",
    },
    descriptors: [
      {
        columnId: "financialReconciliation",
        kind: "select",
        placeholder: "Filter financial reconciliation...",
        urlOnly: true,
      },
      {
        columnId: "purchase",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search order id or label...",
      },
      {
        columnId: "displayLabel",
        field: "displayLabelSearch",
        urlKey: "label",
        kind: "text",
        placeholder: "Search display label...",
        deriveSchema: true,
        schemaDescription: "Substring match on the human display label only",
      },
      {
        columnId: "vendor",
        field: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by vendor...",
        optionsKey: "vendor",
        brandRef: { entity: "vendor", kind: "id" },
      },
      {
        columnId: "orderId",
        field: "orderIdPresenceFilter",
        kind: "presence",
        placeholder: "Filter by order id...",
        options: [
          { value: "has", label: "Has order id", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "date",
        kind: "range",
        placeholder: "Filter by date...",
        options: [
          { value: "30d", label: "Last 30 days" },
          { value: "90d", label: "Last 90 days" },
          { value: "ytd", label: "Year to date" },
          { value: "1y", label: "Last 12 months" },
        ],
        expandRef: {
          module: "~/app/expenses/expense-options",
          export: "resolveDateRange",
        },
      },
      {
        columnId: "statedTotal",
        field: "statedTotalPresenceFilter",
        kind: "presence",
        placeholder: "Filter by stated total...",
        options: [
          { value: "has", label: "Has stated total", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "expenseCount",
        field: "expenseStatus",
        urlKey: "lines",
        kind: "multiselect",
        placeholder: "Filter by expense status...",
        options: [
          { value: "empty", label: "No expenses" },
          { value: "unpriced", label: "Has unpriced expenses" },
          { value: "priced", label: "Fully priced" },
        ],
      },
      {
        columnId: "expenseTotal",
        urlKey: "lineTotal",
        kind: "range",
        placeholder: "Filter by expense total...",
        deriveSchema: true,
        options: [
          { value: "gte500", label: "$500 and up" },
          { value: "gte200", label: "$200 and up" },
          { value: "gte100", label: "$100 and up" },
          { value: "nonpositive", label: "Non-positive (≤ $0)" },
        ],
        expandRef: {
          module: "~/app/purchases/purchase-options",
          export: "resolvePurchaseExpenseTotalFilter",
        },
      },
      {
        columnId: "reconciliation",
        kind: "multiselect",
        placeholder: "Filter reconciliation...",
        options: [
          { value: "match", label: "Reconciles" },
          { value: "refund_adjusted", label: "Refund-adjusted" },
          { value: "mismatch", label: "Needs review" },
          { value: "unknown", label: "No stated total" },
        ],
      },
      {
        columnId: "documentCount",
        field: "documentPresenceFilter",
        urlKey: "documents",
        kind: "presence",
        placeholder: "Filter by documents...",
        options: [
          { value: "has", label: "Has documents", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "transactionCount",
        field: "financialTransactionPresenceFilter",
        urlKey: "transactions",
        kind: "presence",
        placeholder: "Filter by transactions...",
        options: [
          { value: "has", label: "Has transactions", meta: true },
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
          { value: "settlement_reference", label: "No settlement evidence" },
          { value: "purchase_date", label: "Missing date" },
          { value: "order_id", label: "Missing order ID" },
          { value: "stated_total", label: "Missing stated total" },
          { value: "empty_expenses", label: "No expense lines" },
          { value: "unpriced_expense", label: "Unpriced expense line" },
          { value: "paperwork_mismatch", label: "Paperwork mismatch" },
        ],
      },
      {
        columnId: "expenseTotalMin",
        urlKey: "lineTotalMin",
        kind: "text",
        placeholder: "Minimum expense total...",
        urlOnly: true,
      },
      {
        columnId: "expenseTotalMax",
        urlKey: "lineTotalMax",
        kind: "text",
        placeholder: "Maximum expense total...",
        urlOnly: true,
      },
      {
        columnId: "related:purchase.expenses",
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
        columnId: "related:purchase.transactions",
        field: "financialTransactionSearch",
        urlKey: "related-financialTransaction",
        kind: "text",
        placeholder: "Search related financial transactions...",
      },
      {
        columnId: "financialTransactionId",
        kind: "idMulti",
        placeholder: "Filter by related financial transactions id...",
        urlOnly: true,
      },
      {
        columnId: "financialTransactionPresenceFilter",
        kind: "presence",
        placeholder: "Filter related financial transactions presence...",
        urlOnly: true,
      },
      {
        columnId: "related:purchase.products",
        field: "productSearch",
        urlKey: "related-product",
        kind: "text",
        placeholder: "Search related products...",
      },
      {
        columnId: "productId",
        kind: "idMulti",
        placeholder: "Filter by related products id...",
        urlOnly: true,
      },
      {
        columnId: "productPresenceFilter",
        kind: "presence",
        placeholder: "Filter related products presence...",
        urlOnly: true,
      },
      {
        columnId: "related:purchase.projects",
        field: "projectId",
        urlKey: "related-project",
        kind: "idMulti",
        placeholder: "Filter by project...",
        optionsKey: "project",
        brandRef: { entity: "project", kind: "id" },
        nullable: { field: "projectPresenceFilter", label: "project" },
      },
      {
        columnId: "projectId",
        kind: "idMulti",
        placeholder: "Filter by project id...",
        brandRef: { entity: "project", kind: "id" },
        urlOnly: true,
      },
      {
        columnId: "projectPresenceFilter",
        kind: "presence",
        placeholder: "Filter project presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "vendor",
      label: "Vendor",
      target: "vendor",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Purchase.vendorId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Purchase.vendorId", direction: "incoming" }],
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
          { edge: "PurchaseImage.purchaseId", direction: "incoming" },
          { edge: "PurchaseImage.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "PurchaseImage.imageId", direction: "incoming" },
          { edge: "PurchaseImage.purchaseId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "financial-transactions",
      label: "Financial transactions",
      target: "financialTransaction",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "outgoing",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "outgoing",
          },
        ],
      },
    },
    {
      key: "expenses",
      label: "Expenses",
      target: "expense",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Expense.purchaseId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Expense.purchaseId", direction: "outgoing" }],
      },
    },
    {
      key: "products",
      label: "Products",
      target: "product",
      cardinality: "many",
      sourceKey: "expense",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "Expense.purchaseId", direction: "incoming" },
          { edge: "Expense.productId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Expense.productId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "outgoing" },
        ],
      },
      sources: [
        {
          key: "explicit",
          label: "Explicit product link",
          provenance: {
            kind: "local-path",
            steps: [
              { edge: "PurchaseProduct.purchaseId", direction: "incoming" },
              { edge: "PurchaseProduct.productId", direction: "outgoing" },
            ],
          },
          inverse: {
            steps: [
              { edge: "PurchaseProduct.productId", direction: "incoming" },
              { edge: "PurchaseProduct.purchaseId", direction: "outgoing" },
            ],
          },
        },
      ],
      mutation: {
        source: "explicit",
        itemSchema: {
          module: "@cubby/schemas/common",
          export: "entityRelationReferenceItemSchema",
        },
        adapter: {
          module: "~/server/repo/purchase-products",
          export: "purchaseProductsRelationAdapter",
        },
        audiences: ["browser", "mcp"],
      },
    },
    {
      key: "projects",
      label: "Projects",
      target: "project",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "Expense.purchaseId", direction: "incoming" },
          { edge: "Expense.projectId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Expense.projectId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: true,
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: true,
    operationOwners: { delete: "kernel", merge: "kernel" },
    mcp: ["get", "list", "search", "create", "update", "delete", "merge"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: {
        module: "~/server/repo/purchase.entity-adapter",
        export: "purchaseEntityAdapter",
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
