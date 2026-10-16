import { z } from "zod";

import {
  ledgerPartyShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "../identifier-fields.js";
import {
  vendorAccountCursor,
  vendorAccountStatus,
} from "../vendor-account-fields.js";
import { defineEntity } from "./definition.js";

export default defineEntity({
  key: "vendorAccount",
  names: { singular: "Vendor Account", plural: "Vendor Accounts" },
  route: {
    basePath: "vendor-accounts",
  },
  table: "VendorAccount",
  identifiers: { brand: "VendorAccountId", shortcode: "VACCT-" },
  presentation: {
    list: {
      read: {
        derived: ["lastRunAt", "lastSuccessAt", "purchaseCount"],
        relations: [
          "vendorId",
          "ledgerPartyId",
          "vendorName",
          "ledgerPartyName",
        ],
        media: ["displayImages"],
      },
    },
    titleField: "displayName",
    domain: "finance",
    description: "A member's purchasing relationship with a vendor.",
    emptyState: {
      title: "No vendor accounts yet",
      description:
        "Connect a member to their purchases, including guest checkout and in-store purchases.",
      actionLabel: "Add vendor account",
    },
    icons: { phosphor: "Key", sfSymbol: "person.badge.key", emoji: "🔑" },
    detail: {
      additionalSections: [
        {
          kind: "relation",
          id: "emails",
          title: "Emails",
          relation: "emails",
          filter: { descriptor: "vendorAccountId" },
          columns: ["receivedAt", "sender", "linkState", "purchaseLinks"],
          // Linked, then suggestions to act on, then dismissals, newest first.
          sort: { field: "linkState", direction: "asc" },
        },
      ],
    },
  },
  model: {
    fields: [
      {
        // Read-only: always the current Vendor and member names, so a parent
        // rename can never leave a stale account title behind.
        key: "displayName",
        kind: "text",
        provenance: {
          kind: "derived",
          sources: [
            { entity: "vendor", relation: "vendor" },
            { entity: "ledgerParty", relation: "ledger-party" },
          ],
        },
        display: { list: true, detail: true },
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "vendorId",
        kind: "identifier",
        reference: { entity: "vendor" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          list: true,
          detail: true,
          mobile: { slot: "subtitle", priority: 10 },
        },
        validation: {
          read: vendorShortcode,
          create: vendorShortcode,
          update: vendorShortcode.optional(),
        },
      },
      {
        key: "ledgerPartyId",
        kind: "identifier",
        reference: { entity: "ledgerParty" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          list: true,
          detail: true,
        },
        validation: {
          read: ledgerPartyShortcode,
          create: ledgerPartyShortcode,
          update: ledgerPartyShortcode.optional(),
        },
      },
      {
        key: "inventoryOwnerDefaultEnabled",
        kind: "boolean",
        control: { kind: "checkbox" },
        display: { detail: true },
        validation: {
          read: z.boolean(),
          create: z.boolean().default(false),
          update: z.boolean().optional(),
        },
      },
      {
        key: "status",
        kind: "enum",
        control: {
          kind: "select",
          options: [
            { value: "active", label: "Active" },
            { value: "disabled", label: "Disabled" },
          ],
        },
        display: {
          list: true,
          detail: true,
          mobile: { slot: "trailing", priority: 10 },
        },
        validation: {
          read: vendorAccountStatus,
          create: vendorAccountStatus.default("active"),
          update: vendorAccountStatus.optional(),
        },
      },
      {
        key: "cursor",
        kind: "json",
        validation: {
          read: vendorAccountCursor,
          create: null,
          update: null,
        },
      },
      {
        key: "lastRunAt",
        kind: "timestamp",
        nullable: true,
        provenance: {
          kind: "derived",
          sources: [{ label: "Latest Run start for this account" }],
        },
        display: { list: true, detail: true, format: "timestamp" },
        validation: {
          read: z.date().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "lastSuccessAt",
        kind: "timestamp",
        nullable: true,
        provenance: {
          kind: "derived",
          sources: [{ label: "Latest completed Run end for this account" }],
        },
        display: {
          columnLabel: "Last success",
          list: true,
          detail: true,
          format: "timestamp",
        },
        validation: {
          read: z.date().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "purchaseCount",
        kind: "number",
        display: { list: true, detail: true, width: "sm" },
        provenance: {
          kind: "derived",
          sources: [{ entity: "purchase", relation: "purchases" }],
        },
        explanation: {
          ruleId: "vendor-account.purchase-count",
          description:
            "Number of live purchases assigned to this vendor account.",
          readPath: "purchaseCount",
        },
        validation: {
          read: z.number().int().nonnegative(),
          create: null,
          update: null,
        },
      },
      {
        key: "vendorName",
        kind: "text",
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "ledgerPartyName",
        kind: "text",
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: vendorAccountShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { detail: true },
        validation: { read: z.date(), create: null, update: null },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { detail: true },
        validation: { read: z.date(), create: null, update: null },
      },
      { key: "shortcode", kind: "text" },
      {
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
      },
    ],
    storage: [
      {
        key: "id",
        specialized: "primary-key:VendorAccountId",
      },
      { key: "shortcode", specialized: "shortcode" },
      { key: "vendorId", reference: "vendor" },
      { key: "ledgerPartyId", reference: "ledgerParty" },
      {
        key: "inventoryOwnerDefaultEnabled",
        defaultValue: false,
      },
      {
        key: "status",
        defaultValue: "active",
        specialized: "enum:status",
      },
      {
        key: "cursor",
        defaultValue:
          '\'{"newestOrderAt":null,"orderIdsOnNewestDate":[],"backfillBeforeOrderAt":null,"earliestAvailableOrderAt":null}\'::jsonb',
        specialized: "json:cursor",
      },
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "vendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
      "status",
    ],
    update: [
      "vendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
      "status",
    ],
    bulk: [],
    audit: [
      "vendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
      "status",
    ],
    sort: {
      fields: ["displayName", "status", "lastRunAt", "updatedAt"],
      computed: ["displayName"],
    },
    intents: {
      fields: {
        capture: ["vendorId", "ledgerPartyId"],
        full: [
          "vendorId",
          "ledgerPartyId",
          "inventoryOwnerDefaultEnabled",
          "status",
        ],
        identity: ["vendorId", "ledgerPartyId"],
      },
      create: ["capture", "full"],
      update: ["full", "identity"],
    },
    output: [
      "id",
      "displayName",
      "vendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
      "status",
      "cursor",
      "lastRunAt",
      "lastSuccessAt",
      "purchaseCount",
      "vendorName",
      "ledgerPartyName",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: {
      module: "@cubby/schemas/vendor-account",
      export: "vendorAccountCreateInput",
    },
    update: {
      module: "@cubby/schemas/vendor-account",
      export: "vendorAccountUpdateData",
    },
    output: {
      module: "@cubby/schemas/vendor-account",
      export: "vendorAccountOut",
    },
  },
  storage: {
    indexes: [
      {
        name: "VendorAccount_vendor_member_key",
        on: ["vendorId", "ledgerPartyId"],
        unique: true,
        where: "{deletedAt} IS NULL",
      },
    ],
    checks: [{ column: "status" }],
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/vendor-account",
      export: "vendorAccountFilterFields",
    },
    descriptors: [
      {
        columnId: "related:vendorAccount.purchases",
        field: "purchaseSearch",
        deriveSchema: true,
        urlKey: "related-purchase",
        kind: "text",
        placeholder: "Search related purchases...",
      },
      {
        columnId: "purchaseId",
        deriveSchema: true,
        kind: "idMulti",
        placeholder: "Filter by related purchase...",
        brandRef: { entity: "purchase" },
        urlOnly: true,
      },
      {
        columnId: "purchasePresenceFilter",
        deriveSchema: true,
        kind: "presence",
        placeholder: "Filter related purchases presence...",
        urlOnly: true,
      },
      {
        columnId: "displayName",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search vendor accounts...",
        deriveSchema: true,
        schemaFromRead: true,
      },
      {
        columnId: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by vendor...",
        brandRef: { entity: "vendor" },
        urlOnly: true,
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "ledgerPartyId",
        kind: "idMulti",
        placeholder: "Filter by member...",
        brandRef: { entity: "ledgerParty" },
        urlOnly: true,
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "status",
        kind: "multiselect",
        placeholder: "Filter by status...",
        deriveSchema: true,
        stored: true,
        options: [
          { value: "active", label: "Active" },
          { value: "disabled", label: "Disabled" },
        ],
      },
    ],
  },
  relations: [
    {
      key: "purchases",
      label: "Purchases",
      target: "purchase",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Purchase.vendorAccountId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Purchase.vendorAccountId", direction: "outgoing" }],
      },
    },
    {
      key: "emails",
      label: "Emails",
      target: "email",
      cardinality: "many",
      // Its Vendor's Emails owned by the account's member (ADR 0011).
      provenance: {
        kind: "derived",
        filter: "vendorAccountId",
        evidence: ["ImportSourceOrder", "AssessmentState", "OrderMailEvent"],
      },
    },
    {
      key: "vendor",
      label: "Vendor",
      target: "vendor",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "VendorAccount.vendorId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "VendorAccount.vendorId", direction: "incoming" }],
      },
    },
    {
      key: "ledger-party",
      label: "Member",
      target: "ledgerParty",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "VendorAccount.ledgerPartyId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "VendorAccount.ledgerPartyId", direction: "incoming" }],
      },
    },
  ],
  search: false,
  capabilities: {
    images: {
      storage: false,
    },
    countable: false,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/vendor-account/repo/vendor-account",
        export: "vendorAccountRepository",
      },
    },
  },
});
