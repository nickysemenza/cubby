import { manualEntry } from "~/server/db/kernel-schema";
import { defineEvidence } from "~/server/kernel/api";

export const manualTransactionEvidence = defineEvidence({
  kind: "manualEntry",
  table: manualEntry,
  keys: (row) => [
    `manual:${row.id}`,
    ...(row.payload &&
    typeof row.payload === "object" &&
    !Array.isArray(row.payload) &&
    typeof row.payload.purchaseEvent === "string"
      ? [`purchaseEvent:${row.payload.purchaseEvent}`]
      : []),
  ],
  discovers: (row) =>
    row.payload &&
    typeof row.payload === "object" &&
    !Array.isArray(row.payload) &&
    typeof row.payload.purchaseEvent === "string"
      ? [{ kind: "purchaseEvent", key: row.payload.purchaseEvent }]
      : [{ kind: "bankEvent", key: `manual:${row.id}` }],
  owner: (row) => row.userId,
});
