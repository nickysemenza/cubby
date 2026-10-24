import { optionalFieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import {
  financialAccountAuthorizedUsers,
  financialAccountFundingPeriods,
} from "../financial-account-party-fields";
import { defineEntity } from "./definition.js";
import { displayItemsField, labelField } from "./label-field.js";
import {
  financialAccountCardNumbers,
  financialAccountIdentity,
  financialAccountNetwork,
  financialAccountSourceAliases,
} from "@cubby/schemas/financial-account-fields";
import {
  financialAccountShortcode,
  ledgerPartyShortcode,
  vendorShortcode,
} from "../identifier-fields.js";
import { z } from "zod";
export default defineEntity({
  key: "financialAccount",
  names: { singular: "Financial Account", plural: "Accounts" },
  route: {
    listColumns: {
      module: "~/features/finance/list-columns",
      export: "financialAccountListOverride",
    },
    basePath: "financial-accounts",
  },
  table: "FinancialAccount",
  identifiers: { brand: "FinancialAccountId", shortcode: "FAC-" },
  presentation: {
    edit: {
      sections: [
        {
          id: "details",
          title: "Details",
          fields: ["inventoryOwnerDefaultEnabled"],
        },
      ],
    },
    list: {
      read: {
        relations: [
          "providerVendorId",
          "ledgerPartyId",
          "providerVendorName",
          "ledgerPartyName",
        ],
        derived: ["transactionCount"],
        media: ["displayImages"],
        quality: ["dataQuality"],
      },
    },
    titleField: "name",
    domain: "finance",
    description: "Accounts that provide settlement evidence.",
    emptyState: {
      title: "No financial accounts yet",
      description:
        "Add an account to retain statement and receipt evidence for settlement.",
      actionLabel: "New Account",
    },
    icons: {
      phosphor: "CreditCard",
      sfSymbol: "building.columns",
      emoji: "🏦",
    },
    detail: {
      summary: [
        {
          kind: "records",
          id: "owner",
          title: "Owner",
          viewKey: "relation:ledger-party",
        },
        {
          kind: "records",
          id: "provider",
          title: "Provider",
          viewKey: "relation:provider-vendor",
        },
        {
          kind: "fields",
          id: "account-identity",
          title: "Account identity",
          fields: ["identity", "network"],
        },
        {
          kind: "chart",
          id: "monthly-spend",
          title: "Spend over 12 months",
          viewKey: "expenses",
        },
        {
          kind: "records",
          id: "transactions",
          title: "Transactions",
          viewKey: "relation:transactions",
        },
        {
          kind: "records",
          id: "purchases",
          title: "Purchases",
          viewKey: "relation:purchases",
        },
        {
          kind: "report",
          id: "unresolved-transactions",
          title: "Transactions needing review",
          slot: "financialAccount.review-summary",
        },
      ],

      activityRelations: [{ relation: "purchases", dateField: "date" }],

      omitRelations: {
        vendors:
          "Three joins through transactions; the Transactions table links each transaction's vendor.",
        purchases:
          "Two joins through transactions; the Transactions table links each transaction's purchase.",
      },
    },
  },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text" },
        display: {},
        validation: {
          read: z.string().min(1),
          create: z.string().min(1),
          update: z.string().min(1).optional(),
        },
      },
      {
        key: "identity",
        semanticRole: "externalIdentifier",
        kind: "json",
        control: { kind: "specialized", renderer: "structured-field" },
        display: {
          columnGroup: "Account",
          readPath: "identity.kind",
          renderer: { detail: "financial-account-identity" },
          mobile: { slot: "subtitle", priority: 10 },
          valueOptions: [
            {
              value: "credit_card",
              label: "Credit card",
              color: "neutral-status",
            },
            {
              value: "bank_account",
              label: "Bank account",
              color: "neutral-status",
            },
            {
              value: "stored_value",
              label: "Gift card or store credit",
              color: "neutral-status",
            },
            {
              value: "cash",
              label: "Cash",
              color: "neutral-status",
            },
            {
              value: "other",
              label: "Other",
              color: "neutral-status",
            },
          ],
          optionRole: "category",
          optionColor: "domain-finance",
          optionGlyph: { phosphor: "CreditCard", sfSymbol: "creditcard" },
        },
        validation: {
          read: financialAccountIdentity,
          create: financialAccountIdentity,
          update: financialAccountIdentity.optional(),
        },
      },
      {
        key: "network",
        kind: "enum",
        nullable: true,
        description:
          "Credit-card payment network, stored in identity. Choose none without explicit network evidence.",
        provenance: {
          kind: "relation",
          sources: [{ label: "Account identity" }],
        },
        control: {
          kind: "select",
          options: [
            {
              value: "visa",
              label: "Visa",
              description: "Visa payment network.",
            },
            {
              value: "mastercard",
              label: "Mastercard",
              description: "Mastercard payment network.",
            },
            {
              value: "amex",
              label: "American Express",
              description: "American Express payment network.",
            },
            {
              value: "discover",
              label: "Discover",
              description: "Discover payment network.",
            },
            {
              value: "other",
              label: "Other",
              description:
                "An explicitly identified payment network outside the listed networks; not an unknown network.",
            },
          ],
          suggest: {
            basis: ["name", "identity", "notes", "sourceAliases"],
            backedBy: [{ column: "identity" }],
            allowNone: true,
            // Financial identity controls statement/account matching.
            reviewRequired: true,
            rules: [
              "Choose a payment network only from explicit network evidence in the account name, identity, saved notes or statement evidence. An issuer name or card tier does not establish a network. Choose none for missing, conflicting or ambiguous evidence; never use Other to mean unknown. Preserve the saved identity until reviewed and applied; never change the account kind.",
            ],
          },
        },
        display: {
          columnGroup: "Account",
          mobile: { slot: "trailing", priority: 10 },
          optionRole: "category",
          optionColor: "domain-finance",
          optionGlyph: { phosphor: "CreditCard", sfSymbol: "creditcard" },
        },
        validation: {
          read: financialAccountNetwork.nullable(),
          create: financialAccountNetwork.nullable().optional(),
          update: financialAccountNetwork.nullable().optional(),
        },
      },
      {
        key: "sourceAliases",
        semanticRole: "externalIdentifier",
        kind: "json",
        control: { kind: "specialized", renderer: "source-aliases" },
        display: {
          columnGroup: "Evidence",
          columnLabel: "Aliases",
          width: "xs",
          readPath: "sourceAliases",
          format: "arrayCount",
          detailLabelPath: "sourceAliasesLabel",
        },
        validation: {
          read: financialAccountSourceAliases,
          create: financialAccountSourceAliases.default([]),
          update: financialAccountSourceAliases.optional(),
        },
      },
      {
        key: "cardNumbers",
        semanticRole: "externalIdentifier",
        kind: "json",
        description:
          "Every last four this account has presented, dated: the primary card the statement labels it with (a reissue is an older primary with validTo), wallet device numbers, sibling cards, or gift-card instances.",
        control: { kind: "specialized", renderer: "structured-field" },
        display: { list: false, detailLabelPath: "cardNumbersLabel" },
        validation: {
          read: financialAccountCardNumbers,
          create: financialAccountCardNumbers.default([]),
          update: financialAccountCardNumbers.optional(),
        },
      },
      {
        key: "providerVendorId",
        kind: "identifier",
        nullable: true,
        description:
          "The organization providing or servicing this account: bank, card issuer, loan servicer, wallet or stored-value provider. Multiple accounts may share a provider; card co-branding does not establish the provider.",
        reference: { entity: "vendor" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: {
            basis: ["name", "identity", "notes", "sourceAliases"],
            reviewRequired: true,
          },
        },
        display: { columnGroup: "Account", columnLabel: "Provider" },
        validation: {
          read: vendorShortcode.nullable(),
          create: vendorShortcode.nullable().default(null),
          update: vendorShortcode.nullable().optional(),
        },
      },
      {
        key: "primaryCardholderId",
        kind: "identifier",
        nullable: true,
        description:
          "The member who alone makes purchases outside authorized-user periods. Independent of funding and inventory ownership.",
        resolution: {
          reset: {
            primaryCardholderId: null,
            primaryCardholderMode: "inherit",
          },
          none: {
            primaryCardholderId: null,
            primaryCardholderMode: "explicit",
          },
          inherit: {
            mode: {
              field: "primaryCardholderMode",
              inherit: "inherit",
              explicitIfSet: true,
            },
            from: [
              {
                path: "ledger-party.id",
                when: { field: "kind", value: "member" },
              },
            ],
          },
          labels: { unresolved: "No member cardholder", none: "None" },
        },
        reference: {
          entity: "ledgerParty",
          filters: [{ field: "kind", values: ["member"] }],
        },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: {
            basis: [
              "name",
              "identity",
              "notes",
              "authorizedUsers",
              "fundingPeriods",
            ],
            // Assigns who made purchases outside authorized-user periods.
            reviewRequired: true,
          },
        },
        display: { columnGroup: "People" },
        validation: {
          read: ledgerPartyShortcode.nullable(),
          create: ledgerPartyShortcode.nullable().default(null),
          update: ledgerPartyShortcode.nullable().optional(),
        },
      },
      {
        key: "primaryCardholderMode",
        kind: "enum",
        validation: {
          read: null,
          create: z.enum(["inherit", "explicit"]).default("inherit"),
          update: z.enum(["inherit", "explicit"]).optional(),
        },
      },
      {
        key: "fieldResolutions",
        kind: "json",
        display: { list: false, detail: false },
        validation: {
          read: optionalFieldResolutionsSchema,
          create: null,
          update: null,
        },
      },
      {
        key: "authorizedUsers",
        collection: { key: ["ledgerPartyId", "validFrom"] },
        kind: "json",
        description:
          "Members authorized to use this credit card, with inclusive membership dates.",
        control: { kind: "specialized", renderer: "structured-field" },
        display: { list: false, itemsPath: "authorizedUserItems" },
        validation: {
          read: financialAccountAuthorizedUsers,
          create: financialAccountAuthorizedUsers.default([]),
          update: financialAccountAuthorizedUsers.optional(),
        },
      },
      {
        key: "fundingPeriods",
        collection: { key: ["ledgerPartyId", "validFrom"] },
        kind: "json",
        description:
          "Dated funding parties. Empty uses the account Ledger Party; gaps in a nonempty history are unknown. Does not change inventory ownership.",
        control: { kind: "specialized", renderer: "structured-field" },
        display: { list: false, itemsPath: "fundingPeriodItems" },
        validation: {
          read: financialAccountFundingPeriods,
          create: financialAccountFundingPeriods.default([]),
          update: financialAccountFundingPeriods.optional(),
        },
      },
      {
        key: "ledgerPartyId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "ledgerParty" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { columnGroup: "People", width: "md" },
        validation: {
          read: ledgerPartyShortcode.nullable(),
          create: ledgerPartyShortcode.nullable().default(null),
          update: ledgerPartyShortcode.nullable().optional(),
        },
      },
      {
        key: "inventoryOwnerDefaultEnabled",
        kind: "boolean",
        control: { kind: "checkbox" },
        display: { list: false },
        validation: {
          read: z.boolean(),
          create: z.boolean().default(false),
          update: z.boolean().optional(),
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        control: { kind: "textarea" },
        display: { columnGroup: "Evidence" },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        display: { detail: false, list: false },
        key: "id",
        kind: "identifier",
        validation: {
          read: financialAccountShortcode,
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "ledgerPartyName",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "providerVendorName",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "transactionCount",
        kind: "number",
        display: { columnGroup: "Activity", columnBar: true },
        provenance: {
          kind: "derived",
          sources: [
            { entity: "financialTransaction", relation: "transactions" },
          ],
        },
        explanation: {
          ruleId: "financial-account.transaction-count",
          description:
            "Transaction count is the number of live financial transactions linked to this account.",
          readPath: "transactionCount",
        },
        validation: {
          read: z.number().int().nonnegative(),
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
      // Server-composed text for the structured detail fields above (`display.detailLabelPath`).
      labelField("sourceAliasesLabel", "Source aliases"),
      labelField("cardNumbersLabel", "Card numbers"),
      displayItemsField("authorizedUserItems", "Authorized users"),
      displayItemsField("fundingPeriodItems", "Funding periods"),
    ],
    storage: [
      {
        key: "id",
        specialized: "primary-key:FinancialAccountId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      { key: "identity", specialized: "json:identity" },
      {
        key: "sourceAliases",
        defaultValue: "'[]'::jsonb",
        specialized: "json:sourceAliases",
      },
      {
        key: "cardNumbers",
        defaultValue: "'[]'::jsonb",
        specialized: "json:cardNumbers",
      },
      { key: "providerVendorId", reference: "vendor" },
      { key: "ledgerPartyId", reference: "ledgerParty" },
      { key: "primaryCardholderId", reference: "ledgerParty" },
      {
        key: "primaryCardholderMode",
        defaultValue: "'inherit'",
        specialized: "enum:inheritance-mode",
      },
      {
        key: "authorizedUsers",
        defaultValue: "'[]'::jsonb",
        specialized: "json:authorizedUsers",
      },
      {
        key: "fundingPeriods",
        defaultValue: "'[]'::jsonb",
        specialized: "json:fundingPeriods",
      },
      {
        key: "inventoryOwnerDefaultEnabled",
        defaultValue: false,
      },
      "notes",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "network",
      "primaryCardholderId",
      "primaryCardholderMode",
      "authorizedUsers",
      "fundingPeriods",
      "name",
      "identity",
      "sourceAliases",
      "cardNumbers",
      "providerVendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
      "notes",
    ],
    update: [
      "network",
      "primaryCardholderId",
      "primaryCardholderMode",
      "authorizedUsers",
      "fundingPeriods",
      "name",
      "identity",
      "sourceAliases",
      "cardNumbers",
      "providerVendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
      "notes",
    ],
    audit: [
      "primaryCardholderId",
      "primaryCardholderMode",
      "authorizedUsers",
      "fundingPeriods",
      "name",
      "identity",
      "sourceAliases",
      "cardNumbers",
      "notes",
      "providerVendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
    ],
    rows: {
      cards: { label: "Card numbers", json: "cardNumbers" },
      aliases: { label: "Source aliases", json: "sourceAliases" },
    },
    derived: {
      transactionCount: { type: "number" },
      identityKind: {
        type: "enum",
        options: [
          "credit_card",
          "bank_account",
          "stored_value",
          "cash",
          "other",
        ],
      },
      // At least one source alias.
      hasSourceAlias: { type: "boolean" },
      // Any card the account has ever presented, not only today's primary.
      last4: { via: "cards.last4" },
      // Both match on the same alias.
      source: { via: "aliases.source" },
      externalAccountId: { via: "aliases.externalAccountId" },
    },
    sort: {
      fields: ["name", "transactionCount", "createdAt", "updatedAt"],
      // A name roster reads A→Z; the table's blanket descending default was
      // opening the account list backwards.
    },
    intents: {
      fields: {
        capture: [
          "network",
          "name",
          "identity",
          "cardNumbers",
          "providerVendorId",
          "sourceAliases",
          "notes",
        ],
        full: [
          "network",
          "primaryCardholderId",
          "primaryCardholderMode",
          "authorizedUsers",
          "fundingPeriods",
          "name",
          "identity",
          "cardNumbers",
          "providerVendorId",
          "sourceAliases",
          "inventoryOwnerDefaultEnabled",
          "notes",
        ],
        identity: ["name", "sourceAliases", "notes"],
      },
      create: ["capture", "full"],
      update: ["full", "identity"],
    },
    output: [
      "fieldResolutions",
      "network",
      "authorizedUserItems",
      "fundingPeriodItems",
      "primaryCardholderId",
      "authorizedUsers",
      "fundingPeriods",
      "id",
      "name",
      "identity",
      "sourceAliases",
      "sourceAliasesLabel",
      "cardNumbers",
      "cardNumbersLabel",
      "providerVendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
      "notes",
      "providerVendorName",
      "ledgerPartyName",
      "transactionCount",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: {
      module: "@cubby/schemas/financial-account",
      export: "financialAccountCreateInput",
    },
    update: {
      module: "@cubby/schemas/financial-account",
      export: "financialAccountUpdateData",
    },
    output: {
      module: "@cubby/schemas/financial-account",
      export: "financialAccountOut",
    },
  },
  storage: {
    indexes: [{ on: ["name"] }, { on: ["providerVendorId", "ledgerPartyId"] }],
    checks: [
      {
        name: "FinancialAccount_provider_non_cash_check",
        sql: "{providerVendorId} IS NULL OR {identity}->>'kind' <> 'cash'",
      },
    ],
    relations: {
      ledgerParty: "ledgerPartyId",
      providerVendor: "providerVendorId",
      transactions: { many: "financialTransaction" },
    },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/financial-account",
      export: "financialAccountFilterFields",
    },
    descriptors: [
      {
        columnId: "primaryCardholderId",
        placeholder: "Filter by primary cardholder...",
        kind: "idMulti",
        brandRef: { entity: "ledgerParty" },
        currentMember: true,
        deriveSchema: true,
      },
      {
        columnId: "providerVendorId",
        kind: "idMulti",
        placeholder: "Filter by provider...",
        brandRef: { entity: "vendor" },
        deriveSchema: true,
      },
      {
        columnId: "ledgerPartyId",
        kind: "idMulti",
        placeholder: "Filter by ledger party...",
        brandRef: { entity: "ledgerParty" },
        currentMember: true,
        deriveSchema: true,
      },
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search accounts...",
        deriveSchema: true,
        anyOf: ["name"],
      },
      {
        columnId: "identity",
        field: "identityKind",
        kind: "multiselect",
        derived: "identityKind",
        placeholder: "Filter by account type...",
        options: [
          { value: "credit_card", label: "Credit card" },
          { value: "bank_account", label: "Bank account" },
          { value: "stored_value", label: "Stored value" },
          { value: "cash", label: "Cash" },
          { value: "other", label: "Other" },
        ],
      },
      {
        columnId: "sourceAliases",
        urlKey: "aliases",
        field: "sourceAliasPresenceFilter",
        kind: "presence",
        derived: "hasSourceAlias",
        placeholder: "Filter aliases...",
        options: [
          { value: "has", label: "Has aliases", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "last4",
        kind: "multiselect",
        placeholder: "Filter by last four digits...",
      },
      {
        columnId: "source",
        kind: "multiselect",
        placeholder: "Filter by source...",
      },
      {
        columnId: "externalAccountId",
        kind: "multiselect",
        placeholder: "Filter by external account id...",
      },
      {
        columnId: "related:financialAccount.transactions",
        field: "financialTransactionSearch",
        urlKey: "related-financialTransaction",
        kind: "text",
        placeholder: "Search related transactions...",
      },
      {
        columnId: "financialTransactionId",
        kind: "idMulti",
        placeholder: "Filter by related transactions id...",
        brandRef: { entity: "financialTransaction" },
      },
      {
        columnId: "financialTransactionPresenceFilter",
        kind: "presence",
        placeholder: "Filter related transactions presence...",
      },
      {
        columnId: "related:financialAccount.purchases",
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
        columnId: "related:financialAccount.vendors",
        field: "vendorSearch",
        urlKey: "related-vendor",
        kind: "text",
        placeholder: "Search related vendors...",
      },
      {
        columnId: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by related vendors id...",
        brandRef: { entity: "vendor" },
      },
      {
        columnId: "vendorPresenceFilter",
        kind: "presence",
        placeholder: "Filter related vendors presence...",
      },
    ],
  },
  relations: [
    {
      key: "primary-cardholder",
      label: "Primary cardholder",
      target: "ledgerParty",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "FinancialAccount.primaryCardholderId",
            direction: "outgoing",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "FinancialAccount.primaryCardholderId",
            direction: "incoming",
          },
        ],
      },
    },
    {
      key: "provider-vendor",
      label: "Provider",
      target: "vendor",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "FinancialAccount.providerVendorId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "FinancialAccount.providerVendorId", direction: "incoming" },
        ],
      },
    },
    {
      key: "ledger-party",
      label: "Ledger party",
      target: "ledgerParty",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "FinancialAccount.ledgerPartyId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "FinancialAccount.ledgerPartyId", direction: "incoming" },
        ],
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
          { edge: "FinancialTransaction.accountId", direction: "incoming" },
        ],
      },
      inverse: {
        steps: [
          { edge: "FinancialTransaction.accountId", direction: "outgoing" },
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
        steps: [
          { edge: "FinancialTransaction.accountId", direction: "incoming" },
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
          { edge: "FinancialTransaction.accountId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "vendors",
      label: "Vendors",
      target: "vendor",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "FinancialTransaction.accountId", direction: "incoming" },
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
          { edge: "FinancialTransaction.accountId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: "semantic",
  capabilities: {
    classificationPolicies: [
      {
        classifier: "identity",
        fields: ["network", "primaryCardholderId", "authorizedUsers"].map(
          (field) => ({
            field,
            byValue: { credit_card: "unknown" as const },
            otherwise: "not_allowed" as const,
            refusal: "Only applies to credit-card accounts.",
          }),
        ),
      },
    ],
    images: {
      storage: false,
    },
    delete: { mode: "soft", bulk: true },
    merge: false,
    dataQuality: {
      checks: [
        {
          id: "financial_account_ledger_party",
          satisfiedLabel: "Ledger party recorded",
          placement: { field: "ledgerPartyId" },
          facet: "linkage",
          weight: 2,
          label: "Ledger party",
          message: "No ledger party is linked to this account.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/financial-account/repo",
        export: "financialAccountRepository",
      },
      search: "document",
    },
  },
});
