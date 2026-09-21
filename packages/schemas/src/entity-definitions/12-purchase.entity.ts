import { defineEntity } from "./definition.js";
import { plainDate } from "@cubby/schemas/base-entity";
import { dataQuality } from "@cubby/schemas/data-quality";
import { financialReconciliationSummary } from "@cubby/schemas/financial-reconciliation";
import {
  imageShortcode,
  purchaseShortcode,
  vendorShortcode,
  vendorAccountShortcode,
} from "../identifier-fields.js";
import { imageUrlSummary } from "@cubby/schemas/image-summary";
import { money, wholeCentAmount } from "@cubby/schemas/money";
import {
  purchaseImages,
  purchaseReconciliation,
} from "@cubby/schemas/purchase-fields";
import { z } from "zod";
export default defineEntity({
  key: "purchase",
  names: { singular: "Purchase", plural: "Purchases" },
  route: { basePath: "purchases", create: "dialog", list: true, detail: true },
  table: "Purchase",
  identifiers: { brand: "PurchaseId", shortcode: "PUR-" },
  presentation: {
    titleField: "displayName",
    domain: "finance",
    description: "Orders and their itemized expense lines.",
    emptyState: {
      title: "No purchases yet",
      description:
        "A purchase is created automatically the first time an expense records a vendor. Add one directly to file its invoice ahead of time.",
      actionLabel: "New Purchase",
    },
    icons: { lucide: "Receipt", sfSymbol: "cart", emoji: "🧾" },
    detail: {
      hero: { stats: ["statedTotal", "expenseTotal"], images: true },
      sections: [
        {
          kind: "relation",
          id: "expenses",
          title: "Expenses",
          relation: "expenses",
          filter: { descriptor: "purchaseId" },
          columns: ["name", "cost", "date", "lineKind", "product", "project"],
        },
        // Per-line quantity and unit cost live on the `PurchaseProduct` join,
        // which a relation section over the product list cannot show.
        {
          kind: "relation",
          id: "products",
          title: "Products",
          relation: "products",
          filter: { descriptor: "related:product.purchases" },
          columns: ["name", "manufacturer", "category", "price"],
        },
        { kind: "slot", id: "project-allocation", title: "Project allocation" },
        { kind: "slot", id: "import-runs", title: "Import runs" },
        {
          kind: "fields",
          id: "overview",
          title: "Overview",
          placement: "supporting",
          fields: [
            "vendorId",
            "vendorAccountId",
            "orderId",
            "displayLabel",
            "date",
            "statedTotal",
            "notes",
          ],
        },
        {
          kind: "slot",
          id: "reconciliation",
          title: "Reconciliation",
          placement: "supporting",
          explanationField: "reconciliation",
        },
        {
          kind: "slot",
          id: "financial-settlement",
          title: "Financial settlement",
          placement: "supporting",
          explanationField: "financialReconciliation",
        },
      ],
    },
    list: { actions: ["merge", "delete"] },
  },
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
        control: {
          kind: "text",
          section: "identity",
          placeholder: "Vendor order / receipt #",
        },
        display: { list: true, detail: true, detailOrder: 1 },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "vendorAccountId",
        kind: "identifier",
        nullable: true,
        label: "Vendor account",
        reference: { entity: "vendorAccount" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          section: "identity",
        },
        display: { detail: true },
        validation: {
          read: vendorAccountShortcode.nullable(),
          create: vendorAccountShortcode.nullable().default(null),
          update: vendorAccountShortcode.nullable().optional(),
        },
      },
      {
        key: "displayLabel",
        kind: "text",
        nullable: true,
        label: "Display label",
        control: {
          kind: "text",
          section: "identity",
          placeholder: "e.g. pocket hole jig + bits",
        },
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
        control: { kind: "date", section: "schedule", initial: "today" },
        display: {
          list: true,
          detail: true,
          detailOrder: 3,
          format: "plainDate",
          mobile: { slot: "meta", priority: 30 },
        },
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
        control: {
          kind: "number",
          renderer: "money",
          placeholder: "What the receipt says",
        },
        display: {
          list: true,
          detail: true,
          detailOrder: 4,
          format: "currency",
          mobile: { slot: "trailing", priority: 1 },
        },
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
        control: {
          kind: "textarea",
          placeholder: "Anything worth remembering",
        },
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
        provenance: {
          kind: "relation",
          sources: [{ entity: "image", relation: "images" }],
        },
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
        // Resolved through the join; null only if the vendor was soft-deleted.
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
        // Link out to the vendor's own order page, derived at read time from
        // `vendor.orderUrlTemplate` + `orderId` (see `purchaseOrderUrl`). Read-only
        // and absent from the create/update shapes — nothing stores it, and null
        // simply means this order isn't linkable.
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
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense", relation: "expenses" }],
        },
        explanation: {
          ruleId: "purchase.expense-count",
          description:
            "Expense count is the number of live expense lines linked to this purchase.",
          readPath: "expenseCount",
        },
        validation: {
          read: z.number().int(),
          create: null,
          update: null,
        },
      },
      {
        // Live Expenses whose cost has not been recorded yet.
        key: "unpricedExpenseCount",
        kind: "number",
        validation: {
          read: z.number().int(),
          create: null,
          update: null,
        },
      },
      {
        // `SUM(cost)` over this purchase's live expenses. THIS is the purchase's
        // spend; `statedTotal` is only what the paperwork claimed. They may
        // legitimately disagree — see the reconciliation note on `statedTotal`.
        key: "expenseTotal",
        kind: "number",
        display: { list: true },
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense", relation: "expenses" }],
        },
        explanation: {
          ruleId: "purchase.expense-total",
          description:
            "Expense total is the sum of cost across this purchase's live expense lines, including refunds.",
          readPath: "expenseTotal",
          sourceDependencies: [
            { path: "expenseCount", label: "Live expense count" },
            { path: "unpricedExpenseCount", label: "Unpriced expense count" },
          ],
        },
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
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense", relation: "expenses" }],
        },
        explanation: {
          ruleId: "purchase.expense-reconciliation",
          description:
            "Expense reconciliation compares the stated total with the live expense total and records missing-price coverage.",
          readPath: "reconciliation",
          sourceDependencies: [
            { path: "statedTotal", label: "Stated total" },
            { path: "expenseTotal", label: "Live expense total" },
            { path: "unpricedExpenseCount", label: "Unpriced expense count" },
          ],
        },
        validation: {
          read: purchaseReconciliation,
          create: null,
          update: null,
        },
      },
      {
        // Settlement evidence only; never participates in spend rollups.
        key: "financialReconciliation",
        kind: "json",
        display: { list: true, columnId: "financialSettlement" },
        provenance: {
          kind: "derived",
          sources: [
            {
              entity: "financialTransaction",
              relation: "financial-transactions",
            },
          ],
        },
        explanation: {
          ruleId: "purchase.financial-reconciliation",
          description:
            "Financial reconciliation compares the purchase total with confirmed settlement allocations; it does not change purchase spend.",
          readPath: "financialReconciliation",
          sourceDependencies: [
            { path: "statedTotal", label: "Stated purchase total" },
            {
              path: "financialReconciliation",
              label: "Settlement allocation summary",
            },
          ],
        },
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
        provenance: {
          kind: "derived",
          sources: [{ entity: "image", relation: "images" }],
        },
        explanation: {
          ruleId: "purchase.document-count",
          description:
            "Document count is the number of live images attached to this purchase.",
          readPath: "documentCount",
        },
        validation: {
          read: z.number().int(),
          create: null,
          update: null,
        },
      },
      {
        key: "images",
        kind: "json",
        provenance: {
          kind: "derived",
          sources: [{ entity: "image", relation: "images" }],
        },
        explanation: {
          ruleId: "purchase.images",
          description:
            "Purchase images are the current live document attachments in canonical attachment order; detail keeps each document classification while list and summary surfaces select the same images through the display-image projection.",
          projections: {
            list: "displayImages",
            detail: "images",
            summary: "displayImages",
          },
          sourceDependencies: [
            { path: "displayImages", label: "Selected purchase images" },
          ],
        },
        validation: {
          read: purchaseImages,
          create: null,
          update: null,
        },
      },
      {
        key: "dataQuality",
        kind: "json",
        display: { list: true, columnId: "dataQuality", listHidden: true },
        provenance: { kind: "derived", sources: [{ entity: "purchase" }] },
        explanation: {
          ruleId: "purchase.data-quality",
          description:
            "Data-quality gaps are evaluated from this purchase's current totals, line coverage, documents, and settlement state.",
          projections: {
            list: "dataQuality.status",
            summary: "dataQuality.status",
          },
          sourceDependencies: [
            { path: "dataQuality.gaps", label: "Detected gaps" },
          ],
        },
        validation: {
          read: dataQuality,
          create: null,
          update: null,
        },
      },
      {
        key: "transactionCount",
        kind: "number",
        readKey: null,
        provenance: {
          kind: "derived",
          sources: [
            {
              entity: "financialTransaction",
              relation: "financial-transactions",
            },
          ],
        },
        explanation: {
          ruleId: "purchase.transaction-count",
          description:
            "Transaction count is the number of confirmed financial transactions included in this purchase's settlement reconciliation.",
          projections: {
            list: "financialReconciliation.transactionCount",
            summary: "financialReconciliation.transactionCount",
          },
          sourceDependencies: [
            {
              path: "financialReconciliation",
              label: "Financial reconciliation",
            },
          ],
        },
      },
      {
        key: "dataGaps",
        kind: "json",
        readKey: null,
        provenance: { kind: "derived", sources: [{ entity: "purchase" }] },
        explanation: {
          ruleId: "purchase.data-gaps",
          description:
            "Data gaps are the current checks reported by this purchase's data-quality evaluation.",
          projections: {
            list: "dataQuality.gaps",
            summary: "dataQuality.gaps",
          },
          sourceDependencies: [
            { path: "dataQuality.gaps", label: "Detected gaps" },
          ],
        },
      },
      {
        // `purchaseLabel({...})` — order id, else vendor + date, else vendor,
        // with a nonblank `displayLabel` appended. `displayLabel` alone is
        // nullable and user-editable, so it cannot serve as the title field.
        key: "displayName",
        kind: "text",
        validation: { read: z.string(), create: null, update: null },
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
      { key: "vendorAccountId", reference: "vendorAccount" },
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
      "vendorAccountId",
      "orderId",
      "displayLabel",
      "date",
      "statedTotal",
      "notes",
      "pendingImageIds",
    ],
    update: [
      "vendorId",
      "vendorAccountId",
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
      "vendorAccountId",
      "orderId",
      "displayLabel",
      "date",
      "statedTotal",
      "notes",
    ],
    sort: {
      fields: [
        "orderId",
        "displayLabel",
        "date",
        "statedTotal",
        "vendor",
        "expenseCount",
        "expenseTotal",
        "reconciliationGap",
        "documentCount",
        "createdAt",
        "updatedAt",
      ],
      default: "date",
      computed: ["vendor", "reconciliationGap"],
    },
    intents: {
      fields: {
        capture: [
          "vendorId",
          "vendorAccountId",
          "date",
          "orderId",
          "displayLabel",
          "statedTotal",
          "notes",
        ],
        full: [
          "vendorId",
          "vendorAccountId",
          "date",
          "orderId",
          "displayLabel",
          "statedTotal",
          "notes",
        ],
        vendor: ["vendorId"],
        identity: ["date", "orderId", "notes"],
      },
      create: ["capture", "full"],
      update: ["full", "vendor", "identity"],
    },
    output: [
      "id",
      "vendorId",
      "vendorAccountId",
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
      "displayName",
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
    list: { module: "@cubby/schemas/purchase", export: "purchaseListItemOut" },
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
        deriveSchema: true,
        schemaDescription: "Substring match on order id or human display label",
        stored: { columns: ["orderId", "displayLabel"] },
      },
      {
        columnId: "displayLabel",
        field: "displayLabelSearch",
        urlKey: "label",
        kind: "text",
        placeholder: "Search display label...",
        deriveSchema: true,
        stored: true,
        schemaDescription: "Substring match on the human display label only",
      },
      {
        columnId: "vendor",
        field: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by vendor...",
        optionsKey: "vendor",
        brandRef: { entity: "vendor" },
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
        deriveSchema: true,
        stored: true,
        range: {
          describe: {
            lower: "Inclusive lower bound on purchase date",
            upper: "Inclusive upper bound on purchase date",
          },
        },
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
        deriveSchema: true,
        stored: true,
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
        brandRef: { entity: "product" },
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
        brandRef: { entity: "project" },
        nullable: { field: "projectPresenceFilter", label: "project" },
      },
      {
        columnId: "projectId",
        kind: "idMulti",
        placeholder: "Filter by project id...",
        brandRef: { entity: "project" },
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
      key: "vendor-account",
      label: "Vendor account",
      target: "vendorAccount",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Purchase.vendorAccountId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Purchase.vendorAccountId", direction: "incoming" }],
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
  search: { enabled: true, embedding: false },
  capabilities: {
    auditable: true,
    images: {
      storage: "gallery",
      displaySources: [
        {
          relationPath: ["products"],
          priority: 1,
          ordering: "declared",
          identityEvidence: false,
        },
        {
          relationPath: ["vendor"],
          priority: 2,
          ordering: "declared",
          identityEvidence: false,
        },
      ],
      ingress: [
        { kind: "self", routeId: "purchase-self" },
        {
          kind: "createSelf",
          routeId: "purchase-new",
          enabled: false,
          disabledReason:
            "Purchases need vendor and order details a photo can't supply; create one in Purchases first",
        },
      ],
      routing: {
        category: "documents",
        candidateFields: ["displayLabel", "orderId", "notes"],
        temporalFields: ["date"],
        lifecycleFilters: [],
        signals: {
          ocrFields: ["displayLabel", "orderId", "notes"],
          classifierLabels: ["receipt"],
        },
        abstention: { minimumScore: 0.76, minimumMargin: 0.14 },
      },
    },
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
