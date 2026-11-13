import { defineEdge } from "./edges";
import { historicalDateRangePresets } from "../date-range";
import { idField, readOnly, timestampField } from "./field-policy";
import {
  attachedImageInputs,
  imageDescriptionInputs,
} from "./image-description-inputs";
import { financialTransactionReadSchemas } from "../financial-transaction-fields";
import { financialTransactionChildren } from "../child-tables/financialTransaction.js";
import { spendingCategorySummarySchema } from "../spending-classification";
import { financialTransactionCoverage } from "../purchase-evidence-policy";
import { spendingCategoryShortcode } from "../identifier-fields";
import { defineEntity, defineEntityModel } from "./definition.js";
import { displayItemsField, labelField } from "./label-field.js";
import { plainDate } from "@cubby/schemas/base-entity";
import {
  financialTransactionKind,
  financialTransactionStatus,
  financialTransactionAllocations,
  financialTransactionItemization,
  financialTransactionNonZeroAmount,
  descriptorProcessors,
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
export const generatedFinancialTransactionKindValues =
  financialTransactionKind.options;
export const generatedFinancialTransactionStatusValues =
  financialTransactionStatus.options;
export const { definition, readSchemas } = defineEntityModel(
  {
    key: "financialTransaction",
    edges: [
      defineEdge({
        key: "SourceOccurrence.acceptedTransactionId",
        from: "sourceOccurrence",
        to: "financialTransaction",
        cardinality: "one",
        inverse: {
          key: "financialTransaction.incoming.SourceOccurrence.acceptedTransactionId",
          from: "financialTransaction",
          to: "sourceOccurrence",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "SourceOccurrence.acceptedTransactionId",
          constrained: true,
        },
        ownership: {
          kind: "entity",
          entity: "sourceOccurrence",
        },
        fromEnd: {
          role: "reference",
          label: "target",
          description: "The referenced record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        toEnd: {
          role: "history",
          label: "accepted source reservation",
          description:
            "Acceptance remains reserved after transaction deletion.",
          liveness: {
            kind: "allow-target-deleted",
            reason:
              "A deleted accepted transaction never releases identity for automatic money recreation.",
          },
        },
        policies: {
          from: {
            delete: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
          to: {
            delete: {
              kind: "disposition",
              disposition: {
                code: "preserve-accepted-source-reservation",
                effect: "preserve",
                description:
                  "Deleting a transaction keeps its source reservation; it cannot recreate money through replay.",
              },
              handler: null,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "FinancialEvidenceAlias.historicalTransactionId",
        from: "row:FinancialEvidenceAlias",
        to: "financialTransaction",
        cardinality: "one",
        inverse: {
          key: "financialTransaction.incoming.FinancialEvidenceAlias.historicalTransactionId",
          from: "financialTransaction",
          to: "row:FinancialEvidenceAlias",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "FinancialEvidenceAlias.historicalTransactionId",
          constrained: true,
        },
        ownership: {
          kind: "excluded",
          reason: "Retained financial provenance, never current ownership.",
        },
        fromEnd: {
          role: "reference",
          label: "target",
          description: "The referenced record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        toEnd: {
          role: "history",
          label: "retained source bindings",
          description: "Former source bindings remain original evidence.",
          liveness: {
            kind: "allow-target-deleted",
            reason:
              "Retained provenance names transaction tombstones without establishing current ownership.",
          },
        },
        policies: {
          from: {
            delete: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
          to: {
            delete: {
              kind: "disposition",
              disposition: {
                code: "retire-financial-source-provenance",
                effect: "soft-delete",
                description:
                  "Deleting a transaction retires its reference bindings while preserving every alias row and provenance through tombstones. Proven source occurrence reservations remain independent.",
              },
              handler: null,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "EmailFinancialAssociation.transactionId",
        from: "row:EmailFinancialAssociation",
        to: "financialTransaction",
        cardinality: "one",
        inverse: {
          key: "financialTransaction.incoming.EmailFinancialAssociation.transactionId",
          from: "financialTransaction",
          to: "row:EmailFinancialAssociation",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "EmailFinancialAssociation.transactionId",
          constrained: true,
        },
        ownership: {
          kind: "column",
          column: "EmailFinancialAssociation.emailId",
        },
        fromEnd: {
          role: "reference",
          label: "target",
          description: "The referenced record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        toEnd: {
          role: "history",
          label: "reviewed Email associations",
          description:
            "A member-reviewed link from an Email's evidence to this transaction; the review keeps naming it after the transaction is deleted.",
          liveness: {
            kind: "allow-target-deleted",
            reason:
              "A reviewed Email-to-transaction association is append-only history that keeps its original UUIDs through every tombstone.",
          },
        },
        policies: {
          from: {
            delete: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
          to: {
            delete: {
              kind: "disposition",
              disposition: {
                code: "preserve-reviewed-email-association",
                effect: "preserve",
                description:
                  "A reviewed Email association keeps naming the deleted transaction's tombstone; the review is history and is never rewritten.",
              },
              handler: null,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "FinancialTransactionAllocation.transactionId",
        from: "row:FinancialTransactionAllocation",
        to: "financialTransaction",
        cardinality: "one",
        inverse: {
          key: "financialTransaction.incoming.FinancialTransactionAllocation.transactionId",
          from: "financialTransaction",
          to: "row:FinancialTransactionAllocation",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "FinancialTransactionAllocation.transactionId",
          constrained: true,
        },
        ownership: {
          kind: "column",
          column: "FinancialTransactionAllocation.transactionId",
        },
        fromEnd: {
          role: "reference",
          label: "target",
          description: "The referenced record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        toEnd: {
          role: "composition",
          label: "purchase allocations",
          description:
            "One slice of this transaction's amount, attributed to a single Purchase. The slices are meaningless apart from the charge whose amount they decompose: a transaction has either none of them, or a set that sums to its amount exactly and shares its sign.",
          liveness: {
            kind: "must-target-live",
          },
        },
        policies: {
          from: {
            delete: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
          to: {
            delete: {
              kind: "disposition",
              disposition: {
                code: "soft-delete-association",
                effect: "soft-delete",
                description:
                  "Deleting a settlement transaction soft-deletes the purchase allocations that decompose it. Those Purchases keep their expenses and their identity; they simply lose this piece of settlement evidence.",
              },
              handler: null,
              before: {
                module:
                  "~/server/domains/financial-transaction/repo/financial-transaction",
                export: "refuseTransferEvidence",
              },
              after: {
                module:
                  "~/server/domains/financial-transaction/repo/financial-transaction",
                export: "touchAllocatedPurchases",
              },
              beforeLock: {
                module:
                  "~/server/domains/financial-transaction/repo/financial-transaction",
                export: "lockFinancialTransactionDeletion",
              },
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
    ],

    names: { singular: "Financial Transaction", plural: "Transactions" },
    route: {
      listColumns: {
        module: "~/features/finance/list-columns",
        export: "financialTransactionListOverride",
      },
      basePath: "financial-transactions",
    },
    table: "FinancialTransaction",
    children: financialTransactionChildren,
    identifiers: {
      brand: "FinancialTransactionId",
      shortcode: "FTX-",
    },
    // Financial transactions have no name field and `merchant` is nullable;
    // `displayName` falls back through `rawDescription` and `kind` for a
    // human-identifying label that is never blank.
    presentation: {
      searchFacts: ["transactionDate", "amount"],
      edit: {
        sections: [
          {
            id: "schedule",
            title: "Schedule",
            fields: ["transactionDate", "postedDate"],
          },
          {
            id: "identity",
            title: "Identity",
            fields: ["merchant"],
          },
          {
            id: "details",
            title: "Details",
            fields: ["rawDescription", "sourceCategory"],
          },
          {
            id: "notes",
            title: "Notes",
            fields: ["notes"],
          },
        ],
      },
      list: {
        rail: [{ field: "amount", sub: "transactionDate" }],
        savedViews: [
          {
            id: "outstanding",
            label: "Outstanding",
            description: "Expected or pending — money that hasn't moved yet",
            // The owed-money list: an expected refund a vendor never issued, or a
            // credit still in flight. `postedDate` is null on these by construction
            // (posted entries require one), so the sort is really "most recently
            // recorded first".
            filters: [{ id: "status", value: ["expected", "pending"] }],
            sort: [{ id: "createdAt", desc: true }],
          },
          {
            id: "unlinked",
            label: "Not linked to a purchase",
            description: "Settlement evidence with no order attached",
            filters: [{ id: "purchasePresence", value: "none" }],
            sort: [{ id: "postedDate", desc: true }],
          },
        ],
      },
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
        phosphor: "CreditCard",
        sfSymbol: "arrow.left.arrow.right",
        emoji: "💳",
      },
      detail: {
        summary: [
          {
            kind: "fields",
            id: "amount-event",
            title: "Amount & event",
            fields: ["amount", "transactionDate", "kind", "status"],
          },
          {
            kind: "records",
            id: "account",
            title: "Account",
            viewKey: "relation:account",
          },
          {
            kind: "records",
            id: "purchase",
            title: "Purchase",
            viewKey: "relation:purchase",
          },
          // Web renders unallocated lines with the booking review form, which
          // belongs in the Record section rather than a glance cell.
          {
            kind: "fields",
            id: "reconciliation",
            title: "Reconciliation",
            fields: ["allocations"],
            surfaces: ["native"],
          },
          {
            kind: "records",
            id: "expenses",
            title: "Expenses",
            viewKey: "relation:expenses",
          },
          {
            kind: "report",
            id: "source-observations",
            title: "Source observations",
            slot: "financialTransaction.source-summary",
          },
          {
            kind: "fields",
            id: "classification-coverage",
            title: "Classification coverage",
            fields: [
              "bookingCoverage",
              "documentCoverage",
              "itemizationCoverage",
              "productsCoverage",
            ],
          },
          {
            kind: "chart",
            id: "monthly-spend",
            title: "Spend over 12 months",
            viewKey: "relation:expenses",
          },
        ],

        activityRelations: [
          { relation: "purchase", dateField: "date" },
          { relation: "expenses", dateField: "date" },
        ],
        omitRelations: {
          products:
            "Reached through the Purchases table on this page; the product path is three joins deep.",
        },
        sections: [
          {
            kind: "fields",
            id: "overview",
            title: "Record",
            fields: [
              "amount",
              "accountId",
              "kind",
              "status",
              "allocations",
              "itemizationExpectation",
              "sourceRefs",
            ],
          },
          {
            kind: "fields",
            id: "schedule",
            title: "Schedule",
            fields: ["postedDate"],
          },
          {
            kind: "fields",
            id: "identity",
            title: "Identity",
            fields: ["merchant"],
          },
          {
            kind: "fields",
            id: "coverage",
            title: "Coverage and summaries",
            fields: [
              "bookingCoverage",
              "documentCoverage",
              "itemizationCoverage",
              "productsCoverage",
              "spendingCategorySummary",
              "vendorInference",
            ],
          },
        ],
      },
    },
    model: {
      fields: [
        {
          output: false,
          key: "bookingDecisionFingerprint",
          kind: "text",
          nullable: true,
        },
        {
          output: false,
          key: "bookingExpenseFingerprint",
          kind: "text",
          nullable: true,
        },
        {
          output: false,
          key: "bookingCorrectionReceipt",
          kind: "json",
          nullable: true,
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
              {
                value: "missing",
                label: "Missing",
                color: "destructive",
              },
              {
                value: "partial",
                label: "Partial",
                color: "warning",
              },
              {
                value: "recorded",
                label: "Recorded",
                color: "positive",
              },
              {
                value: "not_applicable",
                label: "Not applicable",
                color: "neutral-status",
              },
              {
                value: "unclassified",
                label: "Unclassified",
                color: "neutral-status",
                glyph: {
                  phosphor: "Question",
                  sfSymbol: "questionmark.circle",
                },
              },
            ],
          },
          display: {
            columnGroup: "Evidence",
            columnLabel: "Booked",
            optionRole: "status",
            optionColor: "neutral-status",
          },
          validation: readOnly(financialTransactionCoverage.shape.booking),
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
              {
                value: "missing",
                label: "Missing",
                color: "destructive",
              },
              {
                value: "partial",
                label: "Partial",
                color: "warning",
              },
              {
                value: "present",
                label: "Present",
                color: "positive",
              },
              {
                value: "not_expected",
                label: "Not expected",
                color: "neutral-status",
              },
              {
                value: "unknown",
                label: "Unclassified",
                color: "neutral-status",
                glyph: {
                  phosphor: "Question",
                  sfSymbol: "questionmark.circle",
                },
              },
            ],
          },
          display: {
            columnGroup: "Evidence",
            columnLabel: "Documented",
            optionRole: "status",
            optionColor: "neutral-status",
          },
          validation: readOnly(financialTransactionCoverage.shape.document),
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
              {
                value: "missing",
                label: "Missing",
                color: "destructive",
              },
              {
                value: "partial",
                label: "Partial",
                color: "warning",
              },
              {
                value: "present",
                label: "Present",
                color: "positive",
              },
              {
                value: "not_expected",
                label: "Not expected",
                color: "neutral-status",
              },
              {
                value: "unknown",
                label: "Unclassified",
                color: "neutral-status",
                glyph: {
                  phosphor: "Question",
                  sfSymbol: "questionmark.circle",
                },
              },
            ],
          },
          display: {
            columnGroup: "Evidence",
            columnLabel: "Itemized",
            optionRole: "status",
            optionColor: "neutral-status",
          },
          validation: readOnly(financialTransactionCoverage.shape.itemization),
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
              {
                value: "missing",
                label: "Missing",
                color: "destructive",
              },
              {
                value: "partial",
                label: "Partial",
                color: "warning",
              },
              {
                value: "present",
                label: "Present",
                color: "positive",
              },
              {
                value: "not_expected",
                label: "Not expected",
                color: "neutral-status",
              },
              {
                value: "unknown",
                label: "Unclassified",
                color: "neutral-status",
                glyph: {
                  phosphor: "Question",
                  sfSymbol: "questionmark.circle",
                },
              },
            ],
          },
          display: {
            columnGroup: "Evidence",
            columnLabel: "Products",
            optionRole: "status",
            optionColor: "neutral-status",
          },
          validation: readOnly(financialTransactionCoverage.shape.products),
        },
        {
          display: { detail: false, list: false },
          key: "coverage",
          kind: "json",
          provenance: {
            kind: "derived",
            sources: [{ label: "Source evidence and booked expenses" }],
          },
          explanation: {
            ruleId: "financialTransaction.coverage",
            description:
              "Booking, itemization, and Product coverage are evaluated independently against household expectations; documents are optional.",
          },
          validation: readOnly(financialTransactionCoverage),
        },
        {
          key: "spendingCategorySummary",
          kind: "json",
          label: "Expense categories",
          provenance: {
            kind: "derived",
            sources: [{ label: "Live Expense category allocations" }],
          },
          display: {
            columnGroup: "Booking",
            columnLabel: "Categories",
            renderer: {
              detail: "spending-category-summary",
              list: "spending-category-summary",
            },
          },
          explanation: {
            ruleId: "financialTransaction.expense-category-summary",
            description:
              "Category context comes from linked live Expense lines. Settlement allocations identify Purchases; they do not attribute this transaction amount to individual categories.",
          },
          validation: readOnly(spendingCategorySummarySchema),
        },
        {
          key: "spendingCategoryId",
          kind: "identifier",
          nullable: true,
          reference: { entity: "spendingCategory" },
          display: { detail: false, list: false },
          validation: readOnly(
            spendingCategoryShortcode.nullable().default(null),
          ),
        },
        {
          key: "itemizationExpectation",
          description:
            "Leave blank to use the effective policy from linked records and the spending category.",
          kind: "enum",
          nullable: true,
          control: {
            kind: "select",
            suggest: {
              basis: [
                "purchaseId",
                "spendingCategoryId",
                "merchant",
                "rawDescription",
                "sourceCategory",
                "kind",
                "notes",
              ],
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
                color: "neutral-status",
                glyph: {
                  phosphor: "Question",
                  sfSymbol: "questionmark.circle",
                },
              },
              {
                value: "required",
                label: "Expected",
                description:
                  "Household expects the order's item lines with their Products",
                color: "info",
              },
              {
                value: "not_expected",
                label: "Not expected",
                description:
                  "Household does not expect item lines; one amount is enough",
                color: "neutral-status",
              },
            ],
          },
          display: {
            columnGroup: "Evidence",
            columnLabel: "Evidence",
            optionRole: "status",
            optionColor: "neutral-status",
          },
          resolution: {
            reset: { itemizationExpectation: null },
            resetSource: "transactionEvidence",
            redundancy: "eligible",
          },
          explanation: {
            evidence: { kind: "policyAggregate" },
            ruleId: "financialTransaction.effective-evidence-expectation",
            description:
              "Reviewed reimbursement expects no itemization. Otherwise an explicit transaction policy wins, followed by linked purchase policies and the transaction spending category.",
            projections: {
              list: "itemizationExpectation",
              detail: "itemizationExpectation",
              summary: "itemizationExpectation",
            },
            sourceDependencies: [
              {
                path: "fields.itemizationExpectation.result.decision.provenance.source",
                label: "Source",
              },
              {
                path: "fields.itemizationExpectation.current.assignment.value",
                label: "Stored override",
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
          key: "accountId",
          kind: "identifier",
          reference: { entity: "financialAccount" },
          control: { kind: "specialized", renderer: "entity-select" },
          display: {
            columnGroup: "Transaction",
            width: "md",
            mobile: { slot: "subtitle", priority: 10, interactive: true },
          },
          validation: {
            read: financialAccountShortcode,
            create: financialAccountShortcode,
            update: financialAccountShortcode.optional(),
          },
        },
        {
          audit: false,
          key: "purchaseId",
          kind: "identifier",
          nullable: true,
          reference: { entity: "purchase" },
          control: { kind: "specialized", renderer: "entity-select" },
          // Detail shows `allocations` instead: this mirror is NULL exactly
          // when a charge settles more than one purchase.
          display: { columnGroup: "Booking", detail: false, width: "sm" },
          validation: {
            read: purchaseShortcode.nullable(),
            create: purchaseShortcode.nullable().default(null),
            update: purchaseShortcode.nullable().optional(),
          },
        },
        {
          output: false,
          // Hosts the purchase-presence header filter: whether the charge is
          // linked to a purchase, read from the mirror column above.
          key: "purchasePresence",
          kind: "boolean",
          label: "Linked",
          display: {
            columnGroup: "Booking",
            detail: false,
            listHidden: true,
            width: "xs",
            readPath: "purchaseId",
            format: "presence",
            valueOptions: [
              {
                value: "yes",
                label: "Has purchase",
                color: "neutral-status",
              },
              {
                value: "no",
                label: "No purchase",
                color: "neutral-status",
              },
            ],
            optionRole: "status",
            optionColor: "neutral-status",
          },
          provenance: {
            kind: "derived",
            sources: [{ entity: "purchase", relation: "purchase" }],
          },
        },
        {
          key: "kind",
          kind: "enum",
          control: {
            kind: "select",
            initial: { value: "purchase" },
            options: [
              {
                value: "purchase",
                label: "Purchase",
                glyph: { phosphor: "ShoppingCart", sfSymbol: "cart" },
                color: "info",
              },
              {
                value: "refund",
                label: "Refund",
                glyph: {
                  phosphor: "ArrowUUpLeft",
                  sfSymbol: "arrow.uturn.left",
                },
                color: "positive",
              },
              {
                value: "account_transfer",
                label: "Account transfer",
                glyph: {
                  phosphor: "ArrowsLeftRight",
                  sfSymbol: "arrow.left.arrow.right",
                },
                color: "neutral-status",
              },
              {
                value: "credit_card_payment",
                label: "Card payment",
                glyph: { phosphor: "CreditCard", sfSymbol: "creditcard" },
                color: "neutral-status",
              },
              {
                value: "fee",
                label: "Fee",
                glyph: { phosphor: "Coins", sfSymbol: "dollarsign.circle" },
                color: "warning",
              },
              {
                value: "interest",
                label: "Interest",
                glyph: { phosphor: "Percent", sfSymbol: "percent" },
                color: "warning",
              },
              {
                value: "income",
                label: "Income",
                glyph: { phosphor: "Money", sfSymbol: "banknote" },
                color: "positive",
              },
              {
                value: "adjustment",
                label: "Adjustment",
                glyph: {
                  phosphor: "SlidersHorizontal",
                  sfSymbol: "slider.horizontal.3",
                },
                color: "neutral-status",
              },
              {
                value: "other",
                label: "Other",
                glyph: {
                  phosphor: "DotsThreeCircle",
                  sfSymbol: "ellipsis.circle",
                },
                color: "neutral-status",
              },
            ],
          },
          display: {
            columnGroup: "Transaction",
            width: "sm",
            optionRole: "category",
            optionColor: "domain-finance",
          },
          validation: {
            read: financialTransactionKind,
            create: financialTransactionKind,
            update: financialTransactionKind.optional(),
          },
        },
        {
          key: "status",
          kind: "enum",
          control: {
            kind: "select",
            initial: { value: "pending" },
            options: [
              {
                value: "expected",
                label: "Expected",
                color: "neutral-status",
              },
              { value: "observed", label: "Observed", color: "neutral-status" },
              {
                value: "pending",
                label: "Pending",
                color: "neutral-status",
              },
              {
                value: "posted",
                quiet: true,
                label: "Posted",
                color: "positive",
              },
              {
                value: "void",
                label: "Void",
                color: "destructive",
              },
            ],
          },
          display: {
            columnGroup: "Transaction",
            mobile: { slot: "meta", priority: 20 },
            optionRole: "status",
            optionColor: "neutral-status",
          },
          validation: {
            read: financialTransactionStatus,
            create: financialTransactionStatus,
            update: financialTransactionStatus.optional(),
          },
        },
        {
          key: "amount",
          kind: "number",
          // The canonical non-zero refinement reports a blank or zero amount
          // with its own message, so the generic required check steps aside.
          control: {
            kind: "number",
            renderer: "money",
            initial: { value: 0 },
            required: false,
          },
          display: {
            columnGroup: "Transaction",
            columnBar: true,
            width: "sm",
            format: "currency",
            mobile: { slot: "trailing", priority: 1 },
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
          control: { kind: "date" },
          display: {
            columnGroup: "Transaction",
            detail: false,
            columnLabel: "Date",
            format: "plainDate",
            mobile: { slot: "meta", priority: 25 },
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
          control: { kind: "date" },
          display: {
            columnGroup: "Transaction",
            format: "plainDate",
            mobile: { slot: "meta", priority: 30 },
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
          control: { kind: "text" },
          display: {
            columnGroup: "Transaction",
            width: "md",
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
          control: { kind: "textarea" },
          display: {
            columnGroup: "Transaction",
            detail: false,
            listHidden: true,
          },
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
          control: { kind: "text" },
          display: { columnGroup: "Evidence", detail: false, listHidden: true },
          validation: {
            read: z.string().nullable(),
            create: z.string().nullable().default(null),
            update: z.string().nullable().optional(),
          },
        },
        {
          key: "sourceRefs",
          semanticRole: "externalIdentifier",
          kind: "json",
          // Explicit occurrence handles plus retained evidence aliases; aliases do not resolve acceptance.
          provenance: {
            kind: "relation",
            sources: [{ label: "Settlement references" }],
          },
          // "Source" reproduces the list column's existing header text (its
          // `display.columnId` alias below). One label serves both surfaces,
          // so the detail page's overview heading for this field (which has
          // no override `label` of its own in financial-transaction-detail.tsx)
          // changes from "References" to "Source" as an accepted consequence
          // — same as accountId's "Account ID" -> "Account" ripple.
          control: { kind: "specialized", renderer: "source-refs" },
          display: {
            columnGroup: "Evidence",
            detailLabelPath: "sourceRefsLabel",
            listHidden: true,
            readPath: "sourceRefs[].source",
            format: "join",
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
          control: { kind: "textarea" },
          display: {
            columnGroup: "Evidence",
            detail: false,
            listHidden: true,
            width: "xl",
          },
          validation: {
            read: z.string().nullable(),
            create: z.string().nullable().default(null),
            update: z.string().nullable().optional(),
          },
        },
        {
          audit: false,
          key: "allocations",
          kind: "text-array",
          collection: { key: ["purchaseId"] },
          control: { kind: "specialized", renderer: "structured-field" },
          display: {
            list: false,
            renderer: { detail: "financial-transaction-allocations" },
            itemsPath: "allocationItems",
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
          key: "itemization",
          kind: "enum",
          display: {
            columnGroup: "Booking",
            detail: false,
            width: "sm",
            valueOptions: [
              {
                value: "bare",
                label: "No purchase",
                color: "neutral-status",
              },
              {
                value: "lump",
                label: "Lump order",
                color: "warning",
              },
              {
                value: "itemized_match",
                label: "Itemized, matches",
                color: "positive",
              },
              {
                value: "itemized_mismatch",
                label: "Itemized, differs",
                color: "destructive",
              },
              {
                value: "shared",
                label: "Shared charge",
                color: "info",
              },
            ],
            optionRole: "status",
            optionColor: "neutral-status",
          },
          provenance: {
            kind: "derived",
            sources: [{ entity: "purchase", relation: "purchase" }],
          },
          explanation: {
            ruleId: "financial-transaction.itemization",
            description:
              "Itemization compares the purchase this charge settles with its product-linked expense lines. A charge that shares its purchase with other live charges is reported as shared rather than compared.",
            readPath: "itemization",
            sourceDependencies: [
              { path: "allocations", label: "Confirmed allocations" },
            ],
          },
          validation: readOnly(financialTransactionItemization),
        },
        idField(financialTransactionShortcode),
        {
          display: { detail: false, list: false },
          key: "ledgerTransferId",
          kind: "identifier",
          nullable: true,
          reference: { entity: "ledgerTransfer" },
          validation: readOnly(ledgerTransferShortcode.nullable()),
        },
        {
          display: { detail: false, list: false },
          key: "spendingCategoryName",
          kind: "text",
          nullable: true,
          validation: readOnly(z.string().nullable()),
        },
        {
          display: { detail: false, list: false },
          key: "accountName",
          kind: "text",
          nullable: true,
          validation: readOnly(z.string().nullable()),
        },
        {
          key: "vendorInference",
          kind: "json",
          nullable: true,
          display: {
            columnGroup: "Evidence",
            labelPath: "vendorInference.candidates[].vendorName",
            detailLabelPath: "possibleVendorLabel",
            renderer: {
              list: "possible-vendor",
              detail: "financial-transaction-vendor-inference",
            },
            listHidden: true,
          },
          provenance: {
            kind: "derived",
            sources: [{ entity: "vendor", relation: "vendor" }],
          },
          explanation: {
            ruleId: "financial-transaction.vendor-inference",
            description:
              "Statement labels identify Vendors from independently confirmed purchase allocations across the household. One distinct Vendor is a match; competing Vendors stay ambiguous. Allocated, transfer, and void transactions suppress this fallback.",
            resolver: "merchantVendorInference",
            readPath: "vendorInference",
            sourceDependencies: [
              { path: "merchant", label: "Merchant label" },
              { path: "status", label: "Transaction status" },
              { path: "allocations", label: "Confirmed allocations" },
              { path: "ledgerTransferId", label: "Transfer link" },
              {
                path: "vendorInference",
                label: "Matching settled transactions",
              },
            ],
          },
          validation: readOnly(
            merchantVendorInference
              .nullable()
              .default(null)
              .describe(
                "Vendor identification from confirmed history for the exact normalized statement label. A single candidate identifies the Vendor; multiple candidates are ambiguous. Null when suppressed. Booking may use the identified Vendor without creating new confirmation evidence; allocations remain the confirmed relationship.",
              ),
          ),
        },
        {
          display: { detail: false, list: false },
          // `merchant?.trim() || rawDescription?.trim() || capitalize(kind)` —
          // the canonical non-null title for a row whose name-shaped fields are
          // all nullable.
          key: "displayName",
          kind: "text",
          validation: readOnly(z.string()),
        },
        timestampField("createdAt", { detail: false, list: false }),
        timestampField("updatedAt", { detail: false, list: false }),
        { output: false, key: "shortcode", kind: "text" },
        { output: false, key: "deletedAt", kind: "timestamp", nullable: true },
        // Server-composed text for the structured detail field above (`display.detailLabelPath`).
        labelField("sourceRefsLabel", "Settlement references"),
        displayItemsField(
          "allocationItems",
          "Confirmed allocation display rows",
        ),
        labelField("possibleVendorLabel", "Merchant vendor inference"),
      ],
      storage: [
        "bookingDecisionFingerprint",
        "bookingExpenseFingerprint",
        "bookingCorrectionReceipt",
        "spendingCategoryId",
        {
          key: "itemizationExpectation",
          specialized: "enum:itemizationExpectation",
        },
        {
          key: "id",
          specialized: "primary-key:FinancialTransactionId",
        },
        { key: "shortcode", specialized: "shortcode" },
        "accountId",
        "ledgerTransferId",
        { key: "kind", specialized: "enum:kind" },
        { key: "status", specialized: "enum:status" },
        { key: "amount", specialized: "minor-unit-money" },
        "transactionDate",
        "postedDate",
        "merchant",
        "rawDescription",
        "sourceCategory",
        "notes",
        { key: "createdAt" },
        { key: "updatedAt", specialized: "updated-at" },
        "deletedAt",
      ],

      rows: {
        runStepInputs: {
          label: "Run step inputs",
          repository: { token: "text" },
        },
        acceptedSourceRecords: {
          label: "Accepted source records",
          repository: { record: { reference: "sourceTransactionRecord" } },
        },
        settlementRefs: {
          label: "Settlement references",
          repository: { source: "text", externalId: "text" },
        },
      },
      derived: {
        runStepInput: { via: "runStepInputs.token" },
        sourceTransactionRecordId: { via: "acceptedSourceRecords.record" },
        merchant: { type: "text" },
        // Allocated to a live Purchase (not the mirror column, which is NULL
        // for a transaction split across two purchases).
        purchase: { via: "purchase" },
        itemization: {
          type: "enum",
          options: [
            "bare",
            "lump",
            "itemized_match",
            "itemized_mismatch",
            "shared",
          ],
        },
        // The allocation-integrity data-quality gap.
        allocationIntegrity: { type: "enum", options: ["defect"] },
        // The payment processor named by the raw descriptor's prefix, derived
        // on read (`descriptorProcessors`).
        descriptorProcessor: {
          type: "enum",
          options: descriptorProcessors.map((processor) => processor.value),
        },
        // Both match on the same live settlement reference.
        sourceRefs: { via: "settlementRefs.source" },
        externalId: { via: "settlementRefs.externalId" },
      },
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
            "itemizationExpectation",
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
    },
    // A settlement-side event. Amounts are evidence only: they never participate
    // in spend/project/calendar rollups, which remain derived from Expense.cost.
    storage: {
      indexes: [
        {
          name: "FinancialTransaction_ledgerTransferId_positive_evidence_key",
          on: ["ledgerTransferId"],
          unique: true,
          where:
            "{deletedAt} IS NULL AND {ledgerTransferId} IS NOT NULL AND {amount} > 0",
        },
        {
          name: "FinancialTransaction_ledgerTransferId_negative_evidence_key",
          on: ["ledgerTransferId"],
          unique: true,
          where:
            "{deletedAt} IS NULL AND {ledgerTransferId} IS NOT NULL AND {amount} < 0",
        },
        { on: ["kind"] },
        { on: ["status"] },
        { on: ["transactionDate"] },
        { on: ["postedDate"] },
        // Statement preview's date-window candidates share their row's
        // account; a serializable read locks only that account's date range.
        { on: ["accountId", "postedDate"], where: "{deletedAt} IS NULL" },
        { on: ["accountId", "transactionDate"], where: "{deletedAt} IS NULL" },
      ],
      checks: [
        {
          name: "FinancialTransaction_amount_minor_range_check",
          sql: "{amount} <> 0 AND abs({amount}) <= 100000000000000",
        },
        {
          name: "FinancialTransaction_posted_date_check",
          sql: "{status} <> 'posted' OR {postedDate} IS NOT NULL",
        },
      ],
      relations: {
        account: "accountId",
        allocations: { many: "financialTransactionAllocation" },
        ledgerTransfer: "ledgerTransferId",
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
          columnId: "itemizationExpectation",
          kind: "multiselect",
          deriveSchema: true,
          placeholder: "Filter by itemization expectation...",
        },
        {
          columnId: "runStepInput",
          kind: "text",
          label: "Run step input",
          placeholder: "RUN shortcode:step key",
          deriveSchema: true,
          schemaRef: {
            module: "@cubby/schemas/run-step-input",
            export: "runStepInputFilterToken",
          },
          derived: true,
        },
        {
          columnId: "sourceTransactionRecordId",
          kind: "idMulti",
          brandRef: { entity: "sourceTransactionRecord" },
          deriveSchema: true,
          placeholder: "Filter source records...",
        },
        {
          columnId: "allocationIntegrity",
          kind: "multiselect",
          placeholder: "Filter allocation integrity...",
        },
        {
          columnId: "descriptorProcessor",
          kind: "multiselect",
          placeholder: "Filter payment processor...",
        },
        {
          columnId: "transaction",
          field: "search",
          urlKey: "q",
          kind: "text",
          placeholder: "Search transactions...",
          deriveSchema: true,
          schemaDescription: "Substring match on merchant or raw description",
          anyOf: ["merchant", "rawDescription"],
        },
        {
          columnId: "kind",
          kind: "multiselect",
          placeholder: "Filter by kind...",
          deriveSchema: true,
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
          schemaFromRead: true,
          options: [
            { value: "expected", label: "Expected" },
            { value: "observed", label: "Observed" },
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
          options: [...historicalDateRangePresets],
          expandRef: {
            module: "~/entity/filter-behavior",
            export: "resolvePostedDate",
          },
        },
        {
          columnId: "accountId",
          kind: "idMulti",
          placeholder: "Filter by account...",
          brandRef: { entity: "financialAccount" },
          deriveSchema: true,
        },
        {
          columnId: "purchaseId",
          kind: "idMulti",
          placeholder: "Filter by purchase...",
          brandRef: { entity: "purchase" },
          derived: "purchase",
        },
        {
          columnId: "purchasePresence",
          field: "purchasePresenceFilter",
          kind: "presence",
          derived: "purchase",
          placeholder: "Filter purchase links...",
          options: [
            { value: "has", label: "Has purchase", meta: true },
            { value: "none", label: "(none)", meta: true },
          ],
        },
        {
          columnId: "itemization",
          kind: "multiselect",
          placeholder: "Filter itemization...",
          options: [
            { value: "bare", label: "No purchase" },
            { value: "lump", label: "Lump order" },
            { value: "itemized_match", label: "Itemized, matches" },
            { value: "itemized_mismatch", label: "Itemized, differs" },
            { value: "shared", label: "Shared charge" },
          ],
        },
        {
          columnId: "sourceRefs",
          field: "source",
          urlKey: "source",
          wire: { kind: "param", name: "source" },
          kind: "multiselect",
          placeholder: "Filter by source...",
          optionsKey: "source",
        },
        {
          columnId: "externalId",
          kind: "multiselect",
          placeholder: "Filter by external id...",
        },
        {
          columnId: "merchant",
          kind: "text",
          placeholder: "Filter by merchant...",
          deriveSchema: true,
          anyOf: ["merchant"],
        },
        {
          columnId: "transactionDate",
          kind: "range",
          placeholder: "Filter by transaction date...",
          deriveSchema: true,
          stored: true,
        },
        {
          columnId: "amount",
          kind: "range",
          placeholder: "Filter by amount...",
          deriveSchema: true,
          stored: true,
          options: [
            {
              value: "gte1000",
              label: "$1,000 and up",
              expand: { amountMin: 1000 },
            },
            {
              value: "gte250",
              label: "$250 and up",
              expand: { amountMin: 250 },
            },
            { value: "gte50", label: "$50 and up", expand: { amountMin: 50 } },
            {
              value: "credits",
              label: "Credits (≤ $0)",
              expand: { amountMax: 0 },
            },
          ],
        },
        {
          columnId: "amountMin",
          kind: "text",
          placeholder: "Minimum amount...",
        },
        {
          columnId: "amountMax",
          kind: "text",
          placeholder: "Maximum amount...",
        },
        {
          columnId: "transactionDateFrom",
          kind: "text",
          placeholder: "Transaction date from...",
        },
        {
          columnId: "transactionDateTo",
          kind: "text",
          placeholder: "Transaction date to...",
        },
        {
          columnId: "postedDateFrom",
          kind: "text",
          placeholder: "Posted date from...",
        },
        {
          columnId: "postedDateTo",
          kind: "text",
          placeholder: "Posted date to...",
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
        },
        {
          columnId: "vendorPresenceFilter",
          kind: "presence",
          placeholder: "Filter related vendor presence...",
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
        },
        {
          columnId: "expensePresenceFilter",
          kind: "presence",
          placeholder: "Filter related expenses presence...",
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
        },
        {
          columnId: "productPresenceFilter",
          kind: "presence",
          placeholder: "Filter related products presence...",
        },
      ],
    },

    // Related rows the search document reads (ADR 0021).
    search: {
      mode: "lexical",
      inputs: [
        ...imageDescriptionInputs("financialTransaction"),

        {
          table: "FinancialTransactionAllocation",
          match: { transactionId: "id" },
        },
        {
          table: "Purchase",
          match: { id: "id" },
          path: [
            {
              table: "FinancialTransactionAllocation",
              from: "purchaseId",
              to: "transactionId",
            },
          ],
        },
        {
          table: "Vendor",
          match: { id: "id" },
          columns: ["name", "deletedAt", "itemizationExpectation"],
          path: [
            { table: "Purchase", from: "vendorId", to: "id" },
            {
              table: "FinancialTransactionAllocation",
              from: "purchaseId",
              to: "transactionId",
            },
          ],
        },
        {
          table: "FinancialEvidenceAlias",
          match: { historicalTransactionId: "id" },
        },
        { table: "SourceOccurrence", match: { acceptedTransactionId: "id" } },
        { table: "FinancialAccount", match: { id: "accountId" } },
      ],
    },
    capabilities: {
      suggestions: ["statement_transaction", "transfer_pair"],
      images: {
        storage: false,
        displaySourceOverrides: [
          {
            relationPath: ["purchase"],
            ordering: "newest",
          },
          {
            relationPath: ["products"],
          },
          {
            relationPath: ["vendor"],
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
          candidateFields: ["merchant", "rawDescription"],
          temporalFields: ["transactionDate"],
          lifecycleFilters: [{ field: "status", equals: "posted" }],
          signals: {
            ocrFields: ["merchant", "rawDescription"],
            classifierLabels: ["receipt", "credit_card"],
          },
          abstention: { minimumScore: 0.8, minimumMargin: 0.16 },
        },
      },
      delete: { mode: "soft", bulk: true },
      merge: false,
      dataQuality: {
        inputs: [
          { table: "SourceOccurrence", match: { acceptedTransactionId: "id" } },
          {
            table: "FinancialEvidenceAlias",
            match: { historicalTransactionId: "id" },
          },
          {
            table: "FinancialTransactionAllocation",
            match: { transactionId: "id" },
            columns: ["deletedAt", "purchaseId"],
            path: [{ table: "FinancialTransaction", from: "id", to: "id" }],
          },
          {
            table: "Purchase",
            match: { id: "id" },
            columns: ["deletedAt", "id"],
            path: [
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
              { table: "FinancialTransaction", from: "id", to: "id" },
            ],
          },
          ...attachedImageInputs([
            { table: "Purchase", from: "id", to: "id" },
            {
              table: "FinancialTransactionAllocation",
              from: "purchaseId",
              to: "transactionId",
            },
            { table: "FinancialTransaction", from: "id", to: "id" },
          ]),
          {
            table: "Expense",
            match: { purchaseId: "id" },
            columns: [
              "deletedAt",
              "productId",
              "purchaseId",
              "projectId",
              "lineKind",
            ],
            path: [
              { table: "Purchase", from: "id", to: "id" },
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
              { table: "FinancialTransaction", from: "id", to: "id" },
            ],
          },
          {
            table: "Product",
            match: { id: "id" },
            columns: ["deletedAt", "id"],
            path: [
              { table: "Expense", from: "productId", to: "purchaseId" },
              { table: "Purchase", from: "id", to: "id" },
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
              { table: "FinancialTransaction", from: "id", to: "id" },
            ],
          },
          ...attachedImageInputs([
            { table: "Product", from: "id", to: "id" },
            { table: "Expense", from: "productId", to: "purchaseId" },
            { table: "Purchase", from: "id", to: "id" },
            {
              table: "FinancialTransactionAllocation",
              from: "purchaseId",
              to: "transactionId",
            },
            { table: "FinancialTransaction", from: "id", to: "id" },
          ]),
          {
            table: "Purchase",
            match: { id: "id" },
            columns: ["deletedAt", "vendorId"],
            path: [
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
              { table: "FinancialTransaction", from: "id", to: "id" },
            ],
          },
          {
            table: "Vendor",
            match: { id: "id" },
            columns: ["deletedAt", "id"],
            path: [
              { table: "Purchase", from: "vendorId", to: "id" },
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
              { table: "FinancialTransaction", from: "id", to: "id" },
            ],
          },
          ...attachedImageInputs([
            { table: "Vendor", from: "id", to: "id" },
            { table: "Purchase", from: "vendorId", to: "id" },
            {
              table: "FinancialTransactionAllocation",
              from: "purchaseId",
              to: "transactionId",
            },
            { table: "FinancialTransaction", from: "id", to: "id" },
          ]),
          {
            table: "Product",
            match: { id: "id" },
            columns: ["deletedAt", "brandId"],
            path: [
              { table: "Expense", from: "productId", to: "purchaseId" },
              { table: "Purchase", from: "id", to: "id" },
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
              { table: "FinancialTransaction", from: "id", to: "id" },
            ],
          },
          {
            table: "Vendor",
            match: { id: "id" },
            columns: ["deletedAt", "id"],
            path: [
              { table: "Product", from: "brandId", to: "id" },
              { table: "Expense", from: "productId", to: "purchaseId" },
              { table: "Purchase", from: "id", to: "id" },
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
              { table: "FinancialTransaction", from: "id", to: "id" },
            ],
          },
          ...attachedImageInputs([
            { table: "Vendor", from: "id", to: "id" },
            { table: "Product", from: "brandId", to: "id" },
            { table: "Expense", from: "productId", to: "purchaseId" },
            { table: "Purchase", from: "id", to: "id" },
            {
              table: "FinancialTransactionAllocation",
              from: "purchaseId",
              to: "transactionId",
            },
            { table: "FinancialTransaction", from: "id", to: "id" },
          ]),
          {
            table: "FinancialTransactionAllocation",
            match: { transactionId: "id" },
          },
          {
            table: "Purchase",
            match: { id: "id" },
            path: [
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
            ],
          },
          {
            table: "Vendor",
            match: { id: "id" },
            columns: ["name", "deletedAt", "itemizationExpectation"],
            path: [
              { table: "Purchase", from: "vendorId", to: "id" },
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
            ],
          },
          {
            table: "Expense",
            match: { purchaseId: "id" },
            path: [
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
            ],
          },
          {
            table: "EntityLink",
            match: { fromEntityId: "id" },
            path: [
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
            ],
          },
          {
            table: "SpendingCategory",
            match: { id: "id" },
            columns: ["deletedAt", "itemizationExpectation"],
            path: [
              { table: "Purchase", from: "spendingCategoryId", to: "id" },
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
            ],
          },
          {
            table: "SpendingCategory",
            match: { id: "spendingCategoryId" },
            columns: ["deletedAt", "itemizationExpectation"],
          },
          {
            table: "Product",
            match: { id: "id" },
            columns: ["categoryId", "deletedAt"],
            path: [
              { table: "Expense", from: "productId", to: "purchaseId" },
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
            ],
          },
          {
            table: "ProductCategory",
            match: { id: "id" },
            columns: [
              "parentId",
              "feature",
              "spendingCategoryId",
              "spendingCategoryMode",
              "deletedAt",
            ],
            path: [
              { table: "Product", from: "categoryId", to: "id" },
              { table: "Expense", from: "productId", to: "purchaseId" },
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
            ],
          },
          {
            table: "ImportSourceOrder",
            match: { purchaseId: "id" },
            path: [
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
            ],
          },
          {
            table: "ImportSourceProduct",
            match: { sourceOrderId: "id" },
            path: [
              { table: "ImportSourceOrder", from: "id", to: "purchaseId" },
              {
                table: "FinancialTransactionAllocation",
                from: "purchaseId",
                to: "transactionId",
              },
            ],
          },
        ],

        exceptions: true,
        checks: [
          {
            id: "financial_transaction_allocation_integrity",
            satisfiedLabel: "Allocations consistent",
            placement: { field: "allocations" },
            facet: "integrity",
            kind: "defect",
            exceptions: "forbidden",
            label: "Allocation integrity",
            message: "Allocated totals or signs conflict with this settlement.",
          },
          {
            id: "financial_transaction_classification",
            satisfiedLabel: "Transaction classified",
            placement: { field: "kind" },
            facet: "identity",
            exceptions: "forbidden",
            label: "Transaction classification",
            message:
              "Review whether this transaction is spending, income, or a transfer.",
          },
          {
            id: "financial_transaction_allocation",
            satisfiedLabel: "Allocation recorded",
            placement: { field: "allocations" },
            facet: "ledger",
            label: "Allocation",
            message: "No purchase allocation is recorded for this settlement.",
          },
          {
            id: "financial_transaction_merchant",
            satisfiedLabel: "Merchant recorded",
            placement: { field: "merchant" },
            facet: "identity",
            label: "Merchant",
            message: "No merchant is recorded for this transaction.",
          },
          {
            id: "financial_transaction_itemization_expectation",
            satisfiedLabel: "Itemization expectation classified",
            placement: { field: "itemizationExpectation" },
            facet: "paperwork",
            exceptions: "forbidden",
            label: "Itemization expectation",
            message:
              "Whether this transaction's purchases should be itemized is unclassified.",
          },
          {
            id: "financial_transaction_booking",
            satisfiedLabel: "Expenses booked",
            placement: { field: "bookingCoverage" },
            facet: "ledger",
            label: "Expense booking",
            message:
              "This spending transaction has missing or unpriced Expense booking.",
          },
          {
            id: "financial_transaction_itemization",
            satisfiedLabel: "Itemized",
            placement: { field: "itemizationCoverage" },
            facet: "ledger",
            label: "Itemization",
            message:
              "A linked Purchase is not yet broken into item lines with their Products.",
          },
          {
            id: "financial_transaction_products",
            satisfiedLabel: "Goods identified",
            placement: { field: "productsCoverage" },
            facet: "identity",
            label: "Goods identity",
            message: "Purchased goods have unresolved Product identities.",
          },
        ],
      },
    },
    extensions: {
      ports: {
        reports: {
          module: "~/server/domains/financial-transaction/repo/report-bindings",
          export: "reportBindings",
        },
        repository: {
          module:
            "~/server/domains/financial-transaction/repo/financial-transaction",
          export: "financialTransactionRepository",
        },
        search: "document",
      },
    },
  },
  financialTransactionReadSchemas,
);

export default defineEntity(
  definition,
  (r) => ({
    edges: [
      r.declare(
        r
          .derived("sourceTransactionRecord", "many", "transactionId", [
            "SourceOccurrence.acceptedTransactionId",
            "SourceTransactionRecord.occurrenceId",
          ])
          .named("sourceRecords", "Source transaction records", {
            sources: [
              r
                .query("transactionSourceRecords", "many")
                .source("accepted", "Accepted source observations"),
            ],
          }),
        "sourceTransactionRecord.transactions",
      ),
      r.declare(
        r
          .field("spendingCategoryId")
          .named("spendingCategory", "Spending category"),
        "spendingCategory.transactions",
      ),
      r.declare(
        r.field("accountId").named("account", "Financial account"),
        "financialAccount.transactions",
      ),
      r.declare(
        r.field("ledgerTransferId").named("ledger-transfer", "Ledger transfer"),
        "ledgerTransfer.evidence-transactions",
      ),
      r.declare(
        r
          .path("purchase", "many", [
            {
              edge: "FinancialTransactionAllocation.transactionId",
              direction: "incoming",
            },
            {
              edge: "FinancialTransactionAllocation.purchaseId",
              direction: "outgoing",
            },
          ])
          .named("purchase", "Purchase"),
        "purchase.financial-transactions",
      ),
      r.declare(
        r
          .path("vendor", "many", [
            {
              edge: "FinancialTransactionAllocation.transactionId",
              direction: "incoming",
            },
            {
              edge: "FinancialTransactionAllocation.purchaseId",
              direction: "outgoing",
            },
            { edge: "Purchase.vendorId", direction: "outgoing" },
          ])
          .named("vendor", "Vendor", {
            view: { columnGroup: "Booking", defaultVisible: true },
          }),
        "vendor.transactions",
      ),
      r.declare(
        r
          .path("expense", "many", [
            {
              edge: "FinancialTransactionAllocation.transactionId",
              direction: "incoming",
            },
            {
              edge: "FinancialTransactionAllocation.purchaseId",
              direction: "outgoing",
            },
            { edge: "Expense.purchaseId", direction: "incoming" },
          ])
          .named("expenses", "Expenses", {
            view: { columnGroup: "Booking", order: "newest" },
          }),
        "expense.transactions",
      ),
      // Explicit purchase links remain evidence before an Expense is itemized.
      r.declare(
        r
          .path("product", "many", [
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
          ])
          .named("products", "Products", {
            view: { columnGroup: "Booking" },
            sources: [
              r
                .path("product", "many", [
                  {
                    edge: "FinancialTransactionAllocation.transactionId",
                    direction: "incoming",
                  },
                  {
                    edge: "FinancialTransactionAllocation.purchaseId",
                    direction: "outgoing",
                  },
                  {
                    edge: "EntityLink[purchaseProduct].from",
                    direction: "incoming",
                  },
                  {
                    edge: "EntityLink[purchaseProduct].to",
                    direction: "outgoing",
                  },
                ])
                .source("explicit", "Explicit purchase product link"),
            ],
          }),
        "product.financialTransaction.products",
      ),
    ],
  }),
  readSchemas,
);
