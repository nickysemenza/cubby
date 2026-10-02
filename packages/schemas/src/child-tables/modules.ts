import { imageProcessingChildren } from "./image-processing.js";
import { defineChildTable } from "../entity-definitions/child-definition.js";

export const modulesChildren = [
  ...imageProcessingChildren,
  /** Human-confirmed merchant routing; never inferred repeatedly at write time. */
  defineChildTable({
    name: "MerchantVendorRule",
    exportName: "merchantVendorRule",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "ledgerPartyId",
        kind: "uuid",
        notNull: true,
        type: "LedgerPartyId",
        reference: { table: "ledgerParty", column: "id" },
      },
      { key: "normalizedMerchant", kind: "text", notNull: true },
      {
        key: "vendorId",
        kind: "uuid",
        notNull: true,
        type: "VendorId",
        reference: { table: "vendor", column: "id" },
      },
      {
        key: "confirmedByUserId",
        kind: "text",
        notNull: true,
        reference: { table: "user", column: "id" },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    types: [
      {
        module: "@cubby/schemas/identifiers",
        exports: ["LedgerPartyId", "VendorId"],
      },
    ],
    indexes: [
      {
        name: "MerchantVendorRule_party_merchant_key",
        unique: true,
        on: ["ledgerPartyId", "normalizedMerchant"],
      },
    ],
  }),
  defineChildTable({
    name: "MailboxCursor",
    exportName: "mailboxCursor",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "ledgerPartyId",
        kind: "uuid",
        notNull: true,
        type: "LedgerPartyId",
        reference: { table: "ledgerParty", column: "id" },
      },
      { key: "provider", kind: "text", notNull: true, default: "gmail" },
      { key: "historyId", kind: "text" },
      { key: "lastPolledAt", kind: "timestamp" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    types: [
      { module: "@cubby/schemas/identifiers", exports: ["LedgerPartyId"] },
    ],
    indexes: [
      {
        name: "MailboxCursor_party_provider_key",
        unique: true,
        on: ["ledgerPartyId", "provider"],
      },
    ],
  }),
  defineChildTable({
    name: "OrderMail",
    exportName: "orderMail",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "ledgerPartyId",
        kind: "uuid",
        notNull: true,
        type: "LedgerPartyId",
        reference: { table: "ledgerParty", column: "id" },
      },
      {
        key: "vendorId",
        kind: "uuid",
        type: "VendorId",
        reference: { table: "vendor", column: "id" },
      },
      { key: "messageId", kind: "text", notNull: true },
      { key: "threadId", kind: "text" },
      { key: "historyId", kind: "text" },
      { key: "sender", kind: "text", notNull: true },
      { key: "subject", kind: "text", notNull: true },
      { key: "receivedAt", kind: "timestamp", notNull: true },
      { key: "rawChecksum", kind: "text", notNull: true },
      { key: "classifiedChecksum", kind: "text" },
      {
        key: "content",
        kind: "jsonb",
        type: "{\n        snippet: string | null;\n        bodyText: string | null;\n        bodyHtml: string | null;\n      }",
        notNull: true,
        default: {
          sql: '\'{"snippet":null,"bodyText":null,"bodyHtml":null}\'::jsonb',
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    types: [
      {
        module: "@cubby/schemas/identifiers",
        exports: ["LedgerPartyId", "VendorId"],
      },
    ],
    indexes: [
      {
        name: "OrderMail_party_message_key",
        unique: true,
        on: ["ledgerPartyId", "messageId"],
      },
      {
        name: "OrderMail_party_received_idx",
        on: ["ledgerPartyId", { column: "receivedAt", desc: true }],
      },
    ],
  }),
  defineChildTable({
    name: "OrderMailEvent",
    exportName: "orderMailEvent",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "orderMailId",
        kind: "uuid",
        notNull: true,
        reference: { table: "orderMail", column: "id" },
      },
      { key: "event", kind: "text", notNull: true },
      { key: "orderId", kind: "text" },
      { key: "amount", kind: "doublePrecision" },
      { key: "currency", kind: "text" },
      { key: "occurredAt", kind: "timestamp" },
      { key: "sourceKey", kind: "text", notNull: true },
      {
        key: "payload",
        kind: "jsonb",
        notNull: true,
        default: { sql: "'{}'::jsonb" },
      },
      { key: "supersededAt", kind: "timestamp" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    indexes: [
      {
        name: "OrderMailEvent_source_key",
        unique: true,
        on: ["orderMailId", "sourceKey"],
      },
      { name: "OrderMailEvent_order_idx", on: ["orderId"] },
    ],
  }),
  /** Human decisions about a specific mail event and proposed Purchase match. */
  defineChildTable({
    name: "OrderMailCandidateDecision",
    exportName: "orderMailCandidateDecision",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "eventId",
        kind: "uuid",
        notNull: true,
        reference: { table: "orderMailEvent", column: "id" },
      },
      {
        key: "purchaseId",
        kind: "uuid",
        notNull: true,
        type: "PurchaseId",
        reference: { table: "purchase", column: "id" },
      },
      {
        key: "decision",
        kind: "text",
        notNull: true,
        type: '"linked" | "dismissed"',
      },
      { key: "evidenceChecksum", kind: "text", notNull: true },
      { key: "decidedByUserId", kind: "text", notNull: true },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    types: [{ module: "@cubby/schemas/identifiers", exports: ["PurchaseId"] }],
    indexes: [
      {
        name: "OrderMailCandidateDecision_event_purchase_key",
        unique: true,
        on: ["eventId", "purchaseId"],
      },
      {
        name: "OrderMailCandidateDecision_one_link_key",
        unique: true,
        on: ["eventId"],
        where: "{decision} = 'linked'",
      },
      { name: "OrderMailCandidateDecision_purchase_idx", on: ["purchaseId"] },
    ],
    checks: [
      {
        name: "OrderMailCandidateDecision_decision_check",
        sql: "{decision} IN ('linked', 'dismissed')",
      },
    ],
  }),
  defineChildTable({
    name: "OrderMailAttachment",
    exportName: "orderMailAttachment",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "orderMailId",
        kind: "uuid",
        notNull: true,
        reference: { table: "orderMail", column: "id" },
      },
      { key: "providerAttachmentId", kind: "text", notNull: true },
      { key: "filename", kind: "text", notNull: true },
      { key: "mimeType", kind: "text", notNull: true },
      { key: "checksum", kind: "text", notNull: true },
      // Object-storage key (`order-mail-attachment/<id>`) of the pending bytes.
      { key: "pendingObjectKey", kind: "text" },
      {
        key: "imageId",
        kind: "uuid",
        reference: { table: "image", column: "id" },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    indexes: [
      {
        name: "OrderMailAttachment_provider_key",
        unique: true,
        on: ["orderMailId", "providerAttachmentId"],
      },
    ],
  }),
  defineChildTable({
    name: "StatementImport",
    exportName: "statementImport",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "source",
        kind: "text",
        notNull: true,
        reference: {
          table: "externalSource",
          column: "slug",
          onUpdate: "cascade",
        },
      },
      { key: "label", kind: "text", notNull: true },
      { key: "fingerprint", kind: "text", notNull: true },
      /**
       * Which date the provider's rows carry. Recorded, never resolved: one export
       * has one convention, and 19% of charges present in both Copilot and Monarch
       * are dated differently because the providers disagree on posting vs
       * transaction date. Stating it beats guessing per row.
       */
      { key: "dateKind", kind: "text", notNull: true, default: "unknown" },
      { key: "rowCountDeclared", kind: "integer" },
      { key: "notes", kind: "text" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
      { key: "deletedAt", kind: "timestamp" },
    ],
    indexes: [
      {
        name: "StatementImport_source_fingerprint_key",
        unique: true,
        on: ["source", "fingerprint"],
        where: "{deletedAt} IS NULL",
      },
      { name: "StatementImport_source_idx", on: ["source"] },
    ],
    checks: [
      {
        name: "StatementImport_source_slug_check",
        sql: "{source} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND {source} = lower(trim({source}))",
      },
      {
        name: "StatementImport_dateKind_check",
        sql: "{dateKind} IN ('posted', 'transaction', 'unknown')",
      },
      {
        name: "StatementImport_rowCountDeclared_check",
        sql: "{rowCountDeclared} IS NULL OR {rowCountDeclared} >= 0",
      },
    ],
  }),
  /**
   * One verbatim row from a provider export.
   *
   * Match state is **derived**, not stored: a row is matched when a live
   * `settlement_ref` `EntityExternalId` names its `(source, externalId)` pair.
   * That join needs no DISTINCT because the live `(source, kind, externalId)`
   * unique allows one owner per pair.
   *
   * The provider columns are immutable after ingest; the only mutable fields are
   * the judgments an agent explicitly writes (`accountId`, `disposition*`,
   * `supersededByRowId`, `notes`).
   */
  defineChildTable({
    name: "StatementRow",
    exportName: "statementRow",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "batchId",
        kind: "uuid",
        notNull: true,
        reference: { table: "statementImport", column: "id" },
      },
      {
        key: "source",
        kind: "text",
        notNull: true,
        reference: {
          table: "externalSource",
          column: "slug",
          onUpdate: "cascade",
        },
      },
      { key: "externalId", kind: "text", notNull: true },
      { key: "rowPosition", kind: "integer" },
      { key: "providerTransactionId", kind: "text" },
      { key: "legacyExternalId", kind: "text" },
      { key: "accountDescriptor", kind: "text", notNull: true },
      { key: "statementDate", kind: "date", notNull: true },
      { key: "amount", kind: "doublePrecision", notNull: true },
      /**
       * The export's own signed figure. Earns its bytes: with it,
       * (source, accountDescriptor, statementDate, providerAmount,
       * rawDescription) reproduces the hash payload exactly, so the ledger can
       * audit its own identity function. Without it `externalId` is an
       * unverifiable opaque token — and that hash is the whole matching mechanism.
       */
      { key: "providerAmount", kind: "doublePrecision", notNull: true },
      { key: "merchant", kind: "text" },
      { key: "rawDescription", kind: "text", notNull: true },
      { key: "sourceCategory", kind: "text" },
      { key: "providerStatus", kind: "text" },
      { key: "providerNotes", kind: "text" },
      {
        key: "accountId",
        kind: "uuid",
        type: "FinancialAccountId",
        reference: { table: "financialAccount", column: "id" },
      },
      { key: "disposition", kind: "text", notNull: true, default: "open" },
      { key: "dispositionReason", kind: "text" },
      { key: "dispositionNote", kind: "text" },
      /**
       * A pending row that posts on a different date is a *different* row — the
       * export really did contain two. This link is agent-written, never
       * inferred, and drops the predecessor from the worklist without deleting
       * the evidence that it existed.
       */
      {
        key: "supersededByRowId",
        kind: "uuid",
        reference: { table: "statementRow", column: "id" },
      },
      { key: "notes", kind: "text" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
      { key: "deletedAt", kind: "timestamp" },
    ],
    types: [
      { module: "@cubby/schemas/identifiers", exports: ["FinancialAccountId"] },
    ],
    indexes: [
      {
        name: "StatementRow_source_externalId_key",
        unique: true,
        on: ["source", "externalId"],
        where: "{deletedAt} IS NULL",
      },
      {
        name: "StatementRow_batch_position_key",
        unique: true,
        on: ["batchId", "rowPosition"],
        where: "{deletedAt} IS NULL",
      },
      {
        name: "StatementRow_source_providerTransactionId_idx",
        on: ["source", "providerTransactionId"],
      },
      { name: "StatementRow_batchId_idx", on: ["batchId"] },
      { name: "StatementRow_statementDate_idx", on: ["statementDate"] },
      {
        name: "StatementRow_worklist_idx",
        on: [{ column: "statementDate", desc: true }],
        where:
          "{deletedAt} IS NULL AND {disposition} = 'open' AND {supersededByRowId} IS NULL",
      },
      {
        name: "StatementRow_account_date_amount_idx",
        on: ["accountId", "statementDate", "amount"],
      },
      // The drift sweep groups on the DESCRIPTOR, not `accountId` — that column
      // is an agent-written judgment and is null for most of the backlog, so the
      // index above does not serve the group. Deliberately not partial on
      // `deletedAt`: `drizzle-kit push` applies index predicates as a no-op, so a
      // partial index here would exist in the schema file and nowhere else.
      {
        name: "StatementRow_descriptor_date_amount_idx",
        on: ["source", "accountDescriptor", "statementDate", "providerAmount"],
      },
      {
        name: "StatementRow_rawDescription_gin_idx",
        using: "gin",
        on: [{ sql: "{rawDescription} gin_trgm_ops" }],
      },
    ],
    checks: [
      {
        name: "StatementRow_position_check",
        sql: "{rowPosition} IS NULL OR {rowPosition} > 0",
      },
      {
        name: "StatementRow_source_slug_check",
        sql: "{source} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND {source} = lower(trim({source}))",
      },
      {
        name: "StatementRow_amount_whole_cent_check",
        sql: "abs({amount} * 100 - round({amount} * 100)) < 0.0000001",
      },
      {
        name: "StatementRow_providerAmount_whole_cent_check",
        sql: "abs({providerAmount} * 100 - round({providerAmount} * 100)) < 0.0000001",
      },
      {
        name: "StatementRow_providerStatus_check",
        sql: "{providerStatus} IS NULL OR {providerStatus} IN ('posted', 'pending')",
      },
      // Ignoring a row is a judgment and must carry its reasoning; leaving it open
      // is the default and needs none.
      {
        name: "StatementRow_disposition_check",
        sql: "({disposition} = 'open' AND {dispositionReason} IS NULL AND {dispositionNote} IS NULL)\n          OR ({disposition} = 'ignored' AND {dispositionReason} IS NOT NULL AND {dispositionNote} IS NOT NULL)",
      },
      // The enum is enforced by zod at the router/MCP boundary, but the bulk
      // disposition scripts write this column over raw SQL and bypass that. A
      // typo would store cleanly and then throw on the read path, 500ing the list
      // for the whole source — so the vocabulary is pinned here too.
      {
        name: "StatementRow_dispositionReason_check",
        sql: "{dispositionReason} IS NULL OR {dispositionReason} IN\n          ('not_modeled', 'not_a_purchase', 'duplicate_of_other_source', 'pre_cubby', 'other')",
      },
      {
        name: "StatementRow_externalId_format_check",
        sql: "{externalId} ~ '^v[12]:[0-9a-f]{64}$'",
      },
    ],
  }),
];
