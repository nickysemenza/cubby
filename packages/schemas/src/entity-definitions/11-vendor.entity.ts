import { defineEntity } from "./definition.js";
import { vendorShortcode } from "../identifier-fields.js";
import { imageOut } from "./field-primitives.js";
import { money } from "@cubby/schemas/money";
import { plainDate } from "@cubby/schemas/base-entity";
import { z } from "zod";
import {
  vendorAgentHints,
  vendorDomainList,
  vendorEmailSenderList,
  vendorOrderEvidence,
} from "../vendor-import-fields.js";
export default defineEntity({
  key: "vendor",
  names: { singular: "Vendor", plural: "Vendors" },
  route: { basePath: "vendors", create: "dialog", list: true, detail: true },
  table: "Vendor",
  identifiers: { brand: "VendorId", shortcode: "VEN-" },
  presentation: {
    titleField: "name",
    domain: "finance",
    description: "Sources for purchases and expense evidence.",
    emptyState: {
      title: "No vendors yet",
      description:
        "Track the places money goes \u2014 retailers, contractors, suppliers \u2014 so every purchase and expense can point at one.",
      actionLabel: "Add Vendor",
    },
    icons: { lucide: "Store", sfSymbol: "storefront", emoji: "🏪" },
    detail: {
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Overview",
          placement: "supporting",
          fields: [
            "name",
            "website",
            "orderUrlTemplate",
            "orderEvidence",
            "orderEmailSenders",
            "browserDomains",
            "returnWindowDays",
            "agentHints",
            "notes",
            "purchaseCount",
            "spend",
            "latestPurchaseDate",
            "createdAt",
            "updatedAt",
          ],
        },
        {
          kind: "relation",
          id: "purchases",
          title: "Purchases",
          relation: "purchases",
          filter: { descriptor: "vendor" },
          columns: [
            "displayLabel",
            "orderId",
            "date",
            "statedTotal",
            "expenseCount",
          ],
          sort: { field: "date", direction: "desc" },
        },
        {
          kind: "relation",
          id: "purchased-products",
          title: "Purchased products",
          relation: "products",
          filter: { descriptor: "related:product.vendors" },
          columns: ["name", "manufacturer", "category", "expenseTotal"],
        },
        {
          kind: "relation",
          id: "projects",
          title: "Projects",
          relation: "projects",
          filter: { descriptor: "vendorId" },
          columns: ["name", "status", "kind"],
        },
        {
          kind: "relation",
          id: "expenses",
          title: "Expenses",
          relation: "expenses",
          filter: { descriptor: "vendor" },
          columns: ["name", "cost", "date", "project"],
          sort: { field: "date", direction: "desc" },
        },
      ],
    },
    list: { actions: ["merge", "delete"] },
  },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text", placeholder: "Who are you paying?" },
        display: { list: true, detail: true, standard: "name" },
        validation: {
          read: z.string().min(1),
          create: z.string().min(1),
          update: z.string().min(1).optional(),
        },
      },
      {
        key: "website",
        kind: "text",
        nullable: true,
        control: { kind: "text", renderer: "url", placeholder: "https://…" },
        display: {
          list: true,
          detail: true,
          format: "external-link",
          width: "md",
          mobile: { slot: "meta", priority: 30, interactive: true },
        },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "orderUrlTemplate",
        kind: "text",
        nullable: true,
        label: "Order URL",
        control: { kind: "text", renderer: "url", section: "details" },
        display: { detail: true },
        validation: {
          read: z
            .string()
            .describe(
              "URL pattern for this vendor's order-details page, with the literal token {orderId} standing in for a purchase's order id — e.g. \"https://www.amazon.com/gp/your-account/order-details?orderID={orderId}\". Null for vendors with no order lookup. The per-purchase link is derived from this at read time, never stored on the purchase.",
            )
            .nullable(),
          create: z
            .string()
            .describe(
              "URL pattern for this vendor's order-details page, with the literal token {orderId} standing in for a purchase's order id — e.g. \"https://www.amazon.com/gp/your-account/order-details?orderID={orderId}\". Null for vendors with no order lookup. The per-purchase link is derived from this at read time, never stored on the purchase.",
            )
            .nullable()
            .default(null),
          update: z
            .string()
            .describe(
              "URL pattern for this vendor's order-details page, with the literal token {orderId} standing in for a purchase's order id — e.g. \"https://www.amazon.com/gp/your-account/order-details?orderID={orderId}\". Null for vendors with no order lookup. The per-purchase link is derived from this at read time, never stored on the purchase.",
            )
            .nullable()
            .optional(),
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        control: { kind: "textarea" },
        display: { list: true, detail: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "orderEvidence",
        kind: "enum",
        nullable: true,
        label: "Order evidence",
        control: {
          kind: "select",
          section: "details",
          options: [
            { value: "online_account", label: "Online account" },
            { value: "receipt_only", label: "Receipt only" },
            { value: "not_expected", label: "Not expected" },
          ],
        },
        display: { detail: true },
        validation: {
          read: vendorOrderEvidence.nullable(),
          create: vendorOrderEvidence.nullable().default(null),
          update: vendorOrderEvidence.nullable().optional(),
        },
      },
      {
        key: "orderEmailSenders",
        kind: "text-array",
        label: "Order email senders",
        control: {
          kind: "specialized",
          renderer: "tag-list",
          section: "details",
        },
        display: { detail: true },
        validation: {
          read: vendorEmailSenderList,
          create: vendorEmailSenderList.default([]),
          update: vendorEmailSenderList.optional(),
        },
      },
      {
        key: "browserDomains",
        kind: "text-array",
        label: "Browser domains",
        control: {
          kind: "specialized",
          renderer: "tag-list",
          section: "details",
        },
        display: { detail: true },
        validation: {
          read: vendorDomainList,
          create: vendorDomainList.default([]),
          update: vendorDomainList.optional(),
        },
      },
      {
        key: "agentHints",
        kind: "json",
        label: "Import hints",
        control: {
          kind: "specialized",
          renderer: "structured-field",
          section: "details",
        },
        display: { detail: true, renderer: { detail: "vendor-agent-hints" } },
        validation: {
          read: vendorAgentHints,
          create: vendorAgentHints.default({
            ordersListUrl: null,
            pagination: null,
            orderLinkPattern: null,
            notes: [],
          }),
          update: vendorAgentHints.optional(),
        },
      },
      {
        key: "returnWindowDays",
        kind: "number",
        nullable: true,
        label: "Return window",
        control: { kind: "number", section: "details", placeholder: "Days" },
        display: { detail: true },
        validation: {
          read: z.number().int().nonnegative().nullable(),
          create: z.number().int().nonnegative().nullable().default(null),
          update: z.number().int().nonnegative().nullable().optional(),
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: vendorShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "purchaseCount",
        kind: "number",
        label: "Purchases",
        display: {
          list: true,
          detail: true,
          width: "sm",
          mobile: { slot: "meta", priority: 20 },
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "purchase", relation: "purchases" }],
        },
        explanation: {
          ruleId: "vendor.purchase-count",
          description:
            "Purchase count is the number of live purchases linked to this vendor.",
          readPath: "purchaseCount",
        },
        validation: {
          read: z.number().int().min(0),
          create: null,
          update: null,
        },
      },
      {
        key: "spend",
        kind: "number",
        // Vendor spend genuinely goes negative (a refund-only vendor, or the
        // family wedding contributions) — `signedCurrency` reads a credit as
        // a credit rather than spend. The footer stays exact: `vendorList`
        // returns a `sums.spend` over the whole filtered set.
        display: {
          list: true,
          detail: true,
          format: "signedCurrency",
          width: "sm",
          mobile: { slot: "trailing", priority: 5 },
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense", relation: "expenses" }],
        },
        explanation: {
          ruleId: "vendor.spend",
          description:
            "Vendor spend is the sum of cost across live expenses whose purchase belongs to this vendor, including refunds.",
          readPath: "spend",
          sourceDependencies: [
            { path: "purchaseCount", label: "Live purchase count" },
          ],
        },
        validation: {
          read: money,
          create: null,
          update: null,
        },
      },
      {
        key: "latestPurchaseDate",
        kind: "date",
        nullable: true,
        display: {
          list: true,
          detail: true,
          format: "plainDate",
          width: "sm",
          mobile: { slot: "meta", priority: 35 },
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "purchase", relation: "purchases" }],
        },
        explanation: {
          ruleId: "vendor.latest-purchase-date",
          description:
            "Latest purchase date is the most recent date among this vendor's live purchases.",
          readPath: "latestPurchaseDate",
          sourceDependencies: [
            { path: "purchaseCount", label: "Live purchase count" },
          ],
        },
        validation: {
          read: plainDate.nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "logo",
        kind: "json",
        nullable: true,
        validation: {
          read: imageOut.nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { detail: true },
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { detail: true },
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
      },
      { key: "shortcode", kind: "text", readKey: null },
      {
        key: "logoImageId",
        kind: "identifier",
        nullable: true,
        label: "Logo Image ID",
        readKey: null,
        reference: { entity: "image" },
      },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
    ],
    storage: [
      { key: "id", default: "generated", specialized: "primary-key:VendorId" },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      "website",
      { key: "logoImageId", reference: "image" },
      "orderUrlTemplate",
      "orderEvidence",
      {
        key: "orderEmailSenders",
        default: "literal",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      {
        key: "browserDomains",
        default: "literal",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      {
        key: "agentHints",
        default: "literal",
        defaultValue:
          '\'{"ordersListUrl":null,"pagination":null,"orderLinkPattern":null,"notes":[]}\'::jsonb',
        specialized: "json:agentHints",
      },
      "returnWindowDays",
      "notes",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "name",
      "website",
      "orderUrlTemplate",
      "orderEvidence",
      "orderEmailSenders",
      "browserDomains",
      "agentHints",
      "returnWindowDays",
      "notes",
    ],
    update: [
      "name",
      "website",
      "orderUrlTemplate",
      "orderEvidence",
      "orderEmailSenders",
      "browserDomains",
      "agentHints",
      "returnWindowDays",
      "notes",
    ],
    bulk: [],
    audit: [
      "name",
      "website",
      "orderUrlTemplate",
      "orderEvidence",
      "orderEmailSenders",
      "browserDomains",
      "agentHints",
      "returnWindowDays",
      "notes",
    ],
    sort: {
      fields: [
        "name",
        "purchaseCount",
        "spend",
        "latestPurchaseDate",
        "createdAt",
        "updatedAt",
      ],
      // Open on biggest spenders first: "where did the money go" is the
      // question this roster exists to answer. Used to be a browser-registry
      // `list.defaultSort` override on top of a generated "name" default;
      // the product decision now lives on the declaration itself.
      default: "spend",
    },
    intents: {
      fields: {
        capture: ["name", "website", "notes"],
        full: [
          "name",
          "website",
          "orderUrlTemplate",
          "orderEvidence",
          "orderEmailSenders",
          "browserDomains",
          "returnWindowDays",
          "notes",
        ],
        identity: ["name"],
      },
      create: ["capture", "full"],
      update: ["full", "identity"],
    },
    output: [
      "id",
      "name",
      "website",
      "orderUrlTemplate",
      "orderEvidence",
      "orderEmailSenders",
      "browserDomains",
      "agentHints",
      "returnWindowDays",
      "notes",
      "purchaseCount",
      "spend",
      "latestPurchaseDate",
      "logo",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: { module: "@cubby/schemas/vendor", export: "vendorCreateInput" },
    update: { module: "@cubby/schemas/vendor", export: "vendorUpdateData" },
    output: { module: "@cubby/schemas/vendor", export: "vendorOut" },
  },
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/vendor", export: "vendorFilterFields" },
    descriptors: [
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search vendors...",
        deriveSchema: true,
        stored: { columns: ["name", "notes", "website"] },
      },
      {
        columnId: "purchaseCount",
        kind: "range",
        placeholder: "Filter purchase count...",
        deriveSchema: true,
        range: { int: true, nonnegative: true },
        options: [
          { value: "has", label: "Has purchases", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "1", label: "1+ purchases" },
          { value: "2", label: "2+ purchases" },
          { value: "5", label: "5+ purchases" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveVendorPurchases",
        },
      },
      {
        columnId: "spend",
        kind: "range",
        placeholder: "Filter spend...",
        deriveSchema: true,
        options: [
          { value: "positive", label: "Positive basis" },
          { value: "zero", label: "Zero basis" },
          { value: "negative", label: "Credit / negative" },
          { value: "gte100", label: "$100 and up" },
          { value: "gte500", label: "$500 and up" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveVendorSpend",
        },
      },
      {
        columnId: "latestPurchaseDate",
        kind: "range",
        placeholder: "Filter latest purchase...",
        deriveSchema: true,
        options: [
          { value: "has", label: "Has purchase", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "30d", label: "Last 30 days" },
          { value: "90d", label: "Last 90 days" },
          { value: "ytd", label: "Year to date" },
          { value: "1y", label: "Last 12 months" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveLatestPurchaseDate",
        },
      },
      {
        columnId: "logo",
        field: "logoPresenceFilter",
        kind: "presence",
        placeholder: "Filter logos...",
        options: [
          { value: "has", label: "Has logo", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "related:vendor.expenses",
        field: "expenseSearch",
        urlKey: "related-expense",
        kind: "text",
        placeholder: "Search related recent expenses...",
      },
      {
        columnId: "expenseId",
        kind: "idMulti",
        placeholder: "Filter by related recent expenses id...",
        urlOnly: true,
      },
      {
        columnId: "expensePresenceFilter",
        kind: "presence",
        placeholder: "Filter related recent expenses presence...",
        urlOnly: true,
      },
      {
        columnId: "related:vendor.purchases",
        field: "purchaseSearch",
        urlKey: "related-purchase",
        kind: "text",
        placeholder: "Search related purchases...",
      },
      {
        columnId: "purchaseId",
        kind: "idMulti",
        placeholder: "Filter by related purchases id...",
        urlOnly: true,
      },
      {
        columnId: "purchasePresenceFilter",
        kind: "presence",
        placeholder: "Filter related purchases presence...",
        urlOnly: true,
      },
      {
        columnId: "related:vendor.products",
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
        columnId: "related:vendor.projects",
        field: "projectSearch",
        urlKey: "related-project",
        kind: "text",
        placeholder: "Search related projects...",
      },
      {
        columnId: "projectId",
        kind: "idMulti",
        placeholder: "Filter by related projects id...",
        brandRef: { entity: "project" },
        urlOnly: true,
      },
      {
        columnId: "projectPresenceFilter",
        kind: "presence",
        placeholder: "Filter related projects presence...",
        urlOnly: true,
      },
      {
        columnId: "related:vendor.transactions",
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
    ],
  },
  relations: [
    {
      key: "logo",
      label: "Logo image",
      target: "image",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Vendor.logoImageId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Vendor.logoImageId", direction: "incoming" }],
      },
    },
    {
      key: "expenses",
      label: "Recent expenses",
      target: "expense",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "Purchase.vendorId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "incoming" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Expense.purchaseId", direction: "outgoing" },
          { edge: "Purchase.vendorId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "purchases",
      label: "Purchases",
      target: "purchase",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Purchase.vendorId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Purchase.vendorId", direction: "outgoing" }],
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
          { edge: "Purchase.vendorId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "incoming" },
          { edge: "Expense.productId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Expense.productId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "outgoing" },
          { edge: "Purchase.vendorId", direction: "outgoing" },
        ],
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
          { edge: "Purchase.vendorId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "incoming" },
          { edge: "Expense.projectId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Expense.projectId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "outgoing" },
          { edge: "Purchase.vendorId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "transactions",
      label: "Financial transactions",
      target: "financialTransaction",
      cardinality: "many",
      provenance: {
        kind: "local-path",
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
          { edge: "Purchase.vendorId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: {
      storage: "logo",
      ingress: [
        { kind: "self", routeId: "vendor-logo" },
        {
          kind: "createSelf",
          routeId: "vendor-new",
          enabled: false,
          disabledReason:
            "Vendors need a name before a logo; create one in Vendors first",
        },
      ],
      routing: {
        category: "home",
        candidateFields: ["name", "website"],
        temporalFields: [],
        lifecycleFilters: [],
        signals: {
          ocrFields: ["name", "website"],
          classifierLabels: ["storefront", "sign"],
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
        module: "~/server/repo/vendor.entity-adapter",
        export: "vendorEntityAdapter",
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
