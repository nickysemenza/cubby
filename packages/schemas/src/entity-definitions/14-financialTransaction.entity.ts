import { defineEntity } from "./definition.js";
import { plainDate } from "@cubby/schemas/base-entity";
import {
  financialTransactionAllocations,
  financialTransactionNonZeroAmount,
  financialTransactionSourceRefs,
  merchantVendorInference,
} from "@cubby/schemas/financial-transaction-fields";
import {
  financialAccountShortcode,
  financialTransactionShortcode,
  ledgerTransferShortcode,
  purchaseShortcode,
} from "../identifier-fields.js";
import { z } from "zod";
export const generatedFinancialTransactionKindValues = [
  "purchase",
  "refund",
  "account_transfer",
  "credit_card_payment",
  "fee",
  "interest",
  "income",
  "adjustment",
  "other",
] as const;
export const generatedFinancialTransactionStatusValues = [
  "expected",
  "pending",
  "posted",
  "void",
] as const;
export default defineEntity({
  key: "financialTransaction",
  names: { singular: "Financial Transaction", plural: "Transactions" },
  route: {
    basePath: "financial-transactions",
    create: "dialog",
    list: true,
    detail: true,
  },
  table: "FinancialTransaction",
  identifiers: {
    brand: "FinancialTransactionId",
    shortcode: "FTX-",
  },
  // Financial transactions have no name field and `merchant` is nullable;
  // `displayName` falls back through `rawDescription` and `kind` for a
  // human-identifying label that is never blank.
  presentation: {
    titleField: "displayName",
    domain: "finance",
    description: "Imported and matched settlement activity.",
    emptyState: {
      title: "No financial transactions yet",
      description:
        "Record settlement evidence without changing the expense ledger.",
      actionLabel: "New Transaction",
    },
    icons: {
      lucide: "CreditCard",
      sfSymbol: "arrow.left.arrow.right",
      emoji: "💳",
    },
    detail: {
      omitRelations: {
        products:
          "Reached through the Purchases table on this page; the product path is three joins deep.",
      },
      hero: { stats: ["amount", "status"] },
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Overview",
          placement: "supporting",
          fields: [
            "merchant",
            "vendorInference",
            "amount",
            "kind",
            "status",
            "accountId",
            "allocations",
            "postedDate",
            "sourceRefs",
          ],
        },
        {
          kind: "relation",
          id: "expenses",
          title: "Expenses",
          relation: "expenses",
          filter: { descriptor: "financialTransactionId" },
          columns: ["name", "cost", "date", "product", "project"],
        },
      ],
    },
    list: { actions: ["delete"] },
  },
  model: {
    fields: [
      {
        key: "accountId",
        kind: "identifier",
        label: "Account",
        reference: { entity: "financialAccount" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { list: true, detail: true, detailOrder: 60, listOrder: 10 },
        validation: {
          read: financialAccountShortcode,
          create: financialAccountShortcode,
          update: financialAccountShortcode.optional(),
        },
      },
      {
        key: "purchaseId",
        kind: "identifier",
        nullable: true,
        label: "Purchase",
        reference: { entity: "purchase" },
        control: { kind: "specialized", renderer: "entity-select" },
        // Detail shows `allocations` instead: this mirror is NULL exactly
        // when a charge settles more than one purchase.
        display: { list: true, detail: false, listOrder: 50 },
        validation: {
          read: purchaseShortcode.nullable(),
          create: purchaseShortcode.nullable().default(null),
          update: purchaseShortcode.nullable().optional(),
        },
      },
      {
        key: "kind",
        kind: "enum",
        control: {
          kind: "select",
          options: [
            { value: "purchase", label: "Purchase" },
            { value: "refund", label: "Refund" },
            { value: "account_transfer", label: "Account transfer" },
            { value: "credit_card_payment", label: "Card payment" },
            { value: "fee", label: "Fee" },
            { value: "interest", label: "Interest" },
            { value: "income", label: "Income" },
            { value: "adjustment", label: "Adjustment" },
            { value: "other", label: "Other" },
          ],
        },
        display: {
          list: true,
          detail: true,
          detailOrder: 40,
          width: "sm",
          listOrder: 20,
        },
        validation: {
          read: z.enum(generatedFinancialTransactionKindValues),
          create: z.enum(generatedFinancialTransactionKindValues),
          update: z.enum(generatedFinancialTransactionKindValues).optional(),
        },
      },
      {
        key: "status",
        kind: "enum",
        control: {
          kind: "select",
          options: [
            { value: "expected", label: "Expected" },
            { value: "pending", label: "Pending" },
            { value: "posted", label: "Posted" },
            { value: "void", label: "Void" },
          ],
        },
        display: {
          list: true,
          detail: true,
          detailOrder: 50,
          width: "xs",
          mobile: { slot: "meta", priority: 20 },
          listOrder: 30,
        },
        validation: {
          read: z.enum(generatedFinancialTransactionStatusValues),
          create: z.enum(generatedFinancialTransactionStatusValues),
          update: z.enum(generatedFinancialTransactionStatusValues).optional(),
        },
      },
      {
        key: "amount",
        kind: "number",
        control: { kind: "number", renderer: "money" },
        display: {
          list: true,
          detail: true,
          detailOrder: 30,
          width: "sm",
          format: "currency",
          mobile: { slot: "trailing", priority: 1 },
          listOrder: 40,
        },
        validation: {
          read: financialTransactionNonZeroAmount,
          create: financialTransactionNonZeroAmount,
          update: financialTransactionNonZeroAmount.optional(),
        },
      },
      {
        key: "transactionDate",
        kind: "date",
        nullable: true,
        control: { section: "schedule", kind: "date" },
        display: {
          list: true,
          width: "sm",
          format: "plainDate",
          mobile: { slot: "meta", priority: 25 },
          listOrder: 60,
        },
        validation: {
          read: plainDate.nullable(),
          create: plainDate.nullable().default(null),
          update: plainDate.nullable().optional(),
        },
      },
      {
        key: "postedDate",
        kind: "date",
        nullable: true,
        label: "Posted",
        control: { section: "schedule", kind: "date" },
        display: {
          list: true,
          detail: true,
          detailOrder: 80,
          width: "sm",
          format: "plainDate",
          mobile: { slot: "meta", priority: 30 },
          listOrder: 70,
        },
        validation: {
          read: plainDate.nullable(),
          create: plainDate.nullable().default(null),
          update: plainDate.nullable().optional(),
        },
      },
      {
        key: "merchant",
        kind: "text",
        nullable: true,
        control: { section: "identity", kind: "text" },
        display: {
          list: true,
          detail: true,
          detailOrder: 10,
          width: "md",
          listOrder: 80,
          listHidden: true,
        },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "rawDescription",
        kind: "text",
        nullable: true,
        label: "Statement description",
        control: { section: "details", kind: "textarea" },
        display: { list: true, listOrder: 110, listHidden: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "sourceCategory",
        kind: "text",
        nullable: true,
        label: "Source category",
        control: { section: "details", kind: "text" },
        display: { list: true, listOrder: 120, listHidden: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "sourceRefs",
        kind: "json",
        // "Source" reproduces the list column's existing header text (its
        // `display.columnId` alias below). One label serves both surfaces,
        // so the detail page's overview heading for this field (which has
        // no override `label` of its own in financial-transaction-detail.tsx)
        // changes from "References" to "Source" as an accepted consequence
        // — same as accountId's "Account ID" -> "Account" ripple.
        label: "Source",
        control: { kind: "specialized", renderer: "source-refs" },
        display: {
          list: true,
          detail: true,
          renderer: { detail: "financial-transaction-source-refs" },
          detailOrder: 90,
          columnId: "source",
          listOrder: 100,
          listHidden: true,
        },
        validation: {
          read: financialTransactionSourceRefs,
          create: financialTransactionSourceRefs.default([]),
          update: financialTransactionSourceRefs.optional(),
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        control: { section: "notes", kind: "textarea" },
        display: { list: true, listOrder: 130, listHidden: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "allocations",
        kind: "text-array",
        control: { kind: "specialized", renderer: "tag-list" },
        display: {
          detail: true,
          detailOrder: 70,
          renderer: { detail: "financial-transaction-allocations" },
        },
        provenance: {
          kind: "relation",
          sources: [{ label: "Financial allocations" }],
        },
        explanation: {
          ruleId: "financial-transaction.allocations",
          description:
            "Allocations are the current confirmed links that assign this transaction to purchases or expenses.",
          readPath: "allocations",
          sourceDependencies: [
            { path: "allocations", label: "Confirmed allocations" },
          ],
        },
        validation: {
          read: financialTransactionAllocations,
          create: financialTransactionAllocations.default([]),
          update: financialTransactionAllocations.optional(),
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: financialTransactionShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "ledgerTransferId",
        kind: "identifier",
        nullable: true,
        label: "Ledger Transfer ID",
        reference: { entity: "ledgerTransfer" },
        validation: {
          read: ledgerTransferShortcode.nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "accountName",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "vendorInference",
        kind: "json",
        nullable: true,
        label: "Possible vendor",
        display: {
          list: true,
          detail: true,
          renderer: { detail: "financial-transaction-vendor-inference" },
          detailOrder: 20,
          columnId: "possibleVendor",
          listOrder: 90,
          listHidden: true,
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "vendor", relation: "vendor" }],
        },
        explanation: {
          ruleId: "financial-transaction.vendor-inference",
          description:
            "Possible vendors come from prior settled transactions with the same normalized merchant label; confirmed allocations, transfers, and void transactions suppress the suggestion.",
          resolver: "merchantVendorInference",
          readPath: "vendorInference",
          sourceDependencies: [
            { path: "merchant", label: "Merchant label" },
            { path: "status", label: "Transaction status" },
            { path: "allocations", label: "Confirmed allocations" },
            { path: "ledgerTransferId", label: "Transfer link" },
            { path: "vendorInference", label: "Matching settled transactions" },
          ],
        },
        validation: {
          read: merchantVendorInference
            .nullable()
            .default(null)
            .describe(
              "Advisory Vendor evidence from prior settled transactions with the same Merchant label. Null when suppressed. It neither matches nor links anything; Allocations remain the only confirmed relationship.",
            ),
          create: null,
          update: null,
        },
      },
      {
        // `merchant?.trim() || rawDescription?.trim() || capitalize(kind)` —
        // the canonical non-null title for a row whose name-shaped fields are
        // all nullable.
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
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
    ],
    storage: [
      {
        key: "id",
        default: "generated",
        specialized: "primary-key:FinancialTransactionId",
      },
      { key: "shortcode", specialized: "shortcode" },
      { key: "accountId", reference: "financialAccount" },
      { key: "ledgerTransferId", reference: "ledgerTransfer" },
      { key: "kind", specialized: "enum:kind" },
      { key: "status", specialized: "enum:status" },
      { key: "amount", specialized: "double-precision" },
      "transactionDate",
      "postedDate",
      "merchant",
      "rawDescription",
      "sourceCategory",
      {
        key: "sourceRefs",
        default: "literal",
        defaultValue: "'[]'::jsonb",
        specialized: "json:sourceRefs",
      },
      "notes",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "accountId",
      "purchaseId",
      "kind",
      "status",
      "amount",
      "transactionDate",
      "postedDate",
      "merchant",
      "rawDescription",
      "sourceCategory",
      "sourceRefs",
      "notes",
      "allocations",
    ],
    update: [
      "accountId",
      "purchaseId",
      "kind",
      "status",
      "amount",
      "transactionDate",
      "postedDate",
      "merchant",
      "rawDescription",
      "sourceCategory",
      "sourceRefs",
      "notes",
      "allocations",
    ],
    bulk: [],
    audit: [
      "accountId",
      "kind",
      "status",
      "amount",
      "transactionDate",
      "postedDate",
      "merchant",
      "rawDescription",
      "sourceCategory",
      "sourceRefs",
      "notes",
    ],
    sort: {
      fields: [
        "transactionDate",
        "postedDate",
        "amount",
        "merchant",
        "kind",
        "status",
        "createdAt",
        "updatedAt",
      ],
      default: "transactionDate",
    },
    intents: {
      fields: {
        capture: [
          "accountId",
          "purchaseId",
          "kind",
          "status",
          "amount",
          "transactionDate",
          "postedDate",
          "merchant",
          "rawDescription",
          "sourceCategory",
          "sourceRefs",
          "notes",
        ],
        full: [
          "accountId",
          "purchaseId",
          "kind",
          "status",
          "amount",
          "transactionDate",
          "postedDate",
          "merchant",
          "rawDescription",
          "sourceCategory",
          "sourceRefs",
          "notes",
        ],
        settlement: [
          "accountId",
          "purchaseId",
          "kind",
          "status",
          "amount",
          "transactionDate",
          "postedDate",
        ],
      },
      create: ["capture", "full"],
      update: ["full", "settlement"],
    },
    output: [
      "id",
      "accountId",
      "purchaseId",
      "kind",
      "status",
      "amount",
      "transactionDate",
      "postedDate",
      "merchant",
      "rawDescription",
      "sourceCategory",
      "sourceRefs",
      "notes",
      "allocations",
      "ledgerTransferId",
      "accountName",
      "vendorInference",
      "displayName",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: {
      module: "@cubby/schemas/financial-transaction",
      export: "financialTransactionCreateInput",
    },
    update: {
      module: "@cubby/schemas/financial-transaction",
      export: "financialTransactionUpdateData",
    },
    output: {
      module: "@cubby/schemas/financial-transaction",
      export: "financialTransactionOut",
    },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/financial-transaction",
      export: "financialTransactionFilterFields",
    },
    descriptors: [
      {
        columnId: "allocationIntegrity",
        kind: "select",
        placeholder: "Filter allocation integrity...",
        urlOnly: true,
      },
      {
        columnId: "transaction",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search transactions...",
        deriveSchema: true,
        schemaDescription: "Substring match on merchant or raw description",
        stored: { columns: ["merchant", "rawDescription"] },
      },
      {
        columnId: "kind",
        kind: "multiselect",
        placeholder: "Filter by kind...",
        deriveSchema: true,
        stored: true,
        schemaFromRead: true,
        options: [
          { value: "purchase", label: "Purchase" },
          { value: "refund", label: "Refund" },
          { value: "account_transfer", label: "Account transfer" },
          { value: "credit_card_payment", label: "Credit card payment" },
          { value: "fee", label: "Fee" },
          { value: "interest", label: "Interest" },
          { value: "income", label: "Income" },
          { value: "adjustment", label: "Adjustment" },
          { value: "other", label: "Other" },
        ],
      },
      {
        columnId: "status",
        kind: "multiselect",
        placeholder: "Filter by status...",
        deriveSchema: true,
        stored: true,
        schemaFromRead: true,
        options: [
          { value: "expected", label: "Expected" },
          { value: "pending", label: "Pending" },
          { value: "posted", label: "Posted" },
          { value: "void", label: "Void" },
        ],
      },
      {
        columnId: "postedDate",
        kind: "range",
        placeholder: "Filter by posted date...",
        deriveSchema: true,
        stored: true,
        options: [
          { value: "30d", label: "Last 30 days" },
          { value: "90d", label: "Last 90 days" },
          { value: "ytd", label: "Year to date" },
          { value: "1y", label: "Last 12 months" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolvePostedDate",
        },
      },
      {
        columnId: "accountId",
        kind: "idMulti",
        placeholder: "Filter by account...",
        optionsKey: "account",
        brandRef: { entity: "financialAccount" },
      },
      {
        columnId: "purchaseId",
        kind: "multiselect",
        placeholder: "Filter by purchase...",
        urlOnly: true,
      },
      {
        columnId: "purchasePresence",
        field: "purchasePresenceFilter",
        kind: "presence",
        placeholder: "Filter purchase links...",
        options: [
          { value: "has", label: "Has purchase", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "source",
        kind: "multiselect",
        placeholder: "Filter by source...",
        optionsKey: "source",
      },
      {
        columnId: "externalId",
        kind: "multiselect",
        placeholder: "Filter by external id...",
        urlOnly: true,
      },
      {
        columnId: "merchant",
        kind: "text",
        placeholder: "Filter by merchant...",
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "transactionDate",
        kind: "range",
        placeholder: "Filter by transaction date...",
        urlOnly: true,
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "amount",
        kind: "range",
        placeholder: "Filter by amount...",
        deriveSchema: true,
        stored: true,
        range: { finite: true },
        options: [
          { value: "gte1000", label: "$1,000 and up" },
          { value: "gte250", label: "$250 and up" },
          { value: "gte50", label: "$50 and up" },
          { value: "credits", label: "Credits (≤ $0)" },
        ],
        expandRef: {
          module: "~/app/finance/financial-transaction-options",
          export: "resolveAmountFilter",
        },
      },
      {
        columnId: "amountMin",
        kind: "text",
        placeholder: "Minimum amount...",
        urlOnly: true,
      },
      {
        columnId: "amountMax",
        kind: "text",
        placeholder: "Maximum amount...",
        urlOnly: true,
      },
      {
        columnId: "transactionDateFrom",
        kind: "text",
        placeholder: "Transaction date from...",
        urlOnly: true,
      },
      {
        columnId: "transactionDateTo",
        kind: "text",
        placeholder: "Transaction date to...",
        urlOnly: true,
      },
      {
        columnId: "postedDateFrom",
        kind: "text",
        placeholder: "Posted date from...",
        urlOnly: true,
      },
      {
        columnId: "postedDateTo",
        kind: "text",
        placeholder: "Posted date to...",
        urlOnly: true,
      },
      {
        columnId: "related:financialTransaction.vendor",
        field: "vendorSearch",
        urlKey: "related-vendor",
        kind: "text",
        placeholder: "Search related vendor...",
      },
      {
        columnId: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by related vendor id...",
        brandRef: { entity: "vendor" },
        urlOnly: true,
      },
      {
        columnId: "vendorPresenceFilter",
        kind: "presence",
        placeholder: "Filter related vendor presence...",
        urlOnly: true,
      },
      {
        columnId: "related:financialTransaction.expenses",
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
        columnId: "related:financialTransaction.products",
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
    ],
  },
  relations: [
    {
      key: "account",
      label: "Financial account",
      target: "financialAccount",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "FinancialTransaction.accountId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "FinancialTransaction.accountId", direction: "incoming" },
        ],
      },
    },
    {
      key: "ledger-transfer",
      label: "Ledger transfer",
      target: "ledgerTransfer",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "FinancialTransaction.ledgerTransferId",
            direction: "outgoing",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "FinancialTransaction.ledgerTransferId",
            direction: "incoming",
          },
        ],
      },
    },
    {
      key: "purchase",
      label: "Purchase",
      target: "purchase",
      cardinality: "many",
      provenance: {
        kind: "local-path",
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
      inverse: {
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
    },
    {
      key: "vendor",
      label: "Vendor",
      target: "vendor",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "outgoing",
          },
          { edge: "Purchase.vendorId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Purchase.vendorId", direction: "incoming" },
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
    },
    {
      key: "expenses",
      label: "Expenses",
      target: "expense",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "outgoing",
          },
          { edge: "Expense.purchaseId", direction: "incoming" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Expense.purchaseId", direction: "outgoing" },
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
    },
    {
      key: "products",
      label: "Products",
      target: "product",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "outgoing",
          },
          { edge: "Expense.purchaseId", direction: "incoming" },
          { edge: "Expense.productId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Expense.productId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "outgoing" },
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
    },
  ],
  search: { enabled: true, embedding: false },
  capabilities: {
    auditable: true,
    images: {
      storage: false,
      displaySources: [
        {
          relationPath: ["purchase"],
          priority: 1,
          ordering: "newest",
          identityEvidence: false,
        },
        {
          relationPath: ["products"],
          priority: 2,
          ordering: "declared",
          identityEvidence: false,
        },
        {
          relationPath: ["vendor"],
          priority: 3,
          ordering: "declared",
          identityEvidence: false,
        },
      ],
      ingress: [
        {
          kind: "existingRelated",
          routeId: "financial-transaction-confirmed-purchase",
          relationPath: ["purchase"],
          choice: "primary",
        },
        {
          kind: "createSelf",
          routeId: "financial-transaction-new",
          enabled: false,
          disabledReason:
            "Financial transactions have no image storage of their own; attach photos via the linked purchase instead",
        },
      ],
      routing: {
        category: "documents",
        candidateFields: ["merchant", "description"],
        temporalFields: ["transactionDate"],
        lifecycleFilters: [{ field: "status", equals: "posted" }],
        signals: {
          ocrFields: ["merchant", "description"],
          classifierLabels: ["receipt", "credit_card"],
        },
        abstention: { minimumScore: 0.8, minimumMargin: 0.16 },
      },
    },
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "search", "create", "update", "delete"],
    dataQuality: {
      checks: [
        {
          id: "financial_transaction_allocation",
          facet: "ledger",
          weight: 2,
          label: "Allocation",
          message: "No purchase allocation is recorded for this settlement.",
        },
        {
          id: "financial_transaction_merchant",
          facet: "identity",
          weight: 1,
          label: "Merchant",
          message: "No merchant is recorded for this transaction.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/financial-transaction.entity-adapter",
        export: "financialTransactionEntityAdapter",
      },
      search: "document",
    },
  },
});
