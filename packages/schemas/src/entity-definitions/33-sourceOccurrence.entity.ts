import { z } from "zod";
import { dateTime } from "../codec";
import { shortcodeSchema } from "../identifier-fields";
import {
  sourceOccurrenceIdentityKind,
  sourceOccurrenceClosure,
  sourceOccurrenceReviewState,
} from "../source-occurrence-fields";
import {
  sourceTransactionRecordDisposition,
  sourceTransactionRecordDispositionReason,
} from "../source-transaction-record-fields";
import { defineEntity, defineEntityModel } from "./definition";
import { readOnly, timestampField } from "./field-policy";

const enumPresentation = (values: readonly string[]) => ({
  display: {
    optionRole: "status" as const,
    optionColor: "neutral-status" as const,
    optionGlyph: { phosphor: "Info", sfSymbol: "info.circle" },
  },
  control: {
    kind: "select" as const,
    options: values.map((value) => ({
      value,
      label: value.replaceAll("_", " "),
      color: "neutral-status" as const,
      glyph: { phosphor: "Info", sfSymbol: "info.circle" },
    })),
  },
});

export const { definition, readSchemas } = defineEntityModel(
  {
    key: "sourceOccurrence",
    names: { singular: "Source occurrence", plural: "Source occurrences" },
    table: "SourceOccurrence",
    identifiers: { brand: "SourceOccurrenceId", shortcode: "SOC-" },
    route: { basePath: "source-occurrences" },
    presentation: {
      titleField: "source",
      searchFacts: ["identityKind", "lastObservedAt"],
      domain: "finance",
      nativeBrowse: false,
      description:
        "One proven event identity within its original source scope.",
      icons: { phosphor: "Receipt", sfSymbol: "doc.text", emoji: "🧾" },
      emptyState: {
        title: "No proven occurrences",
        description:
          "Source intake retains unattested observations separately.",
      },
      list: { savedViews: [] },
      detail: {
        summary: [
          {
            kind: "fields",
            id: "identity",
            title: "Source identity",
            fields: ["source", "identityKind", "reviewState"],
          },
        ],
        sections: [
          {
            kind: "fields",
            id: "occurrence",
            title: "Occurrence",
            fields: [
              "id",
              "source",
              "identityKind",
              "identityScope",
              "providerIdentity",
              "physicalImportId",
              "physicalPosition",
              "currentObservationId",
              "accountId",
              "disposition",
              "dispositionReason",
              "dispositionNote",
              "supersededByOccurrenceId",
              "replacementObservationId",
              "withdrawnAt",
              "withdrawalImportId",
              "lastObservedAt",
              "acceptedTransactionId",
              "reviewState",
              "version",
              "createdAt",
              "updatedAt",
            ],
          },
        ],
      },
    },
    model: {
      fields: [
        {
          key: "id",
          kind: "identifier",
          validation: readOnly(shortcodeSchema("sourceOccurrence")),
        },
        {
          key: "shortcode",
          kind: "text",
          output: false,
          validation: readOnly(z.string()),
        },
        { key: "source", kind: "text", validation: readOnly(z.string()) },
        {
          key: "identityKind",
          kind: "enum",
          ...enumPresentation(sourceOccurrenceIdentityKind.options),
          validation: readOnly(sourceOccurrenceIdentityKind),
        },
        {
          key: "identityScope",
          kind: "text",
          validation: readOnly(z.string()),
        },
        {
          key: "providerIdentity",
          kind: "text",
          nullable: true,
          validation: readOnly(z.string().nullable()),
        },
        {
          key: "physicalImportId",
          kind: "identifier",
          nullable: true,
          reference: { entity: "transactionImport" },
          validation: readOnly(shortcodeSchema("transactionImport").nullable()),
        },
        {
          key: "physicalPosition",
          kind: "number",
          nullable: true,
          validation: readOnly(z.number().int().positive().nullable()),
        },
        {
          key: "currentObservationId",
          kind: "identifier",
          nullable: true,
          reference: { entity: "sourceTransactionRecord" },
          validation: readOnly(
            shortcodeSchema("sourceTransactionRecord").nullable(),
          ),
        },
        {
          key: "accountId",
          kind: "identifier",
          nullable: true,
          reference: { entity: "financialAccount" },
          validation: readOnly(shortcodeSchema("financialAccount").nullable()),
        },
        {
          key: "disposition",
          kind: "enum",
          ...enumPresentation(sourceTransactionRecordDisposition.options),
          validation: readOnly(sourceTransactionRecordDisposition),
        },
        {
          key: "dispositionReason",
          kind: "enum",
          nullable: true,
          ...enumPresentation(sourceTransactionRecordDispositionReason.options),
          validation: readOnly(
            sourceTransactionRecordDispositionReason.nullable(),
          ),
        },
        {
          key: "dispositionNote",
          kind: "text",
          nullable: true,
          validation: readOnly(z.string().nullable()),
        },
        {
          key: "supersededByOccurrenceId",
          kind: "identifier",
          nullable: true,
          reference: { entity: "sourceOccurrence" },
          validation: readOnly(shortcodeSchema("sourceOccurrence").nullable()),
        },
        {
          key: "replacementObservationId",
          kind: "identifier",
          nullable: true,
          reference: { entity: "sourceTransactionRecord" },
          validation: readOnly(
            shortcodeSchema("sourceTransactionRecord").nullable(),
          ),
        },
        {
          key: "withdrawnAt",
          kind: "timestamp",
          nullable: true,
          validation: readOnly(dateTime.nullable()),
        },
        {
          key: "withdrawalImportId",
          kind: "identifier",
          nullable: true,
          reference: { entity: "transactionImport" },
          validation: readOnly(shortcodeSchema("transactionImport").nullable()),
        },
        {
          key: "lastObservedAt",
          kind: "timestamp",
          validation: readOnly(dateTime),
        },
        {
          key: "acceptedTransactionId",
          kind: "identifier",
          nullable: true,
          reference: { entity: "financialTransaction" },
          validation: readOnly(
            shortcodeSchema("financialTransaction").nullable(),
          ),
        },
        {
          key: "reviewState",
          kind: "enum",
          ...enumPresentation(sourceOccurrenceReviewState.options),
          validation: readOnly(sourceOccurrenceReviewState),
        },
        {
          key: "version",
          kind: "number",
          validation: readOnly(z.number().int().positive()),
        },
        {
          key: "identityProof",
          kind: "json",
          output: false,
          validation: readOnly(z.json()),
        },
        {
          key: "closure",
          kind: "json",
          provenance: {
            kind: "relation",
            sources: [
              { label: "Occurrence evidence and accepted financial graph" },
            ],
          },
          display: { list: false },
          validation: readOnly(sourceOccurrenceClosure.optional()),
        },
        timestampField("createdAt"),
        timestampField("updatedAt"),
        {
          key: "deletedAt",
          kind: "timestamp",
          nullable: true,
          output: false,
          validation: readOnly(dateTime.nullable()),
        },
      ],
      storage: [
        { key: "id", specialized: "primary-key:SourceOccurrenceId" },
        { key: "shortcode", specialized: "shortcode" },
        {
          key: "source",
          reference: "externalSource",
          referenceOptions: { column: "slug", onUpdate: "cascade" },
        },
        "identityKind",
        "identityScope",
        "providerIdentity",
        "physicalImportId",
        "physicalPosition",
        "currentObservationId",
        "accountId",
        { key: "disposition", defaultValue: "open" },
        "dispositionReason",
        "dispositionNote",
        "supersededByOccurrenceId",
        "replacementObservationId",
        "withdrawnAt",
        "withdrawalImportId",
        { key: "lastObservedAt", defaultOverride: "now" },
        "acceptedTransactionId",
        { key: "reviewState", defaultValue: "ready" },
        { key: "version", defaultValue: 1 },
        "identityProof",
        "createdAt",
        { key: "updatedAt", specialized: "updated-at" },
        "deletedAt",
      ],
      sort: { fields: ["lastObservedAt", "createdAt", "source"] },
    },
    fields: { create: null, update: null },
    storage: {
      indexes: [
        {
          name: "SourceOccurrence_provider_key",
          unique: true,
          on: ["source", "identityScope", "providerIdentity"],
          where: "{identityKind} = 'provider'",
        },
        {
          name: "SourceOccurrence_position_key",
          unique: true,
          on: ["physicalImportId", "physicalPosition"],
          where: "{identityKind} = 'positioned'",
        },
        {
          name: "SourceOccurrence_account_review_idx",
          on: ["accountId", "reviewState", "lastObservedAt"],
        },
        {
          name: "SourceOccurrence_source_review_idx",
          on: ["source", "reviewState"],
        },
      ],
      foreignKeys: [
        {
          name: "SourceOccurrence_head_membership_fk",
          columns: ["currentObservationId", "id"],
          table: "sourceTransactionRecord",
          references: ["id", "occurrenceId"],
        },
        {
          name: "SourceOccurrence_replacement_membership_fk",
          columns: ["replacementObservationId", "supersededByOccurrenceId"],
          table: "sourceTransactionRecord",
          references: ["id", "occurrenceId"],
        },
      ],
      checks: [
        { column: "identityKind" },
        { column: "reviewState" },
        { column: "disposition" },
        { column: "dispositionReason", nullClause: true },
        {
          name: "SourceOccurrence_identity_check",
          sql: "({identityKind} = 'provider' AND {providerIdentity} IS NOT NULL AND {physicalImportId} IS NULL AND {physicalPosition} IS NULL) OR ({identityKind} = 'positioned' AND {providerIdentity} IS NULL AND {physicalImportId} IS NOT NULL AND {physicalPosition} > 0) OR ({identityKind} = 'reviewed' AND {providerIdentity} IS NULL AND {physicalImportId} IS NULL AND {physicalPosition} IS NULL)",
        },
        { name: "SourceOccurrence_version_check", sql: "{version} > 0" },
        {
          name: "SourceOccurrence_supersession_check",
          sql: "{supersededByOccurrenceId} IS NULL OR {supersededByOccurrenceId} <> {id}",
        },
        {
          name: "SourceOccurrence_disposition_state_check",
          sql: "({disposition} = 'open' AND {dispositionReason} IS NULL AND {dispositionNote} IS NULL) OR ({disposition} = 'ignored' AND {dispositionReason} IS NOT NULL AND {dispositionNote} IS NOT NULL)",
        },
      ],
    },
    capabilities: {
      images: { storage: false },
      delete: null,
      merge: false,
      lifecycle: "readOnly",
      timeline: "default",
    },
    filters: {
      audit: true,
      descriptors: [
        {
          columnId: "source",
          kind: "text",
          deriveSchema: true,
          anyOf: ["source"],
          placeholder: "Filter source...",
        },
        {
          columnId: "reviewState",
          kind: "multiselect",
          deriveSchema: true,
          stored: true,
          placeholder: "Filter source state...",
        },
      ],
    },
    search: false,
    extensions: {
      ports: {
        repository: {
          module:
            "~/server/domains/transaction-import/repo/source-occurrence-read",
          export: "sourceOccurrenceRepository",
        },
      },
    },
  },
  (base) => ({
    output: base,
    list: base,
    // Snapshot bundles are requested through a bounded selected list, never an ordinary get.
    detail: base.omit({ closure: true }),
  }),
);

export default defineEntity(
  definition,
  (r) => [
    r
      .field("physicalImportId")
      .named("physicalImport", "Original physical collection"),
    r
      .field("currentObservationId")
      .named("currentObservation", "Current observation"),
    r.field("accountId").named("account", "Resolved account"),
    r
      .field("supersededByOccurrenceId")
      .named("replacementOccurrence", "Replacement occurrence"),
    r
      .field("replacementObservationId")
      .named("replacementObservation", "Reviewed replacement observation", {
        inverseOmit:
          "The source observation reaches its reserved occurrence; replacement evidence is read on that owner.",
      }),
    r.field("withdrawalImportId").named("withdrawalProof", "Withdrawal proof", {
      inverseOmit:
        "A collection reaches source identities through its original physical relation and observation memberships.",
    }),
    r
      .field("acceptedTransactionId")
      .named("acceptedTransaction", "Accepted transaction"),
  ],
  readSchemas,
);
