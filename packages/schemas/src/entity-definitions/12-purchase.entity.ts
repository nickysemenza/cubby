import { defineEntity } from "./definition.js";
import { plainDate } from "@cubby/schemas/base-entity";
import { financialReconciliationSummary } from "@cubby/schemas/financial-reconciliation";
import {
  imageShortcode,
  purchaseShortcode,
  projectShortcode,
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
import { tradeSchema } from "@cubby/schemas/task-fields";
export default defineEntity({
  key: "purchase",
  names: { singular: "Purchase", plural: "Purchases" },
  route: { basePath: "purchases" },
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
    icons: { phosphor: "Receipt", sfSymbol: "cart", emoji: "🧾" },
    detail: {
      omitRelations: {
        projects:
          "The project-allocation slot renders the split for each project.",
        "financial-transactions":
          "The financial-settlement slot renders the allocations with their amounts.",
      },
      hero: { stats: ["statedTotal", "expenseTotal"], imagesOverride: true },
      sectionOverrides: [
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
            "defaultProjectId",
            "defaultTrade",
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
    list: { actionOverrides: ["merge", "delete"] },
  },
  model: {
    fields: [
      {
        key: "defaultProjectId",
        kind: "identifier",
        nullable: true,
        labelOverride: "Default project",
        reference: { entity: "project" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          sectionOverride: "details",
          suggest: { basis: ["displayLabel", "vendorId", "notes"] },
        },
        display: { detail: true },
        validation: {
          read: projectShortcode.nullable(),
          create: projectShortcode.nullable().default(null),
          update: projectShortcode.nullable().optional(),
        },
      },
      {
        key: "defaultTrade",
        kind: "enum",
        nullable: true,
        labelOverride: "Default trade",
        control: {
          kind: "select",
          sectionOverride: "details",
          // Purchase has no "name" field — `displayLabel` is its closest
          // equivalent (the operator-facing text for the purchase).
          suggest: { basis: ["displayLabel", "vendorId", "notes"] },
        },
        display: { detail: true },
        validation: {
          read: tradeSchema.nullable(),
          create: tradeSchema.nullable().default(null),
          update: tradeSchema.nullable().optional(),
        },
      },
      {
        key: "vendorId",
        kind: "identifier",
        labelOverride: "Vendor",
        reference: { entity: "vendor" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: { basis: ["displayLabel", "orderId", "notes"] },
        },
        display: {
          list: true,
          detail: true,
          detailOrderOverride: 0,
          columnIdOverride: "vendor",
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
        labelOverride: "Order #",
        control: {
          kind: "text",
          sectionOverride: "identity",
          placeholder: "Vendor order / receipt #",
        },
        display: { list: true, detail: true, detailOrderOverride: 1 },
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
        labelOverride: "Vendor account",
        reference: { entity: "vendorAccount" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          sectionOverride: "identity",
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
        labelOverride: "Display label",
        control: {
          kind: "text",
          sectionOverride: "identity",
          placeholder: "e.g. pocket hole jig + bits",
        },
        display: { list: true, detail: true, detailOrderOverride: 2 },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().optional(),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "date",
        kind: "date",
        control: {
          kind: "date",
          sectionOverride: "schedule",
          initial: "today",
        },
        display: {
          list: true,
          detail: true,
          detailOrderOverride: 3,
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
        labelOverride: "Stated total",
        control: {
          kind: "number",
          renderer: "money",
          placeholder: "What the receipt says",
        },
        display: {
          list: true,
          detail: true,
          detailOrderOverride: 4,
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
        display: { list: true, detail: true, detailOrderOverride: 5 },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "pendingImageIds",
        kind: "identifier",
        labelOverride: "Pending Image IDs",
        readKeyOverride: null,
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
        labelOverride: "Remove Image IDs",
        readKeyOverride: null,
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
        readKeyOverride: null,
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
        display: { list: true, format: "currency" },
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
        display: { list: true, columnIdOverride: "reconciliation" },
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
        display: { list: true, columnIdOverride: "financialSettlement" },
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
        key: "transactionCount",
        kind: "number",
        readKeyOverride: null,
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
      { key: "shortcode", kind: "text", readKeyOverride: null },
      {
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
        readKeyOverride: null,
      },
    ],
    storage: [
      {
        key: "id",
        defaultOverride: "generated",
        specialized: "primary-key:PurchaseId",
      },
      { key: "shortcode", specialized: "shortcode" },
      { key: "vendorId", reference: "vendor" },
      { key: "vendorAccountId", reference: "vendorAccount" },
      { key: "defaultProjectId", reference: "project" },
      { key: "defaultTrade", specialized: "enum:trade" },
      "orderId",
      "displayLabel",
      "date",
      { key: "statedTotal", specialized: "double-precision" },
      "notes",
      { key: "createdAt", defaultOverride: "now" },
      { key: "updatedAt", defaultOverride: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "vendorId",
      "vendorAccountId",
      "defaultProjectId",
      "defaultTrade",
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
      "defaultProjectId",
      "defaultTrade",
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
      "defaultProjectId",
      "defaultTrade",
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
      defaultOverride: "date",
      computed: ["vendor", "reconciliationGap"],
    },
    intents: {
      fields: {
        capture: [
          "vendorId",
          "vendorAccountId",
          "defaultProjectId",
          "defaultTrade",
          "date",
          "orderId",
          "displayLabel",
          "statedTotal",
          "notes",
        ],
        full: [
          "vendorId",
          "vendorAccountId",
          "defaultProjectId",
          "defaultTrade",
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
      "defaultProjectId",
      "defaultTrade",
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
        brandRef: { entity: "financialTransaction" },
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
      key: "defaultProject",
      label: "Default project",
      target: "project",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Purchase.defaultProjectId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Purchase.defaultProjectId", direction: "incoming" }],
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
  search: { enabled: true, embeddingOverride: false },
  capabilities: {
    auditable: true,
    // Equal weights: a purchase is a paperwork checklist, not a ranking.
    // `primary_document` and `empty_expenses` are expected only when the
    // vendor's `orderEvidence` says the vendor can supply them (checks/purchase.ts).
    dataQuality: {
      exceptions: true,
      related: ["product"],
      checks: [
        {
          id: "purchase_date",
          facet: "identity",
          label: "Missing date",
          message: "Purchase date is not recorded.",
        },
        {
          id: "order_id",
          facet: "paperwork",
          label: "Missing order ID",
          message: "Vendor order or receipt ID is not recorded.",
        },
        {
          id: "stated_total",
          facet: "paperwork",
          label: "Missing stated total",
          message: "Literal vendor-stated total is not recorded.",
        },
        {
          id: "primary_document",
          facet: "paperwork",
          label: "No primary document",
          message:
            "No primary order confirmation, sales order, invoice, or receipt is attached.",
        },
        {
          id: "empty_expenses",
          facet: "ledger",
          label: "No expense lines",
          message: "Purchase has no live Expenses.",
        },
        {
          id: "unpriced_expense",
          facet: "ledger",
          label: "Unpriced expense line",
          message: "At least one linked Expense is unpriced.",
        },
        {
          id: "paperwork_mismatch",
          facet: "paperwork",
          kind: "defect",
          label: "Paperwork mismatch",
          message:
            "Expense total differs from the literal vendor-stated total, and posted refunds do not fully explain it.",
        },
        {
          id: "settlement_reference",
          facet: "settlement",
          label: "No settlement evidence",
          message:
            "No posted qualifying FinancialTransaction with external or cash-account evidence is linked.",
        },
        {
          id: "settlement_mismatch",
          facet: "settlement",
          kind: "defect",
          label: "Settlement mismatch",
          message:
            "Settlement evidence differs from incurred Expenses. Review the ledger and source evidence, or record a reasoned expected mismatch.",
        },
      ],
    },
    images: {
      storage: "gallery",
      displaySourceOverrides: [
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
    ports: {
      repository: {
        module: "~/server/repo/purchase.entity-adapter",
        export: "purchaseEntityAdapter",
      },
      search: "document",
    },
  },
});
