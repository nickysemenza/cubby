import { defineEntity } from "./definition.js";
import {
  financialAccountCardNumbers,
  financialAccountIdentity,
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
    basePath: "financial-accounts",
    create: "dialog",
    list: true,
    detail: true,
  },
  table: "FinancialAccount",
  identifiers: { brand: "FinancialAccountId", shortcode: "FAC-" },
  presentation: {
    titleField: "name",
    domain: "finance",
    description: "Accounts that provide settlement evidence.",
    emptyState: {
      title: "No financial accounts yet",
      description:
        "Add an account to retain statement and receipt evidence for settlement.",
      actionLabel: "New Account",
    },
    icons: { lucide: "CreditCard", sfSymbol: "building.columns", emoji: "🏦" },
    detail: {
      omitRelations: {
        vendors:
          "Three joins through transactions; the Transactions table links each transaction's vendor.",
        purchases:
          "Two joins through transactions; the Transactions table links each transaction's purchase.",
      },
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Overview",
          placement: "supporting",
          fields: [
            "name",
            "identity",
            "provisional",
            "sourceAliases",
            "cardNumbers",
            "providerVendorId",
            "ledgerPartyId",
            "inventoryOwnerDefaultEnabled",
            "notes",
            "transactionCount",
            "createdAt",
            "updatedAt",
          ],
        },
        {
          kind: "relation",
          id: "transactions",
          title: "Transactions",
          relation: "transactions",
          filter: { descriptor: "accountId" },
          columns: ["merchant", "amount", "kind", "status", "postedDate"],
          sort: { field: "postedDate", direction: "desc" },
        },
      ],
    },
    list: { actions: ["delete"] },
  },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text" },
        display: { list: true, detail: true },
        validation: {
          read: z.string().min(1),
          create: z.string().min(1),
          update: z.string().min(1).optional(),
        },
      },
      {
        key: "identity",
        kind: "json",
        control: { kind: "specialized", renderer: "structured-field" },
        display: {
          list: true,
          detail: true,
          renderer: { detail: "financial-account-identity" },
        },
        validation: {
          read: financialAccountIdentity,
          create: financialAccountIdentity,
          update: financialAccountIdentity.optional(),
        },
      },
      {
        key: "provisional",
        kind: "boolean",
        control: { kind: "checkbox", section: "details" },
        display: { list: true, detail: true },
        validation: {
          read: z.boolean(),
          create: z.boolean().default(false),
          update: z.boolean().optional(),
        },
      },
      {
        key: "sourceAliases",
        kind: "json",
        label: "Aliases",
        control: { kind: "specialized", renderer: "source-aliases" },
        display: {
          list: true,
          detail: true,
          columnId: "aliases",
          renderer: { detail: "financial-account-source-aliases" },
        },
        validation: {
          read: financialAccountSourceAliases,
          create: financialAccountSourceAliases.default([]),
          update: financialAccountSourceAliases.optional(),
        },
      },
      {
        key: "cardNumbers",
        kind: "json",
        label: "Card numbers",
        description:
          "Every last four this account has presented, dated: the primary card the statement labels it with (a reissue is an older primary with validTo), wallet device numbers, sibling cards, or gift-card instances.",
        control: { kind: "specialized", renderer: "structured-field" },
        display: {
          detail: true,
          renderer: { detail: "financial-account-card-numbers" },
        },
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
        label: "Provider",
        description:
          "The vendor that owes a gift card or store-credit balance. Stored-value accounts only; one live account per provider and owner.",
        reference: { entity: "vendor" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { list: true, detail: true, columnId: "providerVendorName" },
        validation: {
          read: vendorShortcode.nullable(),
          create: vendorShortcode.nullable().default(null),
          update: vendorShortcode.nullable().optional(),
        },
      },
      {
        key: "ledgerPartyId",
        kind: "identifier",
        nullable: true,
        label: "Owner",
        reference: { entity: "ledgerParty" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { list: true, detail: true, columnId: "ledgerPartyName" },
        validation: {
          read: ledgerPartyShortcode.nullable(),
          create: ledgerPartyShortcode.nullable().default(null),
          update: ledgerPartyShortcode.nullable().optional(),
        },
      },
      {
        key: "inventoryOwnerDefaultEnabled",
        kind: "boolean",
        label: "Use as inventory owner default",
        control: { kind: "checkbox", section: "details" },
        display: { detail: true },
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
        display: { list: true, detail: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: financialAccountShortcode,
          create: null,
          update: null,
        },
      },
      {
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
        label: "Transactions",
        display: { list: true, detail: true },
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
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
    ],
    storage: [
      {
        key: "id",
        default: "generated",
        specialized: "primary-key:FinancialAccountId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      { key: "identity", specialized: "json:identity" },
      { key: "provisional", default: "literal", defaultValue: false },
      {
        key: "sourceAliases",
        default: "literal",
        defaultValue: "'[]'::jsonb",
        specialized: "json:sourceAliases",
      },
      {
        key: "cardNumbers",
        default: "literal",
        defaultValue: "'[]'::jsonb",
        specialized: "json:cardNumbers",
      },
      { key: "providerVendorId", reference: "vendor" },
      { key: "ledgerPartyId", reference: "ledgerParty" },
      {
        key: "inventoryOwnerDefaultEnabled",
        default: "literal",
        defaultValue: false,
      },
      "notes",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "name",
      "identity",
      "provisional",
      "sourceAliases",
      "cardNumbers",
      "providerVendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
      "notes",
    ],
    update: [
      "name",
      "identity",
      "provisional",
      "sourceAliases",
      "cardNumbers",
      "providerVendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
      "notes",
    ],
    bulk: [],
    audit: [
      "name",
      "identity",
      "provisional",
      "sourceAliases",
      "cardNumbers",
      "notes",
      "providerVendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
    ],
    sort: {
      fields: [
        "name",
        "provisional",
        "transactionCount",
        "createdAt",
        "updatedAt",
      ],
      default: "name",
      // A name roster reads A→Z; the table's blanket descending default was
      // opening the account list backwards.
      direction: "asc",
    },
    intents: {
      fields: {
        capture: [
          "name",
          "kind",
          "issuer",
          "network",
          "institution",
          "accountType",
          "provider",
          "providerVendorId",
          "last4",
          "provisional",
          "sourceAliases",
          "notes",
        ],
        full: [
          "name",
          "providerVendorId",
          "provisional",
          "sourceAliases",
          "inventoryOwnerDefaultEnabled",
          "notes",
        ],
        identity: ["name", "provisional", "sourceAliases", "notes"],
      },
      create: ["capture", "full"],
      update: ["full", "identity"],
      editorFields: [
        "kind",
        "issuer",
        "network",
        "institution",
        "accountType",
        "provider",
        "last4",
      ],
    },
    output: [
      "id",
      "name",
      "identity",
      "provisional",
      "sourceAliases",
      "cardNumbers",
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
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/financial-account",
      export: "financialAccountFilterFields",
    },
    descriptors: [
      {
        columnId: "providerVendorId",
        kind: "idMulti",
        placeholder: "Filter by provider...",
        brandRef: { entity: "vendor" },
        urlOnly: true,
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "ledgerPartyId",
        kind: "idMulti",
        placeholder: "Filter by ledger party...",
        brandRef: { entity: "ledgerParty" },
        urlOnly: true,
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search accounts...",
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "identity",
        field: "identityKind",
        kind: "multiselect",
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
        columnId: "provisional",
        kind: "boolean",
        placeholder: "Filter by status...",
        deriveSchema: true,
        stored: true,
        options: [
          { value: "false", label: "Known" },
          { value: "true", label: "Provisional" },
        ],
      },
      {
        columnId: "aliases",
        field: "sourceAliasPresenceFilter",
        kind: "presence",
        placeholder: "Filter aliases...",
        options: [
          { value: "has", label: "Has aliases", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "last4",
        kind: "text",
        placeholder: "Filter by last four digits...",
        urlOnly: true,
      },
      {
        columnId: "source",
        kind: "multiselect",
        placeholder: "Filter by source...",
        urlOnly: true,
      },
      {
        columnId: "externalAccountId",
        kind: "multiselect",
        placeholder: "Filter by external account id...",
        urlOnly: true,
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
        urlOnly: true,
      },
      {
        columnId: "financialTransactionPresenceFilter",
        kind: "presence",
        placeholder: "Filter related transactions presence...",
        urlOnly: true,
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
        urlOnly: true,
      },
      {
        columnId: "purchasePresenceFilter",
        kind: "presence",
        placeholder: "Filter related purchases presence...",
        urlOnly: true,
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
        urlOnly: true,
      },
      {
        columnId: "vendorPresenceFilter",
        kind: "presence",
        placeholder: "Filter related vendors presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "provider-vendor",
      label: "Stored-value provider",
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
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: { storage: false },
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
          id: "financial_account_ledger_party",
          facet: "linkage",
          weight: 1,
          label: "Ledger party",
          message: "No ledger party is linked to this account.",
        },
        {
          id: "financial_account_confirmed",
          facet: "identity",
          weight: 1,
          label: "Confirmed",
          message: "This account is still provisional.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/financial-account.entity-adapter",
        export: "financialAccountEntityAdapter",
      },
      search: "document",
    },
  },
});
