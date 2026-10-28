import { assessmentChildren } from "./assessment.js";
import { emailObservationChildren } from "./email-observations.js";
import { emailFinancialAssociationChildren } from "./email-financial-associations.js";
import { importObservationChildren } from "./import-observations.js";
import { imageProcessingChildren } from "./image-processing.js";
import { defineChildTable } from "../entity-definitions/child-definition.js";

export const modulesChildren = [
  ...assessmentChildren,
  ...importObservationChildren,
  ...emailObservationChildren,
  ...emailFinancialAssociationChildren,
  ...imageProcessingChildren,
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
      { key: "mailboxId", kind: "text", notNull: true },
      { key: "coverage", kind: "jsonb", type: "MailboxCoverage" },
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
      {
        module: "@cubby/schemas/mailbox-research",
        exports: ["MailboxCoverage"],
      },
    ],
    indexes: [
      {
        name: "MailboxCursor_party_provider_mailbox_key",
        unique: true,
        on: ["ledgerPartyId", "provider", "mailboxId"],
      },
    ],
  }),
  // Temporary content/source carrier; Email owns identity and headers after backfill.
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
      { key: "rawChecksum", kind: "text", notNull: true },
      { key: "classifiedChecksum", kind: "text" },
      {
        key: "content",
        kind: "jsonb",
        type: "RetainedMailContent",
        notNull: true,
        default: {
          sql: '\'{"snippet":null,"bodyText":null,"bodyHtml":null}\'::jsonb',
        },
      },
      {
        key: "hasRetainedText",
        kind: "boolean",
        notNull: true,
        // Lists need presence, without decompressing each retained original.
        generated: `COALESCE(
          NULLIF(BTRIM({content}->>'snippet'), ''),
          NULLIF(BTRIM({content}->>'bodyText'), ''),
          NULLIF(BTRIM({content}->>'bodyHtml'), '')
        ) IS NOT NULL`,
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
      {
        module: "@cubby/schemas/mailbox-research",
        exports: ["RetainedMailContent"],
      },
    ],
    indexes: [],
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
      // Stored verbatim; new uploads use a distinct key for each attempt.
      { key: "pendingObjectKey", kind: "text" },
      {
        key: "pendingDeleteKeys",
        kind: "text",
        array: true,
        notNull: true,
        default: { sql: "'{}'::text[]" },
      },
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

  /** Export membership is independent of a statement's first-ingesting batch. */
  defineChildTable({
    name: "TransactionImportRecord",
    exportName: "transactionImportRecord",
    columns: [
      {
        key: "importId",
        kind: "uuid",
        notNull: true,
        reference: { table: "transactionImport", column: "id" },
      },
      {
        key: "statementRowId",
        kind: "uuid",
        notNull: true,
        reference: { table: "sourceTransactionRecord", column: "id" },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    indexes: [
      {
        name: "TransactionImportRecord_import_row_key",
        unique: true,
        on: ["importId", "statementRowId"],
      },
      { name: "TransactionImportRecord_row_idx", on: ["statementRowId"] },
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
];
