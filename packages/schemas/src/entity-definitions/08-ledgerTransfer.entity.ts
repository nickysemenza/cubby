import { defineEntity } from "./definition.js";
import { plainDate } from "@cubby/schemas/base-entity";
import {
  financialTransactionShortcode,
  ledgerPartyShortcode,
  ledgerTransferShortcode,
} from "../identifier-fields.js";
import {
  ledgerSourceClaims,
  ledgerSourceClaimsOut,
  ledgerTransferAmount,
  ledgerTransferClassification,
  ledgerTransferEvidenceTransactionIds,
} from "@cubby/schemas/ledger-transfer-fields";
import { wholeCentAmount } from "@cubby/schemas/money";
import { z } from "zod";
export default defineEntity({
  key: "ledgerTransfer",
  names: { singular: "Ledger Transfer", plural: "Transfers" },
  route: { basePath: "ledger-transfers", list: true, detail: true },
  table: "LedgerTransfer",
  identifiers: { brand: "LedgerTransferId", shortcode: "LTR-" },
  // Ledger transfers have no name field; `fromPartyName` is the most
  // identifying human-readable value a transfer carries.
  presentation: {
    titleField: "fromPartyName",
    domain: "finance",
    description: "Transfers recorded between ledger parties.",
    emptyState: {
      title: "No transfers yet",
      description:
        "A transfer records money moving between ledger parties after the fact, with its own evidence \u2014 logged from the household contribution ledger.",
    },
    icons: {
      lucide: "ArrowLeftRight",
      sfSymbol: "arrow.left.arrow.right.circle",
    },
    detail: {
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Overview",
          placement: "supporting",
          fields: [
            "fromPartyId",
            "toPartyId",
            "amount",
            "date",
            "notes",
            "classification",
            "createdAt",
            "updatedAt",
          ],
        },
        {
          kind: "fields",
          id: "evidence",
          title: "Evidence transactions",
          fields: ["evidenceTransactionIds"],
        },
      ],
    },
    list: { actions: ["delete"] },
  },
  model: {
    fields: [
      {
        key: "fromPartyId",
        kind: "identifier",
        label: "From",
        reference: { entity: "ledgerParty" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { list: true, detail: true },
        validation: {
          read: ledgerPartyShortcode,
          create: ledgerPartyShortcode,
          update: ledgerPartyShortcode.optional(),
        },
      },
      {
        key: "toPartyId",
        kind: "identifier",
        label: "To",
        reference: { entity: "ledgerParty" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { list: true, detail: true },
        validation: {
          read: ledgerPartyShortcode,
          create: ledgerPartyShortcode,
          update: ledgerPartyShortcode.optional(),
        },
      },
      {
        key: "fromPartyName",
        kind: "text",
        validation: {
          read: z.string(),
          create: null,
          update: null,
        },
      },
      {
        key: "toPartyName",
        kind: "text",
        validation: {
          read: z.string(),
          create: null,
          update: null,
        },
      },
      {
        key: "amount",
        kind: "number",
        control: { kind: "number", renderer: "money" },
        display: { list: true, detail: true },
        validation: {
          read: wholeCentAmount,
          create: ledgerTransferAmount,
          update: ledgerTransferAmount.optional(),
        },
      },
      {
        key: "date",
        kind: "date",
        control: { kind: "date" },
        display: { list: true, detail: true },
        validation: {
          read: plainDate,
          create: plainDate,
          update: plainDate.optional(),
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
        key: "sourceClaims",
        kind: "json",
        control: { kind: "specialized", renderer: "structured-field" },
        validation: {
          read: ledgerSourceClaimsOut,
          create: ledgerSourceClaims.nullable().default([]),
          update: ledgerSourceClaims.nullable().optional(),
        },
      },
      {
        key: "evidenceTransactionIds",
        kind: "identifier",
        label: "Evidence",
        reference: { entity: "financialTransaction", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        display: { list: true, detail: true, columnId: "evidenceCount" },
        validation: {
          read: z.array(financialTransactionShortcode),
          create: ledgerTransferEvidenceTransactionIds.nullable().default([]),
          update: ledgerTransferEvidenceTransactionIds.nullable().optional(),
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: ledgerTransferShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "classification",
        kind: "json",
        display: { detail: true },
        validation: {
          read: ledgerTransferClassification,
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
        specialized: "primary-key:LedgerTransferId",
      },
      { key: "shortcode", specialized: "shortcode" },
      { key: "fromPartyId", reference: "ledgerParty" },
      { key: "toPartyId", reference: "ledgerParty" },
      { key: "amount", specialized: "double-precision" },
      "date",
      "notes",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "fromPartyId",
      "toPartyId",
      "amount",
      "date",
      "notes",
      "sourceClaims",
      "evidenceTransactionIds",
    ],
    update: [
      "fromPartyId",
      "toPartyId",
      "amount",
      "date",
      "notes",
      "sourceClaims",
      "evidenceTransactionIds",
    ],
    bulk: [],
    audit: [
      "fromPartyId",
      "toPartyId",
      "amount",
      "date",
      "notes",
      "sourceClaims",
      "evidenceTransactionIds",
    ],
    sort: {
      fields: ["date", "amount", "createdAt", "updatedAt"],
      default: "date",
    },
    intents: {
      fields: {
        full: ["fromPartyId", "toPartyId", "amount", "date", "notes"],
      },
      create: ["full"],
      update: ["full"],
    },
    output: [
      "id",
      "fromPartyId",
      "toPartyId",
      "fromPartyName",
      "toPartyName",
      "amount",
      "date",
      "notes",
      "classification",
      "sourceClaims",
      "evidenceTransactionIds",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: {
      module: "@cubby/schemas/ledger-transfer",
      export: "ledgerTransferCreateInput",
    },
    update: {
      module: "@cubby/schemas/ledger-transfer",
      export: "ledgerTransferUpdateData",
    },
    output: {
      module: "@cubby/schemas/ledger-transfer",
      export: "ledgerTransferOut",
    },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/ledger-transfer",
      export: "ledgerTransferFilterFields",
    },
    descriptors: [
      {
        columnId: "fromPartyId",
        kind: "idMulti",
        placeholder: "Filter by from party...",
        brandRef: { entity: "ledgerParty" },
        urlOnly: true,
      },
      {
        columnId: "toPartyId",
        kind: "idMulti",
        placeholder: "Filter by to party...",
        brandRef: { entity: "ledgerParty" },
        urlOnly: true,
      },
      {
        columnId: "date",
        kind: "range",
        placeholder: "Filter by transfer date...",
        deriveSchema: true,
        stored: true,
        range: { kind: "date" },
      },
    ],
  },
  relations: [
    {
      key: "from-party",
      label: "From party",
      target: "ledgerParty",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "LedgerTransfer.fromPartyId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "LedgerTransfer.fromPartyId", direction: "incoming" }],
      },
    },
    {
      key: "to-party",
      label: "To party",
      target: "ledgerParty",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "LedgerTransfer.toPartyId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "LedgerTransfer.toPartyId", direction: "incoming" }],
      },
    },
    {
      key: "evidence-transactions",
      label: "Evidence transactions",
      target: "financialTransaction",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "FinancialTransaction.ledgerTransferId",
            direction: "incoming",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "FinancialTransaction.ledgerTransferId",
            direction: "outgoing",
          },
        ],
      },
    },
  ],
  search: { enabled: false },
  capabilities: {
    auditable: true,
    images: { storage: false },
    countable: false,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "create", "update", "delete"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: {
        module: "~/server/repo/ledger-transfer.entity-adapter",
        export: "ledgerTransferEntityAdapter",
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
