import { z } from "zod";

import {
  ledgerPartyShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "../identifier-fields.js";
import {
  vendorAccountBrowser,
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
    titleField: "label",
    domain: "finance",
    description: "Member-owned vendor logins used for purchase discovery.",
    emptyState: {
      title: "No vendor accounts yet",
      description:
        "Connect a member to a vendor login before running browser imports.",
      actionLabel: "Add vendor account",
    },
    icons: { phosphor: "Key", sfSymbol: "person.badge.key", emoji: "🔑" },
  },
  model: {
    fields: [
      {
        key: "label",
        kind: "text",
        control: { kind: "text", placeholder: "Household vendor login" },
        display: { list: true, detail: true },
        validation: {
          read: z.string().min(1),
          create: z.string().min(1),
          update: z.string().min(1).optional(),
        },
      },
      {
        key: "vendorId",
        kind: "identifier",
        reference: { entity: "vendor" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { list: true, detail: true },
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
            { value: "paused_auth", label: "Sign-in needed" },
            { value: "paused_offline", label: "Mac offline" },
            { value: "disabled", label: "Disabled" },
          ],
        },
        display: { list: true, detail: true },
        validation: {
          read: vendorAccountStatus,
          create: vendorAccountStatus.default("active"),
          update: vendorAccountStatus.optional(),
        },
      },
      {
        key: "browser",
        kind: "enum",
        control: {
          kind: "select",
          options: [
            { value: "chrome", label: "Chrome" },
            { value: "safari", label: "Safari" },
          ],
        },
        display: { list: true, detail: true },
        validation: {
          read: vendorAccountBrowser,
          create: vendorAccountBrowser.default("chrome"),
          update: vendorAccountBrowser.optional(),
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
        display: { list: true, detail: true, format: "timestamp" },
        validation: {
          read: z.date().nullable(),
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
      "label",
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
        key: "browser",
        defaultValue: "chrome",
        specialized: "enum:browser",
      },
      {
        key: "cursor",
        defaultValue:
          '\'{"newestOrderAt":null,"orderIdsOnNewestDate":[],"backfillBeforeOrderAt":null,"earliestAvailableOrderAt":null}\'::jsonb',
        specialized: "json:cursor",
      },
      "lastRunAt",
      "lastSuccessAt",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "label",
      "vendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
      "status",
      "browser",
    ],
    update: [
      "label",
      "vendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
      "status",
      "browser",
    ],
    bulk: [],
    audit: [
      "label",
      "vendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
      "status",
      "browser",
    ],
    sort: {
      fields: ["label", "status", "lastRunAt", "updatedAt"],
    },
    intents: {
      fields: {
        capture: ["label", "vendorId", "ledgerPartyId", "browser"],
        full: [
          "label",
          "vendorId",
          "ledgerPartyId",
          "inventoryOwnerDefaultEnabled",
          "status",
          "browser",
        ],
        identity: ["label", "vendorId", "ledgerPartyId"],
      },
      create: ["capture", "full"],
      update: ["full", "identity"],
    },
    output: [
      "id",
      "label",
      "vendorId",
      "ledgerPartyId",
      "inventoryOwnerDefaultEnabled",
      "status",
      "browser",
      "cursor",
      "lastRunAt",
      "lastSuccessAt",
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
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/vendor-account",
      export: "vendorAccountFilterFields",
    },
    descriptors: [
      {
        columnId: "label",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search vendor accounts...",
        deriveSchema: true,
        stored: { columns: ["label"] },
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
          { value: "paused_auth", label: "Sign-in needed" },
          { value: "paused_offline", label: "Mac offline" },
          { value: "disabled", label: "Disabled" },
        ],
      },
    ],
  },
  relations: [
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
  search: { enabled: false },
  capabilities: {
    auditable: true,
    images: {
      storage: false,
    },
    countable: false,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "create", "update", "delete"],
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/vendor-account.entity-adapter",
        export: "vendorAccountEntityAdapter",
      },
    },
  },
});
