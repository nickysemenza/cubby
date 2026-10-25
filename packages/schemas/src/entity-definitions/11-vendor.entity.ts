import { imageAssociationStorage } from "./image-associations";
import { vendorSpendingProfile } from "../spending-classification.js";
import { purchasedCategorySummary } from "../product-category-fields";
import { spendingCategoryShortcode } from "../identifier-fields.js";
import { defineEntity } from "./definition.js";
import { labelField } from "./label-field.js";
import { vendorShortcode } from "../identifier-fields.js";
import { imageOut } from "./field-primitives.js";
import { money } from "@cubby/schemas/money";
import { plainDate } from "@cubby/schemas/base-entity";
import { z } from "zod";
import { mailSearchState } from "../mail-search-fields.js";
import { optionalFieldResolutionsSchema } from "../field-resolution.js";
import {
  vendorAgentHints,
  vendorDomainList,
  vendorEmailSenderList,
  vendorOrderEvidence,
} from "../vendor-import-fields.js";
export default defineEntity({
  key: "vendor",
  names: { singular: "Vendor", plural: "Vendors" },
  route: { basePath: "vendors" },
  table: "Vendor",
  identifiers: { brand: "VendorId", shortcode: "VEN-" },
  presentation: {
    edit: {
      sections: [
        {
          id: "details",
          title: "Details",
          fields: [
            "aliases",
            "orderUrlTemplate",
            "orderEvidence",
            "orderEmailSenders",
            "browserDomains",
            "agentHints",
            "returnWindowDays",
          ],
        },
      ],
    },
    titleField: "name",
    domain: "purchases",
    description:
      "Brands, sellers and service providers, including shipment carriers.",
    emptyState: {
      title: "No vendors yet",
      description:
        "Track the places money goes \u2014 retailers, contractors, suppliers \u2014 so every purchase and expense can point at one.",
      actionLabel: "Add Vendor",
    },
    icons: { phosphor: "Storefront", sfSymbol: "storefront", emoji: "🏪" },
    detail: {
      hero: { extraActions: ["fetchLogo", "refreshLogo"] },
      summary: [
        {
          kind: "records",
          id: "purchases",
          title: "Purchases",
          viewKey: "relation:purchases",
        },
        {
          kind: "report",
          id: "purchased-products",
          title: "Frequently bought Products",
          slot: "vendor.frequent-products",
        },
        {
          kind: "records",
          id: "branded-products",
          title: "Branded Products",
          viewKey: "relation:branded-products",
        },
        {
          kind: "chart",
          id: "monthly-spend",
          title: "Spend over 12 months",
          viewKey: "relation:expenses",
        },
        {
          kind: "fields",
          id: "needs-review",
          title: "Needs review",
          fields: ["unknownCategoryLineCount"],
        },
        {
          kind: "report",
          id: "relevant-mail",
          title: "Relevant mail",
          slot: "vendor.email-summary",
        },
        {
          kind: "records",
          id: "household-accounts",
          title: "Household accounts",
          viewKey: "relation:vendor-accounts",
        },
      ],

      activityRelations: [
        { relation: "expenses", dateField: "date" },
        { relation: "purchases", dateField: "date" },
      ],

      additionalSections: [
        {
          kind: "relation",
          id: "branded-products",
          title: "Branded products",
          relation: "branded-products",
          filter: { descriptor: "brandId" },
          columns: ["name", "brandId", "categoryId"],
        },
        {
          kind: "slot",
          id: "spending-classification",
          title: "Spending classification",
        },
        {
          kind: "slot",
          id: "mail-search",
          title: "Mail search",
        },
        {
          kind: "relation",
          id: "emails",
          title: "Emails",
          relation: "emails",
          filter: { descriptor: "vendorId" },
          columns: ["receivedAt", "sender", "linkState", "purchaseLinks"],
          // Linked, then suggestions to act on, then dismissals, newest first.
          sort: { field: "linkState", direction: "asc" },
        },
        {
          kind: "relation",
          id: "purchased-products",
          title: "Purchased products",
          relation: "products",
          filter: { descriptor: "related:product.vendors" },
          columns: ["name", "brandId", "categoryId", "expenseTotal"],
        },
      ],
    },
    list: {
      extraActions: ["fetchLogo", "refreshLogo"],
      titleSubtitle: true,
      shelfSubtitleOverride: ["defaultSpendingCategoryId"],
      savedViews: [
        {
          id: "research-queue",
          label: "Research queue",
          description: "Vendors missing a website or displayable logo",
          filters: [
            { id: "dataGaps", value: ["vendor_website", "vendor_logo"] },
          ],
          sort: [{ id: "dataQuality", desc: false }],
        },
        {
          id: "needs-classification",
          label: "Needs classification",
          description: "Records missing an effective spending category",
          filters: [{ id: "needsClassification", value: "true" }],
        },
      ],
      totals: [
        { id: "spend", label: "Spend", keys: ["spend"], format: "currency" },
        {
          id: "purchaseCount",
          label: "Purchases",
          keys: ["purchaseCount"],
          format: "integer",
        },
      ],
    },
  },
  model: {
    fields: [
      {
        key: "systemKey",
        kind: "text",
        nullable: true,
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "purchasedCategories",
        kind: "identifier",
        reference: { entity: "productCategory", multiple: true },
        display: { list: false, referencePreviewLimit: 2 },
        validation: {
          read: z.array(purchasedCategorySummary).optional(),
          create: null,
          update: null,
        },
      },
      {
        key: "principalLineCount",
        provenance: { kind: "derived", sources: [{ entity: "expense" }] },
        kind: "number",
        display: { list: false },
        validation: {
          read: z.number().int().optional(),
          create: null,
          update: null,
        },
      },
      {
        key: "unknownCategoryLineCount",
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense" }, { entity: "product" }],
        },
        kind: "number",
        display: { list: false },
        validation: {
          read: z.number().int().optional(),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "defaultSpendingCategoryName",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable().optional(),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "defaultSpendingCategoryEmoji",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable().optional(),
          create: null,
          update: null,
        },
      },

      {
        key: "spendingProfile",
        kind: "enum",
        control: {
          kind: "select",
          suggest: {
            basis: ["name", "website", "notes"],
            rules: [
              `Suggest this vendor's spending profile using saved independent purchase and ProductCategory evidence. Food products alone do not distinguish groceries from restaurant meals. Mixed goods support mixed_retail; ambiguous or truncated evidence supports unspecified. The current profile is a review target, never proof. Preserve existing decisions.`,
            ],
          },
          options: [
            {
              value: "unspecified",
              label: "Unspecified",
              description: "Insufficient evidence",
              color: "neutral-status",
              glyph: {
                phosphor: "Question",
                sfSymbol: "questionmark.circle",
              },
            },
            {
              value: "mixed_retail",
              label: "Mixed retailer",
              description: "Mixed retailer selling multiple kinds of goods",
            },
            {
              value: "food_retail",
              label: "Groceries",
              description: "Groceries and food retail",
            },
            {
              value: "restaurant",
              label: "Restaurant",
              description: "Prepared restaurant meals",
            },
            {
              value: "coffee_shop",
              label: "Coffee shop",
              description: "Coffee shop",
            },
          ],
        },
        display: {
          columnGroup: "Purchasing",
          columnLabel: "Profile",
          optionRole: "category",
          optionColor: "domain-purchases",
          optionGlyph: { phosphor: "Storefront", sfSymbol: "storefront" },
        },
        validation: {
          read: vendorSpendingProfile.default("unspecified"),
          create: vendorSpendingProfile.default("unspecified"),
          update: vendorSpendingProfile.optional(),
        },
      },
      {
        key: "defaultSpendingCategoryId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "spendingCategory" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: {
            basis: ["name", "website", "notes", "spendingProfile"],
          },
        },
        display: { columnGroup: "Purchasing", columnLabel: "Category" },
        validation: {
          read: spendingCategoryShortcode.nullable().default(null),
          create: spendingCategoryShortcode.nullable().default(null),
          update: spendingCategoryShortcode.nullable().optional(),
        },
      },
      {
        display: { detail: false, list: false },
        key: "fieldResolutions",
        kind: "json",
        validation: {
          read: optionalFieldResolutionsSchema,
          create: null,
          update: null,
        },
      },
      {
        key: "itemizationExpectation",
        kind: "enum",
        nullable: true,
        control: {
          kind: "select",
          suggest: {
            basis: ["name", "website", "notes"],
            rules: [
              `Suggest whether the household expects these purchases to be itemized: recorded as the order's own item lines, each goods line naming its Product. Online orders with retrievable order history (Amazon, Home Depot) are expected (required). Restaurant meals, groceries, in-store shops whose receipts are usually not kept, one-amount services, subscriptions and friend reimbursements are not_expected. No policy ever requires a receipt document. Use the actual purchase/source description when available; broad or mixed vendor/category evidence without a clear purpose remains unknown. Never overwrite explicit decisions or effective values derived from order evidence.`,
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
          columnGroup: "Purchasing",
          columnLabel: "Item lines",
          optionRole: "status",
          optionColor: "neutral-status",
        },
        resolution: {
          reset: { itemizationExpectation: null },
          redundancy: "eligible",
          // Receipt-only or unrecorded evidence implies no policy, so the
          // Purchase ladder falls through to the spending category.
          labels: { unresolved: "Unclassified" },
        },
        explanation: {
          ruleId: "vendor.effective-itemization-expectation",
          description:
            "An explicit Vendor itemization policy wins; otherwise its order evidence supplies it: an online account expects item lines, no order evidence expects none, and receipt-only or unrecorded evidence stays unclassified.",
          projections: {
            list: "fieldResolutions.itemizationExpectation.value",
            detail: "fieldResolutions.itemizationExpectation.value",
            summary: "fieldResolutions.itemizationExpectation.value",
          },
          sourceDependencies: [
            { path: "orderEvidence", label: "Order evidence" },
            {
              path: "fieldResolutions.itemizationExpectation.storedValue",
              label: "Stored override",
            },
            {
              path: "fieldResolutions.itemizationExpectation.fallbackValue",
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
        key: "name",
        kind: "text",
        control: { kind: "text", placeholder: "Who are you paying?" },
        display: { standard: "name" },
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
        control: { kind: "text", renderer: "url" },
        display: { list: false },
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
        display: {},
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
        control: {
          kind: "select",
          options: [
            {
              value: "online_account",
              label: "Online account",
              glyph: { phosphor: "Globe", sfSymbol: "globe" },
            },
            {
              value: "receipt_only",
              label: "Receipt only",
              glyph: { phosphor: "Receipt", sfSymbol: "receipt" },
            },
            {
              value: "not_expected",
              label: "Not expected",
              color: "neutral-status",
              glyph: { phosphor: "MinusCircle", sfSymbol: "minus.circle" },
            },
          ],
        },
        display: {
          columnGroup: "Purchasing",
          columnLabel: "Evidence",
          optionRole: "category",
          optionColor: "domain-purchases",
        },
        validation: {
          read: vendorOrderEvidence.nullable(),
          create: vendorOrderEvidence.nullable().default(null),
          update: vendorOrderEvidence.nullable().optional(),
        },
      },
      {
        key: "aliases",
        kind: "text-array",
        collection: { key: "value" },
        description:
          "Other names this Vendor trades under. Import finds the Vendor by its name or any alias; Sender proof and Vendor merges add them.",
        control: { kind: "specialized", renderer: "tag-list" },
        display: { list: false },
        validation: {
          read: z.array(z.string()),
          create: z.array(z.string()).default([]),
          update: z.array(z.string()).optional(),
        },
      },
      {
        key: "orderEmailSenders",
        kind: "text-array",
        collection: { key: "value" },
        control: {
          kind: "specialized",
          renderer: "tag-list",
        },
        display: { list: false },
        validation: {
          read: vendorEmailSenderList,
          create: vendorEmailSenderList.default([]),
          update: vendorEmailSenderList.optional(),
        },
      },
      {
        key: "browserDomains",
        kind: "text-array",
        collection: { key: "value" },
        control: {
          kind: "specialized",
          renderer: "tag-list",
        },
        display: { list: false },
        validation: {
          read: vendorDomainList,
          create: vendorDomainList.default([]),
          update: vendorDomainList.optional(),
        },
      },
      {
        key: "agentHints",
        kind: "json",
        control: {
          kind: "specialized",
          renderer: "structured-field",
        },
        display: { list: false, detailLabelPath: "agentHintsLabel" },
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
        control: {
          kind: "number",
          placeholder: "Days",
        },
        display: { list: false },
        validation: {
          read: z.number().int().nonnegative().nullable(),
          create: z.number().int().nonnegative().nullable().default(null),
          update: z.number().int().nonnegative().nullable().optional(),
        },
      },
      {
        display: { detail: false, list: false },
        key: "id",
        kind: "identifier",
        validation: {
          read: vendorShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "role",
        kind: "enum",
        display: {
          columnLabel: "Role",
          width: "sm",
          optionRole: "category",
          optionColor: "neutral-status",
          valueOptions: [
            {
              value: "seller",
              label: "Seller",
              color: "category-1",
              glyph: { phosphor: "Storefront", sfSymbol: "storefront" },
            },
            {
              value: "brand",
              label: "Brand",
              color: "category-2",
              glyph: { phosphor: "Tag", sfSymbol: "tag" },
            },
            {
              value: "both",
              label: "Both",
              color: "category-3",
              glyph: {
                phosphor: "Intersect",
                sfSymbol: "circle.lefthalf.filled",
              },
            },
            {
              value: "unused",
              label: "Unused",
              color: "neutral-status",
              glyph: { phosphor: "MinusCircle", sfSymbol: "minus.circle" },
            },
          ],
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "purchase" }, { entity: "product" }],
        },
        explanation: {
          ruleId: "vendor.role",
          description:
            "Seller when referenced by a live Purchase, Brand when referenced as a live Product's brand, Both for both uses, and Unused for neither. Accounts and pending proposals do not assign a role.",
          readPath: "role",
        },
        validation: {
          read: z.enum(["seller", "brand", "both", "unused"]),
          create: null,
          update: null,
        },
      },
      {
        key: "brandCategoryCount",
        kind: "number",
        display: {
          columnGroup: "Brand / catalog",
          columnLabel: "Categories",
          width: "sm",
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "product" }, { entity: "productCategory" }],
        },
        explanation: {
          ruleId: "vendor.brandCategoryCount",
          description:
            "Number of distinct live product categories used by live products carrying this vendor as their marketed brand. Uncategorized products are excluded.",
          readPath: "brandCategoryCount",
        },
        validation: {
          read: z.number().int().nonnegative(),
          create: null,
          update: null,
        },
      },
      {
        key: "purchasedBrandProductCount",
        kind: "number",
        display: {
          columnGroup: "Brand / catalog",
          columnLabel: "Purchased",
          width: "sm",
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense" }, { entity: "product" }],
        },
        explanation: {
          ruleId: "vendor.purchasedBrandProductCount",
          description:
            "Number of distinct live branded products linked to live expense lines through live purchases, across all sellers. Refund-linked products remain part of purchase history.",
          readPath: "purchasedBrandProductCount",
        },
        validation: {
          read: z.number().int().nonnegative(),
          create: null,
          update: null,
        },
      },
      {
        key: "brandSpend",
        kind: "number",
        display: {
          columnGroup: "Brand / catalog",
          columnLabel: "Brand spend",
          width: "sm",
          format: "signedCurrency",
          columnBar: true,
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "expense" }, { entity: "product" }],
        },
        explanation: {
          ruleId: "vendor.brandSpend",
          description:
            "Sum of live Expense.cost linked to live products carrying this brand through live purchases, across all sellers, including refunds. Expenses without a linked product cannot be attributed to a brand. This can overlap seller spend and is not additive with it.",
          readPath: "brandSpend",
        },
        validation: { read: money, create: null, update: null },
      },
      {
        key: "expenseCount",
        kind: "number",
        display: {
          columnGroup: "Purchasing",
          columnLabel: "Expense lines",
          width: "sm",
        },
        provenance: { kind: "derived", sources: [{ entity: "expense" }] },
        explanation: {
          ruleId: "vendor.expenseCount",
          description:
            "Number of live expense lines belonging to this seller through live purchases, including refunds.",
          readPath: "expenseCount",
        },
        validation: {
          read: z.number().int().nonnegative(),
          create: null,
          update: null,
        },
      },
      {
        key: "firstPurchaseDate",
        kind: "date",
        nullable: true,
        display: {
          columnGroup: "Purchasing",
          columnLabel: "First purchase",
          width: "sm",
          format: "plainDate",
        },
        provenance: { kind: "derived", sources: [{ entity: "purchase" }] },
        explanation: {
          ruleId: "vendor.firstPurchaseDate",
          description:
            "Earliest date among live purchases from this seller. No purchases means no date.",
          readPath: "firstPurchaseDate",
        },
        validation: { read: plainDate.nullable(), create: null, update: null },
      },
      {
        key: "documentedPurchaseCount",
        kind: "number",
        display: {
          columnGroup: "Purchasing",
          columnLabel: "Documented",
          width: "sm",
        },
        provenance: { kind: "derived", sources: [{ entity: "purchase" }] },
        explanation: {
          ruleId: "vendor.documentedPurchaseCount",
          description:
            "Number of live purchases from this seller with a retained primary receipt or invoice. Documents are optional: absent documents are not a coverage gap.",
          readPath: "documentedPurchaseCount",
        },
        validation: {
          read: z.number().int().nonnegative(),
          create: null,
          update: null,
        },
      },
      {
        key: "missingItemizationCount",
        kind: "number",
        display: {
          columnGroup: "Purchasing",
          columnLabel: "Missing items",
          width: "sm",
        },
        provenance: { kind: "derived", sources: [{ entity: "purchase" }] },
        explanation: {
          ruleId: "vendor.missingItemizationCount",
          description:
            "Number of live purchases from this seller whose existing itemization coverage is missing: itemization is required but not present. Unclassified and not-expected policies are excluded; zero does not imply all purchases were assessed.",
          readPath: "missingItemizationCount",
        },
        validation: {
          read: z.number().int().nonnegative(),
          create: null,
          update: null,
        },
      },
      {
        key: "brandedProductCount",
        kind: "number",
        display: {
          columnGroup: "Brand / catalog",
          columnLabel: "Products",
          width: "sm",
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "product", relation: "branded-products" }],
        },
        explanation: {
          ruleId: "vendor.branded-product-count",
          description:
            "Number of live products carrying this vendor as their marketed brand, independently of where those products were purchased.",
          readPath: "brandedProductCount",
        },
        validation: {
          read: z.number().int().nonnegative(),
          create: null,
          update: null,
        },
      },
      {
        key: "purchaseCount",
        kind: "number",
        display: {
          columnGroup: "Purchasing",
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
          columnGroup: "Purchasing",
          columnLabel: "Seller spend",
          columnBar: true,
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
          columnGroup: "Purchasing",
          columnLabel: "Last purchase",
          format: "plainDate",
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
        key: "mailSearch",
        kind: "enum",
        nullable: true,
        display: {
          columnGroup: "Purchasing",
          columnLabel: "Mail search",
          width: "sm",
          valueOptions: [
            {
              value: "not_started",
              label: "Not started",
              color: "neutral-status",
            },
            {
              value: "in_progress",
              label: "In progress",
              color: "warning",
            },
            {
              value: "done",
              label: "Done",
              color: "positive",
            },
          ],
          optionRole: "status",
          optionColor: "neutral-status",
        },
        provenance: {
          kind: "derived",
          sources: [{ label: "Mail discovery search coverage" }],
        },
        explanation: {
          ruleId: "vendor.mail-search",
          description:
            "Mail search aggregates this vendor's sender and website searches across every connected mailbox: done when each current search has finished in every mailbox, in progress once any has a finished page, not started otherwise, and blank for a vendor with no verified sender or website.",
          readPath: "mailSearch",
        },
        validation: {
          read: mailSearchState.nullable(),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
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
        display: { list: false },
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { list: false },
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
      // Server-composed text for the structured detail field above (`display.detailLabelPath`).
      labelField("agentHintsLabel", "Vendor agent hints"),
    ],
    storage: [
      "systemKey",
      {
        key: "spendingProfile",
        specialized: "enum:spendingProfile",
        defaultValue: "unspecified",
      },
      { key: "defaultSpendingCategoryId", reference: "spendingCategory" },
      {
        key: "itemizationExpectation",
        specialized: "enum:itemizationExpectation",
      },
      {
        key: "id",
        specialized: "primary-key:VendorId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      {
        key: "aliases",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      "website",
      "orderUrlTemplate",
      "orderEvidence",
      {
        key: "orderEmailSenders",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      {
        key: "browserDomains",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      {
        key: "agentHints",
        defaultValue:
          '\'{"ordersListUrl":null,"pagination":null,"orderLinkPattern":null,"notes":[]}\'::jsonb',
        specialized: "json:agentHints",
      },
      "returnWindowDays",
      "notes",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "spendingProfile",
      "defaultSpendingCategoryId",
      "itemizationExpectation",
      "name",
      "aliases",
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
      "spendingProfile",
      "defaultSpendingCategoryId",
      "itemizationExpectation",
      "name",
      "aliases",
      "website",
      "orderUrlTemplate",
      "orderEvidence",
      "orderEmailSenders",
      "browserDomains",
      "agentHints",
      "returnWindowDays",
      "notes",
    ],
    audit: [
      "spendingProfile",
      "defaultSpendingCategoryId",
      "itemizationExpectation",
      "name",
      "aliases",
      "website",
      "orderUrlTemplate",
      "orderEvidence",
      "orderEmailSenders",
      "browserDomains",
      "agentHints",
      "returnWindowDays",
      "notes",
    ],
    derived: {
      role: { type: "enum", options: ["seller", "brand", "both", "unused"] },
      spend: { rollup: "sum", via: "expenses.cost" },
      purchaseCount: { rollup: "count", via: "purchases" },
      brandedProductCount: { rollup: "count", via: "branded-products" },
      brandCategoryCount: { type: "number" },
      purchasedBrandProductCount: { type: "number" },
      brandSpend: { type: "number" },
      expenseCount: { rollup: "count", via: "expenses" },
      firstPurchaseDate: { rollup: "min", via: "purchases.date" },
      documentedPurchaseCount: { type: "number" },
      missingItemizationCount: { type: "number" },
      latestPurchaseDate: { type: "date" },
      // Mail discovery's searches for this vendor, from MailboxCursor coverage.
      mailSearch: { type: "enum", options: mailSearchState.options },
      // No default spending category yet.
      needsClassification: { type: "boolean" },
      // A displayable logo image.
      hasLogo: { type: "boolean" },
    },
    sort: {
      fields: [
        "spend",
        "name",
        "role",
        "purchaseCount",
        "brandedProductCount",
        "brandCategoryCount",
        "purchasedBrandProductCount",
        "brandSpend",
        "expenseCount",
        "firstPurchaseDate",
        "documentedPurchaseCount",
        "missingItemizationCount",
        "latestPurchaseDate",
        "mailSearch",
        "orderEvidence",
        "createdAt",
        "updatedAt",
      ],
      // Open on biggest spenders first: "where did the money go" is the
      // question this roster exists to answer. Used to be a browser-registry
      // `list.defaultSort` override on top of a generated "name" default;
      // the product decision now lives on the declaration itself.
    },
    intents: {
      fields: {
        capture: ["name", "website", "notes"],
        full: [
          "spendingProfile",
          "defaultSpendingCategoryId",
          "itemizationExpectation",
          "name",
          "aliases",
          "website",
          "orderUrlTemplate",
          "orderEvidence",
          "orderEmailSenders",
          "browserDomains",
          "agentHints",
          "returnWindowDays",
          "notes",
        ],
        identity: ["name", "aliases"],
      },
      create: ["capture", "full"],
      update: ["full", "identity"],
    },
    output: [
      "purchasedCategories",
      "principalLineCount",
      "unknownCategoryLineCount",
      "defaultSpendingCategoryName",
      "defaultSpendingCategoryEmoji",
      "spendingProfile",
      "defaultSpendingCategoryId",
      "fieldResolutions",
      "itemizationExpectation",
      "id",
      "name",
      "aliases",
      "website",
      "orderUrlTemplate",
      "orderEvidence",
      "orderEmailSenders",
      "browserDomains",
      "agentHints",
      "agentHintsLabel",
      "returnWindowDays",
      "notes",
      "role",
      "purchaseCount",
      "brandedProductCount",
      "brandCategoryCount",
      "purchasedBrandProductCount",
      "brandSpend",
      "expenseCount",
      "firstPurchaseDate",
      "documentedPurchaseCount",
      "missingItemizationCount",
      "spend",
      "latestPurchaseDate",
      "mailSearch",
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
  storage: {
    indexes: [
      { on: ["name"], where: "{deletedAt} IS NULL" },
      { on: ["systemKey"], unique: true },
    ],
    checks: [
      { column: "spendingProfile" },
      { column: "orderEvidence", nullClause: true },
      {
        name: "Vendor_returnWindowDays_check",
        sql: "{returnWindowDays} IS NULL OR {returnWindowDays} >= 0",
      },
    ],
    relations: {
      purchases: { many: "purchase" },
      attachments: { many: "entityAttachment" },
    },
  },
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/vendor", export: "vendorFilterFields" },
    descriptors: [
      {
        columnId: "role",
        kind: "multiselect",
        derived: true,
        placeholder: "Filter role...",
        deriveSchema: true,
        options: [
          { value: "seller", label: "Seller" },
          { value: "brand", label: "Brand" },
          { value: "both", label: "Both" },
          { value: "unused", label: "Unused" },
        ],
      },
      {
        columnId: "needsClassification",
        field: "needsClassification",
        urlKey: "needsClassification",
        kind: "boolean",
        placeholder: "Needs classification",
        deriveSchema: true,
      },
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search vendors...",
        deriveSchema: true,
        anyOf: ["name", "notes", "website"],
      },
      {
        columnId: "purchaseCount",
        kind: "range",
        derived: true,
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
          module: "~/entity/filter-behavior",
          export: "resolveVendorPurchases",
        },
      },
      {
        columnId: "spend",
        kind: "range",
        derived: true,
        placeholder: "Filter spend...",
        deriveSchema: true,
        options: [
          {
            value: "positive",
            label: "Positive basis",
            expand: { spendMin: 0.01 },
          },
          {
            value: "zero",
            label: "Zero basis",
            expand: { spendMin: 0, spendMax: 0 },
          },
          {
            value: "negative",
            label: "Credit / negative",
            expand: { spendMax: -0.01 },
          },
          { value: "gte100", label: "$100 and up", expand: { spendMin: 100 } },
          { value: "gte500", label: "$500 and up", expand: { spendMin: 500 } },
        ],
      },
      {
        columnId: "latestPurchaseDate",
        kind: "range",
        derived: true,
        wire: {
          kind: "range",
          from: "latestPurchaseDateFrom",
          to: "latestPurchaseDateTo",
          presence: "latestPurchaseDatePresenceFilter",
        },
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
          module: "~/entity/filter-behavior",
          export: "resolveLatestPurchaseDate",
        },
      },
      {
        columnId: "mailSearch",
        kind: "multiselect",
        placeholder: "Filter mail search...",
        deriveSchema: true,
        options: [
          { value: "not_started", label: "Not started" },
          { value: "in_progress", label: "In progress" },
          { value: "done", label: "Done" },
        ],
      },
      {
        columnId: "orderEvidence",
        kind: "multiselect",
        placeholder: "Filter evidence...",
        deriveSchema: true,
        options: [
          { value: "online_account", label: "Online account" },
          { value: "receipt_only", label: "Receipt only" },
          { value: "not_expected", label: "Not expected" },
        ],
      },
      {
        columnId: "logo",
        field: "logoPresenceFilter",
        kind: "presence",
        derived: "hasLogo",
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
        brandRef: { entity: "expense" },
      },
      {
        columnId: "expensePresenceFilter",
        kind: "presence",
        placeholder: "Filter related recent expenses presence...",
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
        brandRef: { entity: "purchase" },
      },
      {
        columnId: "purchasePresenceFilter",
        kind: "presence",
        placeholder: "Filter related purchases presence...",
      },
      {
        columnId: "related:vendor.products",
        field: "productSearch",
        urlKey: "related-product",
        kind: "text",
        placeholder: "Search related products...",
      },
      {
        columnId: "related:vendor.brandedProducts",
        field: "brandedProductSearch",
        urlKey: "related-branded-product",
        kind: "text",
        placeholder: "Search branded products...",
      },
      {
        columnId: "brandedProductId",
        kind: "idMulti",
        placeholder: "Filter by branded product...",
        brandRef: { entity: "product" },
      },
      {
        columnId: "brandedProductPresenceFilter",
        kind: "presence",
        placeholder: "Filter branded products presence...",
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
      },
      {
        columnId: "projectPresenceFilter",
        kind: "presence",
        placeholder: "Filter related projects presence...",
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
        brandRef: { entity: "financialTransaction" },
      },
      {
        columnId: "financialTransactionPresenceFilter",
        kind: "presence",
        placeholder: "Filter related financial transactions presence...",
      },
    ],
  },
  relations: [
    {
      key: "branded-products",
      label: "Branded products",
      target: "product",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Product.brandId", direction: "incoming" }],
      },
      inverse: { steps: [{ edge: "Product.brandId", direction: "outgoing" }] },
    },
    {
      key: "emails",
      label: "Emails",
      target: "email",
      cardinality: "many",
      // Its Purchases' Emails plus its sender-proof mail (ADR 0011).
      provenance: {
        kind: "derived",
        filter: "vendorId",
        evidence: ["ImportSourceOrder", "AssessmentState", "OrderMailEvent"],
      },
    },
    {
      key: "defaultSpendingCategory",
      label: "Default spending category",
      target: "spendingCategory",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "Vendor.defaultSpendingCategoryId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Vendor.defaultSpendingCategoryId", direction: "incoming" },
        ],
      },
    },
    {
      key: "logo",
      label: "Logo image",
      target: "image",
      cardinality: "one",
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
  search: "semantic",
  capabilities: {
    images: {
      storage: imageAssociationStorage.shape.vendor.value,
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
    delete: { mode: "soft", bulk: true },
    resolve: { match: ["name", "aliases"], createMissing: false },
    merge: true,
    dataQuality: {
      checks: [
        {
          id: "vendor_order_evidence",
          satisfiedLabel: "Order evidence classified",
          placement: { field: "orderEvidence" },
          facet: "identity",
          weight: 3,
          label: "Order evidence",
          message: "No order evidence is recorded for this vendor.",
        },
        {
          id: "vendor_order_evidence_conflict",
          satisfiedLabel: "Order evidence consistent",
          placement: { field: "orderEvidence" },
          facet: "identity",
          kind: "defect",
          weight: 3,
          scoreCap: 49,
          exceptions: "forbidden",
          label: "Order evidence conflict",
          message:
            "Itemization is expected, but this vendor leaves no order evidence.",
        },
        {
          id: "vendor_logo",
          satisfiedLabel: "Logo recorded",
          placement: { section: "images" },
          facet: "provenance",
          weight: 1,
          label: "Logo",
          message: "No logo is recorded for this vendor.",
          coverage: "vendors",
        },
        {
          id: "vendor_website",
          satisfiedLabel: "Website recorded",
          placement: { field: "website" },
          facet: "identity",
          weight: 1,
          label: "Website",
          message: "No website is recorded for this vendor.",
        },
      ],
      // A vendor with no findable logo or website records why, so sweeps
      // stop re-researching the same dead end.
      exceptions: true,
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/vendor/repo/vendor.repository",
        export: "vendorRepository",
      },
      search: "document",
    },
  },
});
