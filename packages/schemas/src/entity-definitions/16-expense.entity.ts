import { defineEntity } from "./definition.js";
import { selectControlOptions } from "./select-control-options.js";
import { plainDate } from "@cubby/schemas/base-entity";
import {
  costTypeSchema,
  signedProductQuantity,
} from "@cubby/schemas/expense-fields";
import {
  expenseLineBasisSchema,
  expenseLineKindSchema,
} from "@cubby/schemas/expense-line-kind";
import {
  expenseShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  vendorShortcode,
} from "../identifier-fields.js";
import { imageUrlSummary } from "@cubby/schemas/image-summary";
import { ledgerAttributions } from "@cubby/schemas/ledger-party-fields";
import {
  ledgerSourceClaims,
  ledgerSourceClaimsOut,
} from "@cubby/schemas/ledger-transfer-fields";
import { wholeCentAmount } from "@cubby/schemas/money";
import { tradeSchema } from "@cubby/schemas/task-fields";
import { z } from "zod";
import {
  optionalFieldResolutionsSchema,
  optionalProjectAllocationsSchema,
} from "@cubby/schemas/field-resolution";
export default defineEntity({
  key: "expense",
  names: { singular: "Expense", plural: "Expenses" },
  route: { basePath: "expenses" },
  table: "Expense",
  identifiers: { brand: "ExpenseId", shortcode: "EXP-" },
  presentation: {
    titleField: "name",
    domain: "finance",
    description: "The authoritative record of household spend.",
    emptyState: {
      title: "No expenses yet",
      description:
        "Log what you've bought (or plan to) to keep a project's running cost honest.",
      actionLabel: "New Expense",
    },
    icons: {
      phosphor: "Receipt",
      sfSymbol: "dollarsign.circle",
      emoji: "💸",
    },
    detail: {
      omitRelations: {
        transactions:
          "The settlement slot renders the transactions that settle this expense.",
      },
      additionalSectionOverrides: [
        {
          kind: "fields",
          id: "purchase",
          title: "Purchase",
          placement: "supporting",
          fields: ["purchaseId"],
        },
        {
          kind: "slot",
          id: "settlement",
          title: "Settlement",
          placement: "supporting",
        },
      ],
    },
    list: {
      viewOverrides: [
        "table",
        {
          kind: "slot",
          id: "analytics",
          label: "Analytics",
          searchKeys: [
            "analyzeRows",
            "analyzeColumns",
            "analyzeMetric",
            "analyzeCompare",
            "analyzeShow",
          ],
        },
      ],
      actionOverrides: ["bulkEdit", "delete"],
    },
    // Mirrors the capture dialog's old hand-rolled behavior: a line with a
    // product picked has no separate "line kind" (it IS the product's
    // purchase), and a quantity is only meaningful once a product is set.
    edit: {
      hiddenWhen: [
        { field: "productId", present: true, fields: ["lineKind"] },
        { field: "productId", present: false, fields: ["productQuantity"] },
      ],
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
        key: "projectAllocations",
        kind: "json",
        validation: {
          read: optionalProjectAllocationsSchema,
          create: null,
          update: null,
        },
      },
      {
        key: "name",
        kind: "text",
        control: { kind: "text", placeholder: "What did you buy?" },
        display: {
          list: true,
          detail: true,
          standard: "name",
        },
        validation: {
          read: z.string().min(1),
          create: z.string().min(1),
          update: z.string().min(1).optional(),
        },
      },
      {
        key: "cost",
        kind: "number",
        nullable: true,
        control: {
          kind: "number",
          renderer: "money",
          sectionOverride: "details",
        },
        display: {
          list: true,
          detail: true,
          format: "currency",
          mobile: { slot: "trailing", priority: 1 },
        },
        validation: {
          read: wholeCentAmount.describe("Dollars").nullable(),
          create: wholeCentAmount.nullable().default(null),
          update: wholeCentAmount.nullable().optional(),
        },
      },
      {
        key: "date",
        kind: "date",
        nullable: true,
        control: {
          kind: "date",
          sectionOverride: "schedule",
          initial: "today",
        },
        display: { list: true, detail: true },
        validation: {
          read: plainDate.nullable(),
          create: plainDate.nullable(),
          update: plainDate.nullable().optional(),
        },
      },
      {
        key: "lineKind",
        kind: "enum",
        control: {
          kind: "select",
          options: selectControlOptions.expenseLineKind,
          sectionOverride: "details",
          suggest: { basis: ["name", "cost", "notes"] },
        },
        display: {
          list: true,
          detail: true,
          width: "md",
          mobile: { slot: "meta", priority: 18 },
        },
        validation: {
          read: expenseLineKindSchema.describe(
            "Receipt role. Principal lines are the purchased item/service; every other value is a purchase-level adjustment.",
          ),
          create: expenseLineKindSchema.optional(),
          update: expenseLineKindSchema.optional(),
        },
      },
      {
        key: "lineBasis",
        kind: "enum",
        control: {
          kind: "select",
          options: selectControlOptions.expenseLineBasis,
          sectionOverride: "details",
        },
        display: {
          list: true,
          detail: true,
          listHidden: true,
          width: "md",
        },
        validation: {
          read: expenseLineBasisSchema.describe(
            "Whether this row is a line item or a slice of a total that was never itemized. 'allocation' means the money was cut by payment schedule (a deposit and a balance on one order) or by an estimated materials/labor split of a lump-sum contract — such a row can never carry a productId, and its costType may be an estimate rather than a vendor-stated fact.",
          ),
          create: expenseLineBasisSchema.default("item_line"),
          update: expenseLineBasisSchema.optional(),
        },
      },
      {
        key: "costType",
        kind: "enum",
        control: {
          kind: "select",
          options: selectControlOptions.costType,
          sectionOverride: "details",
          suggest: { basis: ["name", "productId", "vendor"] },
        },
        display: {
          list: true,
          detail: true,
          width: "sm",
          mobile: { slot: "meta", priority: 20 },
        },
        validation: {
          read: costTypeSchema,
          create: costTypeSchema,
          update: costTypeSchema.optional(),
        },
      },
      {
        key: "trade",
        kind: "enum",
        nullable: true,
        control: {
          kind: "select",
          options: selectControlOptions.trade,
          sectionOverride: "details",
          suggest: {
            basis: ["name", "notes", "productId", "vendor", "projectId"],
          },
        },
        display: {
          list: true,
          detail: true,
          width: "sm",
          mobile: { slot: "meta", priority: 60 },
        },
        resolution: {
          reset: { trade: null },
          redundancy: "eligible",
        },
        explanation: {
          ruleId: "expense.effective-trade",
          description:
            "An expense trade override wins; otherwise the expense uses its purchase default trade, then its effective project's default trade.",
          projections: {
            list: "fieldResolutions.trade.value",
            detail: "fieldResolutions.trade.value",
            summary: "fieldResolutions.trade.value",
          },
          sourceDependencies: [
            { path: "fieldResolutions.trade.sourceEntity", label: "Source" },
            {
              path: "fieldResolutions.trade.storedValue",
              label: "Stored override",
            },
            {
              path: "fieldResolutions.trade.fallbackValue",
              label: "Inherited value",
            },
          ],
        },
        validation: {
          read: tradeSchema.nullable(),
          create: tradeSchema.nullable().default(null),
          update: tradeSchema.nullable().optional(),
        },
      },
      {
        key: "url",
        kind: "text",
        nullable: true,
        control: { kind: "text", renderer: "url", sectionOverride: "details" },
        display: { list: true, detail: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        control: { kind: "textarea", sectionOverride: "details" },
        display: { list: true, detail: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "future",
        kind: "boolean",
        control: { kind: "checkbox", sectionOverride: "details" },
        display: { list: true, detail: true },
        validation: {
          read: z.boolean(),
          create: z.boolean().default(false),
          update: z.boolean().optional(),
        },
      },
      {
        key: "projectId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "project" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: { basis: ["name", "vendor", "productId", "date"] },
        },
        display: {
          list: true,
          detail: true,
          renderer: { detail: "expense-project" },
        },
        resolution: {
          reset: { projectId: null },
          redundancy: "eligible",
        },
        explanation: {
          ruleId: "expense.effective-project",
          description:
            "A principal expense project override wins; otherwise the expense uses its purchase's default project, then Household for food or Unassigned. Purchase-level adjustments are allocated across the purchase's principal project totals.",
          projections: {
            list: "fieldResolutions.projectId.value",
            detail: "fieldResolutions.projectId.value",
            summary: "fieldResolutions.projectId.value",
          },
          sourceDependencies: [
            {
              path: "fieldResolutions.projectId.sourceEntity",
              label: "Source",
            },
            {
              path: "fieldResolutions.projectId.storedValue",
              label: "Stored override",
            },
            {
              path: "fieldResolutions.projectId.fallbackValue",
              label: "Inherited value",
            },
          ],
        },
        validation: {
          read: projectShortcode.nullable(),
          create: projectShortcode.nullable().default(null),
          update: projectShortcode.nullable().optional(),
        },
      },
      {
        key: "productId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "product" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: { basis: ["name", "vendor"] },
        },
        display: {
          list: true,
          detail: true,
        },
        validation: {
          read: productShortcode
            .describe(
              "Optional link to the product this expense bought. A negative-cost expense on the same product records an exit (sale, return, or a 0-cost disposal).",
            )
            .nullable(),
          create: productShortcode.nullable().default(null),
          update: productShortcode.nullable().optional(),
        },
      },
      {
        key: "productQuantity",
        kind: "number",
        nullable: true,
        control: { kind: "number", sectionOverride: "details" },
        display: { list: true, detail: true },
        validation: {
          read: signedProductQuantity
            .describe(
              'Product units covered by this expense; fractional values are allowed (half a coil thrown away is -0.5). Null means the receipt does not establish quantity. Signed: money direction wins, so a positive-cost line is an acquisition of |qty| and a negative-cost line is an exit of |qty|. On a $0 line the sign IS the fact — a positive quantity is a free acquisition (promo pack, bundled accessory), a negative quantity is a discard/write-off. Zero is legal ONLY on a negative-cost line and means money came back but no unit left — a price concession with the item kept (Amazon "Account adjustment", a partial refund for shipping damage). Prefer 0 over null there: null says the count is unknown and gets reported as data-entry debt.',
            )
            .nullable(),
          create: signedProductQuantity
            .nullable()
            .default(null)
            .describe(
              'Product units covered by this expense; fractional values are allowed (half a coil thrown away is -0.5). Null means the receipt does not establish quantity. Signed: money direction wins, so a positive-cost line is an acquisition of |qty| and a negative-cost line is an exit of |qty|. On a $0 line the sign IS the fact — a positive quantity is a free acquisition (promo pack, bundled accessory), a negative quantity is a discard/write-off. Zero is legal ONLY on a negative-cost line and means money came back but no unit left — a price concession with the item kept (Amazon "Account adjustment", a partial refund for shipping damage). Prefer 0 over null there: null says the count is unknown and gets reported as data-entry debt.',
            ),
          update: signedProductQuantity.nullable().optional(),
        },
      },
      {
        key: "vendor",
        kind: "text",
        nullable: true,
        control: {
          kind: "specialized",
          renderer: "vendor-name",
          sectionOverride: "details",
          suggest: { basis: ["name", "notes", "orderId"] },
        },
        display: { detail: true },
        provenance: { kind: "relation", sources: [{ entity: "vendor" }] },
        explanation: {
          ruleId: "expense.vendor",
          description:
            "Vendor is resolved from the live purchase linked to this expense.",
          readPath: "vendor",
          sourceDependencies: [
            { path: "purchaseId", label: "Linked purchase" },
          ],
        },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "orderId",
        kind: "text",
        nullable: true,
        control: { kind: "text", sectionOverride: "details" },
        display: {
          list: true,
          detail: true,
          listHidden: true,
        },
        provenance: {
          kind: "relation",
          sources: [{ entity: "purchase", relation: "purchase" }],
        },
        explanation: {
          ruleId: "expense.order-id",
          description:
            "Order number is resolved from the live purchase linked to this expense.",
          readPath: "orderId",
          sourceDependencies: [
            { path: "purchaseId", label: "Linked purchase" },
          ],
        },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "purchaseId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "purchase" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          list: true,
          detail: true,
        },
        validation: {
          read: purchaseShortcode.nullable(),
          create: purchaseShortcode.nullable().default(null),
          update: purchaseShortcode.nullable().optional(),
        },
      },
      {
        key: "beneficiaries",
        kind: "json",
        control: { kind: "specialized", renderer: "ledger-attributions" },
        provenance: {
          kind: "relation",
          sources: [{ label: "Ledger attributions" }],
        },
        explanation: {
          ruleId: "expense.beneficiaries",
          description:
            "Beneficiaries are the live beneficiary attributions recorded for this expense; deleted parties remain visible as unresolved attribution rows.",
          resolver: "expenseAttribution",
          readPath: "beneficiaries",
          sourceDependencies: [
            { path: "beneficiaries", label: "Beneficiary attributions" },
          ],
          actions: ["editSource"],
        },
        validation: {
          read: ledgerAttributions,
          create: ledgerAttributions.nullable().default([]),
          update: ledgerAttributions.nullable().optional(),
        },
      },
      {
        key: "funders",
        kind: "json",
        control: { kind: "specialized", renderer: "ledger-attributions" },
        provenance: {
          kind: "relation",
          sources: [{ label: "Ledger attributions" }],
        },
        explanation: {
          ruleId: "expense.funders",
          description:
            "Funders are the live funder attributions recorded for this expense; deleted parties remain visible as unresolved attribution rows.",
          resolver: "expenseAttribution",
          readPath: "funders",
          sourceDependencies: [
            { path: "funders", label: "Funder attributions" },
          ],
          actions: ["editSource"],
        },
        validation: {
          read: ledgerAttributions,
          create: ledgerAttributions.nullable().default([]),
          update: ledgerAttributions.nullable().optional(),
        },
      },
      {
        key: "sourceClaims",
        kind: "json",
        control: { kind: "specialized", renderer: "structured-field" },
        provenance: { kind: "relation", sources: [{ label: "Source claims" }] },
        explanation: {
          ruleId: "expense.source-claims",
          description:
            "Source claims preserve the imported or recorded evidence attached to this expense.",
          readPath: "sourceClaims",
          sourceDependencies: [
            { path: "sourceClaims", label: "Recorded source claims" },
          ],
          actions: ["editSource"],
        },
        validation: {
          read: ledgerSourceClaimsOut,
          create: ledgerSourceClaims.nullable().default([]),
          update: ledgerSourceClaims.nullable().optional(),
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: expenseShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "purchaseDate",
        kind: "date",
        nullable: true,
        validation: {
          read: plainDate.nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "purchaseDisplayLabel",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "vendorId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "vendor" },
        validation: {
          read: vendorShortcode.nullable(),
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
        key: "projectName",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "productName",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable(),
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
      { key: "shortcode", kind: "text" },
      {
        key: "notionPageId",
        kind: "text",
        nullable: true,
      },
      {
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
      },
    ],
    storage: [
      {
        key: "id",
        specialized: "primary-key:ExpenseId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      { key: "cost", specialized: "double-precision" },
      "date",
      {
        key: "lineKind",
        defaultValue: "'principal'",
        specialized: "enum:lineKind",
      },
      {
        key: "lineBasis",
        defaultValue: "'item_line'",
        specialized: "enum:lineBasis",
      },
      { key: "costType", specialized: "enum:costType" },
      { key: "trade", specialized: "enum:trade" },
      "url",
      "notes",
      { key: "future", defaultValue: false },
      { key: "projectId", reference: "project" },
      { key: "productId", reference: "product" },
      { key: "productQuantity", specialized: "double-precision" },
      { key: "purchaseId", reference: "purchase" },
      "notionPageId",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "name",
      "cost",
      "date",
      "lineKind",
      "lineBasis",
      "costType",
      "trade",
      "url",
      "notes",
      "future",
      "projectId",
      "productId",
      "productQuantity",
      "vendor",
      "orderId",
      "purchaseId",
      "beneficiaries",
      "funders",
      "sourceClaims",
    ],
    update: [
      "name",
      "cost",
      "date",
      "lineKind",
      "lineBasis",
      "costType",
      "trade",
      "url",
      "notes",
      "future",
      "projectId",
      "productId",
      "productQuantity",
      "vendor",
      "orderId",
      "purchaseId",
      "beneficiaries",
      "funders",
      "sourceClaims",
    ],
    bulk: ["projectId", "trade", "costType"],
    audit: [
      "name",
      "cost",
      "date",
      "lineKind",
      "lineBasis",
      "costType",
      "trade",
      "url",
      "notes",
      "future",
      "projectId",
      "productId",
      "productQuantity",
      "purchaseId",
    ],
    sort: {
      fields: [
        "date",
        "name",
        "cost",
        "lineKind",
        "productQuantity",
        "costType",
        "trade",
        "projectId",
        "productId",
        "purchaseId",
        "orderId",
        "createdAt",
        "updatedAt",
      ],
      computed: ["projectId", "productId"],
      groupable: ["costType"],
    },
    intents: {
      fields: {
        capture: [
          "name",
          "lineKind",
          "cost",
          "date",
          "future",
          "projectId",
          "productId",
          "productQuantity",
          "vendor",
          "orderId",
          "trade",
          "costType",
          "beneficiaries",
          "funders",
        ],
        full: [
          "name",
          "lineKind",
          "lineBasis",
          "cost",
          "date",
          "future",
          "projectId",
          "productId",
          "productQuantity",
          "vendor",
          "orderId",
          "trade",
          "costType",
          "beneficiaries",
          "funders",
          "url",
          "notes",
        ],
        planned: ["name", "cost", "date"],
        cost: ["cost"],
        date: ["date"],
        project: ["projectId"],
        product: ["productId"],
        // "Mark purchased" — settles a planned expense in one write: final
        // cost, actual date (defaults to today), and a chance to correct the
        // project/cost type/trade/notes/vendor now that it actually
        // happened. `future: false` is fixed in the editing registry's
        // `buildData`, not listed here, because it's never user-edited.
        settle: [
          "cost",
          "date",
          "projectId",
          "costType",
          "trade",
          "notes",
          "vendor",
          "orderId",
        ],
      },
      create: ["capture", "full"],
      update: [
        "full",
        "planned",
        "cost",
        "date",
        "project",
        "product",
        "settle",
      ],
    },
    output: [
      "fieldResolutions",
      "projectAllocations",
      "id",
      "name",
      "cost",
      "date",
      "lineKind",
      "lineBasis",
      "costType",
      "trade",
      "url",
      "notes",
      "future",
      "projectId",
      "productId",
      "productQuantity",
      "vendor",
      "orderId",
      "purchaseId",
      "purchaseDate",
      "purchaseDisplayLabel",
      "vendorId",
      "vendorLogo",
      "orderUrl",
      "projectName",
      "productName",
      "beneficiaries",
      "funders",
      "sourceClaims",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: { module: "@cubby/schemas/project", export: "expenseCreateInput" },
    update: { module: "@cubby/schemas/project", export: "expenseUpdateData" },
    output: { module: "@cubby/schemas/project", export: "expenseOut" },
    list: { module: "@cubby/schemas/project", export: "expenseListItemOut" },
  },
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/project", export: "expenseFilterFields" },
    descriptors: [
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search expenses...",
      },
      {
        columnId: "date",
        kind: "range",
        placeholder: "Filter by date...",
        deriveSchema: true,
        stored: true,
        range: {
          describe: {
            lower: "Inclusive lower bound on expense date",
            upper: "Inclusive upper bound on expense date",
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
        columnId: "dateFrom",
        kind: "text",
        placeholder: "Expense date from...",
        urlOnly: true,
      },
      {
        columnId: "dateTo",
        kind: "text",
        placeholder: "Expense date to...",
        urlOnly: true,
      },
      {
        columnId: "dateRelative",
        kind: "select",
        placeholder: "Filter by relative date...",
        urlOnly: true,
      },
      {
        columnId: "costType",
        kind: "multiselect",
        placeholder: "Filter by cost type...",
        deriveSchema: true,
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/expense-fields",
          export: "costTypeSchema",
        },
        options: [
          { value: "materials", label: "Materials", color: "var(--chart-1)" },
          { value: "tools", label: "Tools", color: "var(--chart-5)" },
          { value: "services", label: "Services", color: "var(--chart-2)" },
        ],
      },
      {
        columnId: "lineKind",
        kind: "multiselect",
        placeholder: "Filter by line kind...",
        deriveSchema: true,
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/expense-line-kind",
          export: "expenseLineKindSchema",
        },
        options: [
          {
            value: "principal",
            label: "Item or service",
            color: "var(--slate)",
          },
          { value: "tax", label: "Tax", color: "var(--slate)" },
          {
            value: "shipping",
            label: "Shipping or delivery",
            color: "var(--slate)",
          },
          { value: "discount", label: "Discount", color: "var(--positive)" },
          { value: "fee", label: "Fee", color: "var(--warning)" },
          { value: "tip", label: "Tip", color: "var(--plum)" },
          {
            value: "other_adjustment",
            label: "Other adjustment",
            color: "var(--slate)",
          },
        ],
      },
      {
        columnId: "lineBasis",
        kind: "multiselect",
        placeholder: "Filter by itemization...",
        deriveSchema: true,
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/expense-line-kind",
          export: "expenseLineBasisSchema",
        },
        options: [
          { value: "item_line", label: "Line item", color: "var(--slate)" },
          {
            value: "allocation",
            label: "Share of a lump sum",
            color: "var(--plum)",
          },
        ],
      },
      {
        columnId: "trade",
        kind: "multiselect",
        placeholder: "Filter by trade...",
        deriveSchema: true,
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/task-fields",
          export: "tradeSchema",
        },
        optionsRef: {
          module: "~/app/projects/trade-options",
          export: "tradeOptions",
        },
      },
      {
        columnId: "future",
        kind: "boolean",
        placeholder: "Filter by status...",
        deriveSchema: true,
        stored: true,
        options: [
          { value: "true", label: "Planned" },
          { value: "false", label: "Already made" },
        ],
      },
      {
        columnId: "cost",
        kind: "range",
        placeholder: "Filter by cost...",
        deriveSchema: true,
        stored: true,
        // Signed money: `costMax: 0` is the credits-only worklist.
        range: {
          describe: {
            lower: "Inclusive lower bound on expense cost, in dollars",
            upper: "Inclusive upper bound on expense cost, in dollars",
          },
        },
        options: [
          { value: "has", label: "Has cost", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "gte500", label: "$500 and up" },
          { value: "gte200", label: "$200 and up" },
          { value: "gte100", label: "$100 and up" },
          { value: "credits", label: "Credits (≤ $0)" },
        ],
        expandRef: {
          module: "~/app/expenses/expense-options",
          export: "resolveCostFilter",
        },
      },
      {
        columnId: "costMin",
        kind: "text",
        placeholder: "Minimum cost...",
        urlOnly: true,
      },
      {
        columnId: "costMax",
        kind: "text",
        placeholder: "Maximum cost...",
        urlOnly: true,
      },
      {
        columnId: "costSign",
        kind: "select",
        placeholder: "Filter by cost direction...",
        urlOnly: true,
      },
      {
        columnId: "disposalPurchasePresenceFilter",
        kind: "presence",
        placeholder: "Filter disposal purchase presence...",
        urlOnly: true,
      },
      {
        columnId: "productQuantity",
        kind: "range",
        placeholder: "Filter by quantity...",
        deriveSchema: true,
        stored: true,
        // Signed, like cost: a negative quantity is a real $0 discard, and
        // `productQuantityMax: -1` is the "everything written off" worklist.
        range: {
          describe: {
            lower: "Inclusive lower bound on recorded product quantity",
            upper: "Inclusive upper bound on recorded product quantity",
          },
        },
        options: [
          { value: "has", label: "Has quantity", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "exactly1", label: "Exactly 1" },
          { value: "gte2", label: "2+ units" },
          { value: "gte5", label: "5+ units" },
        ],
        expandRef: {
          module: "~/app/expenses/expense-options",
          export: "resolveProductQuantityFilter",
        },
      },
      {
        columnId: "productQuantityMin",
        kind: "text",
        placeholder: "Minimum product quantity...",
        urlOnly: true,
      },
      {
        columnId: "productQuantityMax",
        kind: "text",
        placeholder: "Maximum product quantity...",
        urlOnly: true,
      },
      {
        // Its own field, never folded into `search`: notes carry an import's
        // provenance, and most rows have none, so ANDing it into the name
        // search would zero out expense search.
        columnId: "notesSearch",
        kind: "text",
        placeholder: "Search notes...",
        urlOnly: true,
        deriveSchema: true,
        schemaDescription: "Substring match on notes",
        stored: { columns: ["notes"] },
      },
      {
        columnId: "urlSearch",
        kind: "text",
        placeholder: "Search url...",
        urlOnly: true,
        deriveSchema: true,
        schemaDescription: "Substring match on url",
        stored: { columns: ["url"] },
      },
      {
        columnId: "projectId",
        urlKey: "project",
        field: "projectId",
        kind: "idMulti",
        placeholder: "Filter by project...",
        optionsKey: "project",
        brandRef: { entity: "project" },
        nullable: { field: "projectPresenceFilter", label: "project" },
      },
      {
        columnId: "includeSubProjects",
        urlKey: "subprojects",
        kind: "boolean",
        placeholder: "Include sub-projects...",
        urlOnly: true,
      },
      {
        columnId: "productIdFilter",
        field: "productId",
        urlKey: "productId",
        wire: { kind: "param", name: "productId" },
        kind: "id",
        placeholder: "Filter by product id...",
        brandRef: { entity: "product" },
        urlOnly: true,
      },
      {
        columnId: "productId",
        urlKey: "product",
        field: "productPresenceFilter",
        kind: "presence",
        placeholder: "Filter by product...",
        options: [
          { value: "has", label: "Has product", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "purchaseId",
        urlKey: "vendor",
        field: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by vendor...",
        optionsKey: "vendor",
        brandRef: { entity: "vendor" },
        nullable: { field: "vendorPresenceFilter", label: "purchase" },
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
        columnId: "orderIdExact",
        field: "orderId",
        urlKey: "order",
        kind: "id",
        placeholder: "Filter by order id...",
        brandRef: null,
        urlOnly: true,
      },
      {
        // Expenses attributed to a ledger party (`ExpenseAttribution`).
        columnId: "ledgerPartyId",
        kind: "idMulti",
        placeholder: "Filter by attributed party...",
        brandRef: { entity: "ledgerParty" },
        urlOnly: true,
      },
      {
        columnId: "purchaseIdFilter",
        field: "purchaseId",
        urlKey: "purchaseId",
        wire: { kind: "param", name: "purchaseId" },
        kind: "id",
        placeholder: "Filter by purchase id...",
        brandRef: { entity: "purchase" },
        urlOnly: true,
      },
      {
        columnId: "related:expense.transactions",
        field: "financialTransactionSearch",
        urlKey: "related-financialTransaction",
        kind: "text",
        placeholder: "Search related purchase transactions...",
      },
      {
        columnId: "financialTransactionId",
        kind: "idMulti",
        placeholder: "Filter by related purchase transactions id...",
        brandRef: { entity: "financialTransaction" },
        urlOnly: true,
      },
      {
        columnId: "financialTransactionPresenceFilter",
        kind: "presence",
        placeholder: "Filter related purchase transactions presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "purchase",
      label: "Purchase",
      target: "purchase",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Expense.purchaseId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Expense.purchaseId", direction: "incoming" }],
      },
    },
    {
      key: "project",
      label: "Project",
      target: "project",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Expense.projectId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Expense.projectId", direction: "incoming" }],
      },
    },
    {
      key: "product",
      label: "Product",
      target: "product",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Expense.productId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Expense.productId", direction: "incoming" }],
      },
    },
    {
      key: "transactions",
      label: "Purchase transactions",
      target: "financialTransaction",
      cardinality: "many",
      provenance: {
        kind: "local-path",
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
          { edge: "Expense.purchaseId", direction: "incoming" },
        ],
      },
    },
  ],
  search: { enabled: true, embeddingOverride: false },
  capabilities: {
    auditable: true,
    images: {
      storage: false,
      displaySourceOverrides: [
        {
          relationPath: ["product"],
          priority: 0,
          ordering: "declared",
          identityEvidence: false,
        },
        {
          relationPath: ["purchase"],
          priority: 1,
          ordering: "declared",
          identityEvidence: false,
        },
      ],
      ingress: [
        {
          kind: "existingRelated",
          routeId: "expense-purchase",
          relationPath: ["purchase"],
          choice: "prompt",
        },
        {
          kind: "existingRelated",
          routeId: "expense-product",
          relationPath: ["product"],
          choice: "prompt",
        },
        {
          kind: "createSelf",
          routeId: "expense-new",
          enabled: false,
          disabledReason:
            "Expenses have no image storage of their own; attach photos via the purchase or product instead",
        },
      ],
      routing: {
        category: "documents",
        candidateFields: ["name", "notes"],
        temporalFields: ["date"],
        lifecycleFilters: [],
        signals: {
          ocrFields: ["name", "notes"],
          classifierLabels: ["receipt"],
        },
        abstention: { minimumScore: 0.78, minimumMargin: 0.16 },
      },
    },
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: { fields: ["projectId", "trade", "costType", "date"] },
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "search", "create", "update", "delete", "bulkUpdate"],
    dataQuality: {
      checks: [
        {
          id: "expense_cost",
          facet: "ledger",
          weight: 2,
          label: "Cost",
          message: "No cost is recorded for this expense.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/expense/entity-adapter",
        export: "expenseEntityAdapter",
      },
      search: "document",
    },
  },
});
