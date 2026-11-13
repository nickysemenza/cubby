import { sourceOccurrence, sourceTransactionRecord } from "~/server/db/schema";
import { defineEvidence, rowKey } from "~/server/kernel/api";

export const occurrenceEvidence = defineEvidence({
  kind: "sourceOccurrence",
  table: sourceOccurrence,
  entity: "sourceOccurrence",
  keys: (row) => [rowKey("SourceOccurrence", row.id), `occurrence:${row.id}`],
  discovers: (row) => [{ kind: "bankEvent", key: row.id }],
});

export const statementEvidence = defineEvidence({
  kind: "statementObservation",
  table: sourceTransactionRecord,
  entity: "sourceTransactionRecord",
  keys: (row) => [
    rowKey("SourceTransactionRecord", row.id),
    `occurrence:${row.occurrenceId}`,
  ],
  discovers: (row) => [{ kind: "bankEvent", key: row.occurrenceId }],
});
