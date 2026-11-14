import type { DrizzleTransaction } from "~/server/db";
import { databaseForTransaction } from "~/server/db/helpers";
import { sourceOccurrence } from "~/server/db/schema";
import { emitWrites } from "~/server/kernel/api";

export function dirtySourceOccurrences(
  tx: DrizzleTransaction,
  ids: readonly string[],
): Promise<number> {
  if (!ids.length) return Promise.resolve(0);
  return emitWrites(databaseForTransaction(tx), {
    table: sourceOccurrence,
    ids,
    columns: [
      "currentObservationId",
      "accountId",
      "reviewState",
      "disposition",
      "withdrawnAt",
      "acceptedTransactionId",
      "supersededByOccurrenceId",
    ],
    discovers: ids.map((key) => ({ kind: "bankEvent", key })),
  });
}
