import { purchaseChildren } from "../child-tables/purchase.js";
import { recordEmojiField } from "../emoji";
import { spendingCategorySummarySchema } from "../spending-classification";
import { optionalFieldResolutionsSchema } from "../field-resolution";
import { purchaseEvidenceCoverage } from "../purchase-evidence-policy";
import { spendingCategoryShortcode } from "../identifier-fields";
import { defineEntity } from "./definition.js";
import { selectControlOptions } from "./select-control-options.js";
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
  children: purchaseChildren,
  identifiers: { brand: "PurchaseId", shortcode: "PUR-" },
  presentation: {
    recordEmojiField: "emoji",
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
      hero: { stats: ["statedTotal", "expenseTotal"] },
      additionalSectionOverrides: [
        {
          kind: "relation",
          id: "expenses",
          title: "Expenses",
          relation: "expenses",
          filter: { descriptor: "purchaseIdFilter" },
          columns: [
            "name",
            "cost",
            "productId",
            "spendingCategoryId",
            "projectId",
            "lineKind",
            "costType",
            "trade",
          ],
          collapseWhenEmpty: true,
        },
        { kind: "slot", id: "project-allocation", title: "Project allocation" },
        { kind: "slot", id: "runs", title: "Import runs" },
        { kind: "slot", id: "order-mail", title: "Order email" },
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
    list: {
      savedViews: [
        {
          id: "needs-review",
          label: "Needs review",
          description: "Stated total the expense lines don't explain",
          // `mismatch` is already the narrow signal: a purchase whose stated total
          // differs from its expense total by more than tolerance AND whose posted
          // refunds don't account for the gap. `refund_adjusted` is the explained
          // case and stays out — this view is the money that doesn't add up.
          filters: [{ id: "reconciliation", value: ["mismatch"] }],
        },
        {
          id: "unsettled",
          label: "No settlement evidence",
          description:
            "Orders with no posted transaction carrying proof of payment",
          // Narrower than "has no transactions": the gap only clears for a POSTED
          // transaction of a settlement kind that either carries a sourceRef or
          // sits on a cash account. An expected refund or an evidence-free row
          // doesn't close it. See `purchaseGapRaw`.
          //
          // This is a large list — a bit under half of all purchases — because it's
          // dominated by Home Depot and Amazon, whose per-visit and per-shipment
          // billing don't line up with per-order purchases. Combine it with the
          // vendor filter to get at the scattered remainder.
          filters: [{ id: "dataGaps", value: ["settlement_reference"] }],
          sort: [{ id: "date", desc: true }],
        },
      ],
      read: {
        relations: [
          "vendorId",
          "vendorAccountId",
          "defaultProjectId",
          "vendorName",
          "orderUrl",
        ],
        media: ["vendorLogo", "images", "displayImages"],
        derived: [
          "bookingCoverage",
          "documentCoverage",
          "itemizationCoverage",
          "productsCoverage",
          "coverage",
          "spendingCategorySummary",
          "fieldResolutions",
          "expenseCount",
          "unpricedExpenseCount",
          "expenseTotal",
          "reconciliation",
          "financialReconciliation",
          "documentCount",
        ],
        quality: ["dataQuality"],
      },
      actionOverrides: ["merge", "delete"],
      totalOverrides: [
        {
          id: "expenseTotal",
          label: "Spend",
          keys: ["expenseTotal"],
          format: "currency",
        },
        {
          id: "expenseCount",
          label: "Expense lines",
          keys: ["expenseCount"],
          format: "integer",
        },
      ],
    },
  },
  model: {
    fields: [
      {
        ...recordEmojiField,
        control: {
          ...recordEmojiField.control,
          suggest: {
            ...recordEmojiField.control.suggest,
            basis: ["displayName", "displayLabel", "notes"],
          },
        },
      },

      {
        key: "bookingCoverage",
        kind: "enum",
        provenance: {
          kind: "derived",
          sources: [{ label: "Source evidence and booked expenses" }],
        },
        control: {
          kind: "select",
          options: [
            { value: "missing", label: "Missing" },
            { value: "partial", label: "Partial" },
            { value: "recorded", label: "Recorded" },
          ],
        },
        display: { list: true, detail: true, width: "sm" },
        validation: {
          read: purchaseEvidenceCoverage.shape.booking,
          create: null,
          update: null,
        },
      },
      {
        key: "documentCoverage",
        kind: "enum",
        provenance: {
          kind: "derived",
          sources: [{ label: "Source evidence and booked expenses" }],
        },
        control: {
          kind: "select",
          options: [
            { value: "missing", label: "Missing" },
            { value: "present", label: "Present" },
            { value: "not_expected", label: "Not expected" },
            { value: "unknown", label: "Unclassified" },
          ],
        },
        display: { list: true, detail: true, width: "sm" },
        validation: {
          read: purchaseEvidenceCoverage.shape.document,
          create: null,
          update: null,
        },
      },
      {
        key: "itemizationCoverage",
        kind: "enum",
        provenance: {
          kind: "derived",
          sources: [{ label: "Source evidence and booked expenses" }],
        },
        control: {
          kind: "select",
          options: [
            { value: "missing", label: "Missing" },
            { value: "present", label: "Present" },
            { value: "not_expected", label: "Not expected" },
            { value: "unknown", label: "Unclassified" },
          ],
        },
        display: { list: true, detail: true, width: "sm" },
        validation: {
          read: purchaseEvidenceCoverage.shape.itemization,
          create: null,
          update: null,
        },
      },
      {
        key: "productsCoverage",
        kind: "enum",
        provenance: {
          kind: "derived",
          sources: [{ label: "Source evidence and booked expenses" }],
        },
        control: {
          kind: "select",
          options: [
            { value: "missing", label: "Missing" },
            { value: "partial", label: "Partial" },
            { value: "present", label: "Present" },
            { value: "not_expected", label: "Not expected" },
            { value: "unknown", label: "Unclassified" },
          ],
        },
        display: { list: true, detail: true, width: "sm" },
        validation: {
          read: purchaseEvidenceCoverage.shape.products,
          create: null,
          update: null,
        },
      },
      {
        key: "coverage",
        kind: "json",
        provenance: {
          kind: "derived",
          sources: [{ label: "Source evidence and booked expenses" }],
        },
        explanation: {
          ruleId: "purchase.coverage",
          description:
            "Booking, receipt, itemization, and Product coverage are evaluated independently against household expectations.",
        },
        validation: {
          read: purchaseEvidenceCoverage,
          create: null,
          update: null,
        },
      },
      {
        key: "spendingCategorySummary",
        kind: "json",
        labelOverride: "Expense categories",
        provenance: {
          kind: "derived",
          sources: [{ label: "Live Expense category allocations" }],
        },
        display: {
          list: true,
          detail: true,
          renderer: {
            detail: "spending-category-summary",
            list: "spending-category-summary",
          },
        },
        explanation: {
          ruleId: "purchase.expense-category-summary",
          description:
            "Category amounts come from the live Expense ledger and its canonical adjustment allocations. The Purchase fallback is not its category summary.",
        },
        validation: {
          read: spendingCategorySummarySchema,
          create: null,
          update: null,
        },
      },
      {
        key: "spendingCategoryOrigin",
        kind: "enum",
        labelOverride: "Fallback provenance",
        display: { detail: true },
        validation: {
          read: z.enum(["legacy", "manual", "source"]).default("legacy"),
          create: null,
          update: null,
        },
      },
      {
        key: "spendingCategoryId",
        labelOverride: "Fallback category",
        description:
          "Explicit fallback used only when an Expense has no more specific classification. Mixed Purchase categories come from its Expense lines.",
        kind: "identifier",
        nullable: true,
        reference: { entity: "spendingCategory" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: { basis: ["displayLabel", "vendorId", "notes"] },
        },
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
        key: "evidenceExpectation",
        kind: "enum",
        nullable: true,
        control: {
          kind: "select",
          suggest: {
            basis: ["displayLabel", "vendorId", "spendingCategoryId", "notes"],
          },
          options: [
            { value: "unknown", label: "Unclassified" },
            { value: "required", label: "Expected" },
            { value: "not_expected", label: "Not expected" },
          ],
        },
        display: { list: true, detail: true },
        resolution: {
          reset: { evidenceExpectation: null },
          redundancy: "eligible",
        },
        explanation: {
          ruleId: "purchase.effective-evidence-expectation",
          description:
            "An explicit Purchase receipt policy wins; otherwise the live Vendor policy supplies it, followed by the Purchase spending category.",
          projections: {
            list: "fieldResolutions.evidenceExpectation.value",
            detail: "fieldResolutions.evidenceExpectation.value",
            summary: "fieldResolutions.evidenceExpectation.value",
          },
          sourceDependencies: [
            {
              path: "fieldResolutions.evidenceExpectation.sourceEntity",
              label: "Source",
            },
            {
              path: "fieldResolutions.evidenceExpectation.storedValue",
              label: "Stored override",
            },
            {
              path: "fieldResolutions.evidenceExpectation.fallbackValue",
              label: "Inherited value",
            },
          ],
        },
        validation: {
          read: z
            .enum(["unknown", "required", "not_expected"])
            .nullable()
            .default(null),
          create: z
            .enum(["unknown", "required", "not_expected"])
            .nullable()
            .default(null),
          update: z
            .enum(["unknown", "required", "not_expected"])
            .nullable()
            .optional(),
        },
      },
      {
        key: "itemizationEvidence",
        kind: "boolean",
        control: { kind: "checkbox" },
        display: { detail: true },
        validation: {
          read: z.boolean().default(false),
          create: z.boolean().default(false),
          update: z.boolean().optional(),
        },
      },
      {
        key: "defaultProjectId",
        kind: "identifier",
        nullable: true,
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
        control: {
          kind: "select",
          options: selectControlOptions.trade,
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
        reference: { entity: "vendor" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: { basis: ["displayLabel", "orderId", "notes"] },
        },
        display: {
          list: true,
          detail: true,
          renderer: { list: "vendor-cell" },
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
        control: {
          kind: "text",
          sectionOverride: "identity",
          placeholder: "Vendor order / receipt #",
        },
        display: {
          list: true,
          detail: true,
          renderer: { list: "order-link" },
        },
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
        control: {
          kind: "text",
          sectionOverride: "identity",
          placeholder: "e.g. pocket hole jig + bits",
        },
        display: {
          list: true,
          detail: true,
          width: "lg",
          mobile: { slot: "subtitle", priority: 5, interactive: true },
        },
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
        control: {
          kind: "number",
          renderer: "money",
          placeholder: "What the receipt says",
        },
        display: {
          list: true,
          detail: true,
          format: "currency",
          mobile: { slot: "trailing", priority: 1 },
          width: "sm",
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
        display: { list: true, detail: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "pendingImageIds",
        kind: "identifier",
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
        display: { list: true, renderer: { list: "expense-count" } },
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
        // `SUM(Expense.cost)`: a negative total (a net credit) reads as money
        // in, a positive one (spend) stays neutral.
        display: {
          list: true,
          width: "sm",
          format: "signedCurrency",
          mobile: { slot: "trailing", priority: 5 },
        },
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
        display: {
          list: true,
          renderer: { list: "reconciliation-status" },
          valueOptions: [
            { value: "match", label: "Reconciles", color: "var(--positive)" },
            {
              value: "refund_adjusted",
              label: "Refund-adjusted",
              color: "var(--slate)",
            },
            {
              value: "mismatch",
              label: "Needs review",
              color: "var(--warning)",
            },
            {
              value: "unknown",
              label: "No stated total",
              color: "var(--slate)",
            },
          ],
        },
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
        display: {
          list: true,
          renderer: { list: "financial-settlement" },
          // Roster for `financialReconciliation.status`.
          valueOptions: [
            { value: "unknown", label: "No evidence", color: "var(--slate)" },
            { value: "pending", label: "Pending", color: "var(--warning)" },
            { value: "match", label: "Settled", color: "var(--positive)" },
            {
              value: "mismatch",
              label: "Mismatch",
              color: "var(--destructive)",
            },
          ],
        },
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
        display: {
          list: true,
          width: "xs",
          mobile: { slot: "meta", priority: 70 },
        },
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
        labelOverride: "Transactions",
        display: {
          list: true,
          listHidden: true,
          width: "xs",
          readPath: "financialReconciliation.transactionCount",
          format: "count",
        },
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
      { key: "shortcode", kind: "text" },
      {
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
      },
    ],
    storage: [
      "emoji",
      { key: "spendingCategoryId", reference: "spendingCategory" },
      {
        key: "spendingCategoryOrigin",
        specialized: "enum:spendingCategoryOrigin",
        defaultValue: "legacy",
      },
      { key: "evidenceExpectation", specialized: "enum:evidenceExpectation" },
      { key: "itemizationEvidence", defaultValue: false },
      {
        key: "id",
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
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "emoji",
      "spendingCategoryId",
      "evidenceExpectation",
      "itemizationEvidence",
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
      "emoji",
      "spendingCategoryId",
      "evidenceExpectation",
      "itemizationEvidence",
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
      "spendingCategoryId",
      "evidenceExpectation",
      "itemizationEvidence",
      "vendorId",
      "vendorAccountId",
      "defaultProjectId",
      "defaultTrade",
      "orderId",
      "displayLabel",
      "date",
      "statedTotal",
      "notes",
      "spendingCategoryOrigin",
    ],
    sort: {
      fields: [
        "date",
        "orderId",
        "displayLabel",
        "statedTotal",
        "vendorId",
        "expenseCount",
        "expenseTotal",
        "reconciliationGap",
        "documentCount",
        "createdAt",
        "updatedAt",
      ],
      computed: ["vendorId", "reconciliationGap"],
    },
    intents: {
      fields: {
        capture: [
          "emoji",
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
          "emoji",
          "spendingCategoryId",
          "evidenceExpectation",
          "itemizationEvidence",
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
        vendor: ["emoji", "vendorId"],
        identity: ["emoji", "date", "orderId", "notes"],
      },
      create: ["capture", "full"],
      update: ["full", "vendor", "identity"],
    },
    output: [
      "emoji",
      "bookingCoverage",
      "documentCoverage",
      "itemizationCoverage",
      "productsCoverage",
      "coverage",
      "spendingCategorySummary",
      "fieldResolutions",
      "spendingCategoryId",
      "spendingCategoryOrigin",
      "evidenceExpectation",
      "itemizationEvidence",
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
  // One vendor order, receipt, or deliberately separate purchase event — the
  // home for vendor-side truth (literal stated total, documents, identity).
  // No money is summed from this table: spend is `SUM(Expense.cost)`.
  storage: {
    columns: [{ key: "runId", kind: "identifier", reference: "run" }],
    indexes: [
      // One order = one purchase. PARTIAL on `orderId IS NOT NULL`, which is
      // what lets the many `(vendorId, null)` purchase events coexist. This
      // index is also what makes `findOrCreatePurchase` unambiguous (no
      // "which purchase?" branch on the import hot path) and why no
      // `splitPurchase` operation is needed at all.
      {
        on: ["vendorId", "orderId"],
        unique: true,
        where: "{orderId} IS NOT NULL AND {deletedAt} IS NULL",
      },
      { on: ["date"] },
      { trigram: "orderId" },
      { trigram: "displayLabel" },
    ],
    checks: [
      { column: "spendingCategoryOrigin" },
      {
        name: "Purchase_statedTotal_whole_cent_check",
        sql: "{statedTotal} IS NULL OR abs({statedTotal} * 100 - round({statedTotal} * 100)) < 0.0000001",
      },
    ],
    relations: {
      vendor: "vendorId",
      expenses: { many: "expense" },
      images: { many: "entityAttachment" },
      settlementAllocations: { many: "financialTransactionAllocation" },
    },
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
        columnId: "vendorId",
        urlKey: "vendor",
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
          module: "~/entity/filter-behavior",
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
          {
            value: "gte500",
            label: "$500 and up",
            expand: { expenseTotalMin: 500 },
          },
          {
            value: "gte200",
            label: "$200 and up",
            expand: { expenseTotalMin: 200 },
          },
          {
            value: "gte100",
            label: "$100 and up",
            expand: { expenseTotalMin: 100 },
          },
          {
            value: "nonpositive",
            label: "Non-positive (≤ $0)",
            expand: { expenseTotalMax: 0 },
          },
        ],
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
      key: "spendingCategory",
      label: "Spending category",
      target: "spendingCategory",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Purchase.spendingCategoryId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Purchase.spendingCategoryId", direction: "incoming" }],
      },
    },
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
          { edge: "EntityAttachment.entityId", direction: "incoming" },
          { edge: "EntityAttachment.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "EntityAttachment.imageId", direction: "incoming" },
          { edge: "EntityAttachment.entityId", direction: "outgoing" },
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
              {
                edge: "EntityLink[purchaseProduct].from",
                direction: "incoming",
              },
              { edge: "EntityLink[purchaseProduct].to", direction: "outgoing" },
            ],
          },
          inverse: {
            steps: [
              { edge: "EntityLink[purchaseProduct].to", direction: "incoming" },
              {
                edge: "EntityLink[purchaseProduct].from",
                direction: "outgoing",
              },
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
        rowSchema: {
          module: "@cubby/schemas/purchase",
          export: "purchaseProductOut",
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
          id: "purchase_spending_category_origin",
          facet: "identity",
          label: "Review legacy fallback",
          message:
            "This stored Purchase fallback predates classification provenance. Review it before treating it as a deliberate default.",
        },
        {
          id: "purchase_evidence_expectation",
          facet: "paperwork",
          label: "Receipt expectation",
          message: "Whether this Purchase needs a receipt is unclassified.",
        },
        {
          id: "purchase_itemization",
          facet: "ledger",
          weight: 2,
          label: "Receipt itemization",
          message: "Expected receipt line itemization has not been reviewed.",
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
        module: "~/server/repo/purchase.repository",
        export: "purchaseRepository",
      },
      search: "document",
    },
  },
});
