import { defineEntity } from "./definition.js";
import { ledgerPartyShortcode } from "../identifier-fields.js";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party-fields";
import { z } from "zod";
export default defineEntity({
  key: "ledgerParty",
  names: { singular: "Ledger Party", plural: "Ledger Parties" },
  route: { basePath: "ledger-parties" },
  table: "LedgerParty",
  identifiers: { brand: "LedgerPartyId", shortcode: "LPY-", legacy: null },
  presentation: { titleField: "name" },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text" },
        display: { list: true, detail: true },
        validation: {
          read: z.string(),
          create: z.string().trim().min(1, "Ledger party name is required"),
          update: z
            .string()
            .trim()
            .min(1, "Ledger party name is required")
            .optional(),
        },
      },
      {
        key: "kind",
        kind: "enum",
        control: { kind: "select" },
        display: { list: true, detail: true },
        validation: {
          read: ledgerPartyKind,
          create: ledgerPartyKind,
          update: ledgerPartyKind.optional(),
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
          read: ledgerPartyShortcode,
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
        specialized: "primary-key:LedgerPartyId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      { key: "kind", specialized: "enum:kind" },
      "notes",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: ["name", "kind", "notes"],
    update: ["name", "kind", "notes"],
    bulk: [],
    audit: ["name", "kind", "notes"],
    sort: {
      fields: ["name", "kind", "createdAt", "updatedAt"],
      default: "name",
    },
    intents: {
      fields: {
        full: ["name", "kind", "notes"],
      },
      create: ["full"],
      update: ["full"],
    },
    output: ["id", "name", "kind", "notes", "createdAt", "updatedAt"],
  },
  fields: {
    create: {
      module: "@cubby/schemas/ledger-party",
      export: "ledgerPartyCreateInput",
    },
    update: {
      module: "@cubby/schemas/ledger-party",
      export: "ledgerPartyUpdateData",
    },
    output: { module: "@cubby/schemas/ledger-party", export: "ledgerPartyOut" },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/ledger-party",
      export: "ledgerPartyFilterFields",
    },
    descriptors: [
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search ledger parties...",
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "kind",
        kind: "multiselect",
        placeholder: "Filter by kind...",
        deriveSchema: true,
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/ledger-party-fields",
          export: "ledgerPartyKind",
        },
        options: [
          { value: "member", label: "Member" },
          { value: "guest", label: "Guest" },
          { value: "household", label: "Household" },
        ],
      },
    ],
  },
  relations: [
    {
      key: "expenses",
      label: "Attributed expenses",
      target: "expense",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "ExpenseAttribution.ledgerPartyId", direction: "incoming" },
          { edge: "ExpenseAttribution.expenseId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "ExpenseAttribution.expenseId", direction: "incoming" },
          { edge: "ExpenseAttribution.ledgerPartyId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "financial-accounts",
      label: "Financial accounts",
      target: "financialAccount",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "FinancialAccount.ledgerPartyId", direction: "incoming" },
        ],
      },
      inverse: {
        steps: [
          { edge: "FinancialAccount.ledgerPartyId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "outgoing-transfers",
      label: "Outgoing transfers",
      target: "ledgerTransfer",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "LedgerTransfer.fromPartyId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "LedgerTransfer.fromPartyId", direction: "outgoing" }],
      },
    },
    {
      key: "incoming-transfers",
      label: "Incoming transfers",
      target: "ledgerTransfer",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "LedgerTransfer.toPartyId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "LedgerTransfer.toPartyId", direction: "outgoing" }],
      },
    },
  ],
  search: { enabled: false },
  capabilities: {
    auditable: true,
    images: false,
    countable: false,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: true,
    operationOwners: { delete: "kernel", merge: "kernel" },
    mcp: ["get", "list", "create", "update", "delete", "merge"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: { plural: "ledger_parties" },
    ports: {
      repository: {
        module: "~/server/repo/ledger-party.entity-adapter",
        export: "ledgerPartyEntityAdapter",
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
      search: { projection: null, semanticText: null, dependentRefresh: null },
    },
  },
});
