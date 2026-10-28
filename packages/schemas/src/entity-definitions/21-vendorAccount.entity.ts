import { timestampField } from "./field-policy";
import { z } from "zod";
import {
  ledgerPartyShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "../identifier-fields.js";
import { vendorAccountCursor } from "../vendor-account-fields.js";
import { defineEntity, defineEntityModel } from "./definition.js";

export const { definition, readSchemas } = defineEntityModel({
  key: "vendorAccount",
  names: { singular: "Vendor Account", plural: "Vendor Accounts" },
  route: {
    basePath: "vendor-accounts",
  },
  table: "VendorAccount",
  identifiers: { brand: "VendorAccountId", shortcode: "VACCT-" },
  presentation: {
    list: {},
    titleField: "displayName",
    domain: "purchases",
    description: "A member's purchasing relationship with a vendor.",
    emptyState: {
      title: "No vendor accounts yet",
      description:
        "Connect a member to their purchases, including guest checkout and in-store purchases.",
      actionLabel: "Add vendor account",
    },
    icons: { phosphor: "Key", sfSymbol: "person.badge.key", emoji: "🔑" },
    detail: {
      summary: [
        {
          kind: "records",
          id: "seller",
          title: "Seller",
          viewKey: "relation:vendor",
        },
        {
          kind: "records",
          id: "member",
          title: "Member",
          viewKey: "relation:ledger-party",
        },
        {
          kind: "fields",
          id: "purchase-count",
          title: "Purchase count",
          fields: ["purchaseCount"],
        },
        {
          kind: "records",
          id: "purchases",
          title: "Purchases",
          viewKey: "relation:purchases",
        },
        {
          kind: "chart",
          id: "monthly-spend",
          title: "Spend over 12 months",
          viewKey: "expenses",
        },
        {
          kind: "fields",
          id: "import-health",
          title: "Import health",
          fields: ["lastRunAt", "lastSuccessAt"],
        },
        {
          kind: "report",
          id: "emails",
          title: "Emails",
          slot: "vendorAccount.email-summary",
        },
      ],

      activityRelations: [{ relation: "purchases", dateField: "date" }],

      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Record",
          fields: ["vendorId", "ledgerPartyId", "inventoryOwnerDefaultEnabled"],
        },
        {
          kind: "fields",
          id: "coverage",
          title: "Coverage and summaries",
          fields: [
            "displayName",
            "lastRunAt",
            "lastSuccessAt",
            "purchaseCount",
            "createdAt",
            "updatedAt",
          ],
        },
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
        display: {},
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "vendorId",
        kind: "identifier",
        reference: { entity: "vendor" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          columnGroup: "Account",
          mobile: { slot: "subtitle", priority: 10 },
          labelPath: "vendorName",
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
        display: { columnGroup: "Account", labelPath: "ledgerPartyName" },
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
        display: { list: false },
        validation: {
          read: z.boolean(),
          create: z.boolean().default(false),
          update: z.boolean().optional(),
        },
      },
      {
        display: { detail: false, list: false },
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
        display: { columnGroup: "Imports", format: "timestamp" },
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
          columnGroup: "Imports",
          columnLabel: "Last success",
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
        display: { columnGroup: "Imports", columnBar: true, width: "sm" },
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
        display: { detail: false, list: false },
        key: "id",
        kind: "identifier",
        validation: {
          read: vendorAccountShortcode,
          create: null,
          update: null,
        },
      },
      timestampField("createdAt"),
      timestampField("updatedAt"),
      { output: false, key: "shortcode", kind: "text" },
      { output: false, key: "deletedAt", kind: "timestamp", nullable: true },
    ],
    storage: [
      {
        key: "id",
        specialized: "primary-key:VendorAccountId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "vendorId",
      "ledgerPartyId",
      {
        key: "inventoryOwnerDefaultEnabled",
        defaultValue: false,
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

    derived: {
      // The Vendor and member names; its SQL is `vendorAccountLabelSql`.
      displayName: { type: "text" },
      lastRunAt: { type: "date" },
    },
    sort: {
      fields: ["displayName", "lastRunAt", "updatedAt"],
    },
    intents: {
      fields: {
        capture: ["vendorId", "ledgerPartyId"],
        full: ["vendorId", "ledgerPartyId", "inventoryOwnerDefaultEnabled"],
        identity: ["vendorId", "ledgerPartyId"],
      },
      create: ["capture", "full"],
      update: ["full", "identity"],
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
  },
  filters: {
    audit: true,

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
      },
      {
        columnId: "purchasePresenceFilter",
        deriveSchema: true,
        kind: "presence",
        placeholder: "Filter related purchases presence...",
      },
      {
        columnId: "displayName",
        field: "search",
        urlKey: "q",
        kind: "text",
        derived: true,
        placeholder: "Search vendor accounts...",
        deriveSchema: true,
        schemaFromRead: true,
      },
      {
        columnId: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by vendor...",
        brandRef: { entity: "vendor" },
        deriveSchema: true,
      },
      {
        columnId: "ledgerPartyId",
        kind: "idMulti",
        placeholder: "Filter by member...",
        brandRef: { entity: "ledgerParty" },
        currentMember: true,
        deriveSchema: true,
      },
    ],
  },

  search: false,
  capabilities: {
    images: {
      storage: false,
    },
    countable: false,
    delete: { mode: "soft", bulk: true },
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

export default defineEntity(
  definition,
  (r) => [
    r
      .path("purchase", "many", [
        { edge: "Purchase.vendorAccountId", direction: "incoming" },
      ])
      .named("purchases", "Purchases", {
        view: {
          columnGroup: "Imports",
          order: "newest",
          defaultVisible: true,
          filter: false,
        },
      }),
    // Its Vendor's Emails owned by the account's member (ADR 0011).
    r
      .derived("email", "many", "vendorAccountId", [
        "ImportSourceOrder",
        "AssessmentState",
        "OrderMailEvent",
      ])
      .named("emails", "Emails", {
        sources: [
          r
            .query("vendorAccountEmails", "many")
            .source("accepted", "Account Email evidence"),
        ],
      }),
    r.field("vendorId").named("vendor", "Vendor"),
    r.field("ledgerPartyId").named("ledger-party", "Member"),
  ],
  readSchemas,
);
