import { manualEntry } from "~/server/db/kernel-schema";
import { defineEvidence } from "~/server/kernel/api";

export const manualTransactionEvidence = defineEvidence({
  kind: "manualEntry",
  table: manualEntry,
  keys: (row) => [`manual:${row.id}`],
  discovers: (row) => [{ kind: "bankEvent", key: `manual:${row.id}` }],
  owner: (row) => row.userId,
});
