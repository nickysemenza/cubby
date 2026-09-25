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
  route: { basePath: "ledger-transfers" },
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
      phosphor: "ArrowsLeftRight",
      sfSymbol: "arrow.left.arrow.right.circle",
      emoji: "🔁",
    },
    detail: {
      additionalSectionOverrides: [
        {
          kind: "fields",
          id: "evidence",
          title: "Evidence transactions",
          fields: ["evidenceTransactionIds"],
        },
      ],
    },
  },
  model: {
    fields: [
      {
        key: "fromPartyId",
        kind: "identifier",
        reference: { entity: "ledgerParty" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          list: true,
          detail: true,
          width: "md",
          mobile: { slot: "title", priority: 0 },
        },
        validation: {
          read: ledgerPartyShortcode,
          create: ledgerPartyShortcode,
          update: ledgerPartyShortcode.optional(),
        },
      },
      {
        key: "toPartyId",
        kind: "identifier",
        reference: { entity: "ledgerParty" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          list: true,
          detail: true,
          width: "md",
          mobile: { slot: "subtitle", priority: 10 },
        },
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
        display: {
          list: true,
          detail: true,
          width: "sm",
          format: "currency",
          mobile: { slot: "trailing", priority: 1 },
        },
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
        display: {
          list: true,
          detail: true,
          width: "sm",
          format: "plainDate",
          mobile: { slot: "meta", priority: 20 },
        },
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
        provenance: {
          kind: "relation",
          sources: [{ label: "Source claims" }],
        },
        validation: {
          read: ledgerSourceClaimsOut,
          create: ledgerSourceClaims.nullable().default([]),
          update: ledgerSourceClaims.nullable().optional(),
        },
      },
      {
        key: "evidenceTransactionIds",
        kind: "identifier",
        reference: { entity: "financialTransaction", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        display: {
          list: true,
          detail: true,
          width: "sm",
          mobile: { slot: "hidden", priority: 0 },
        },
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
        display: {
          detail: true,
          renderer: { detail: "ledger-transfer-classification" },
        },
        provenance: {
          kind: "derived",
          sources: [{ label: "Transfer parties and evidence" }],
        },
        explanation: {
          ruleId: "ledger-transfer.classification",
          description:
            "Classification is derived from the transfer's source and destination party roles together with its recorded evidence.",
          readPath: "classification",
          sourceDependencies: [
            { path: "fromPartyId", label: "Source party" },
            { path: "toPartyId", label: "Destination party" },
            { path: "evidenceTransactionIds", label: "Evidence transactions" },
          ],
        },
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
        specialized: "primary-key:LedgerTransferId",
      },
      { key: "shortcode", specialized: "shortcode" },
      { key: "fromPartyId", reference: "ledgerParty" },
      { key: "toPartyId", reference: "ledgerParty" },
      { key: "amount", specialized: "double-precision" },
      "date",
      "notes",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
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
    dataQuality: {
      checks: [
        {
          id: "ledger_transfer_transaction",
          facet: "settlement",
          weight: 1,
          label: "Transaction",
          message: "No financial transaction evidences this transfer.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/ledger-transfer",
        export: "ledgerTransferRepository",
      },
    },
  },
});
