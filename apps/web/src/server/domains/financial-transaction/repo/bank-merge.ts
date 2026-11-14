import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, inArray, isNull } from "drizzle-orm";

import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  financialTransaction,
  financialTransactionAllocation,
  sourceOccurrence,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import type { MergePort } from "~/server/kernel/api";

/** Reviewed duplicate bank events preserve the older identity and every settlement. */
export const mergeBankEvents: MergePort = async (
  db,
  { keepId, loserIds, actor },
) => {
  const q = repositoryQueries(db);
  const ids = [keepId, ...loserIds].map((id) =>
    parseEntityId("financialTransaction", id),
  );
  const rows = await q
    .select()
    .from(financialTransaction)
    .where(inArray(financialTransaction.id, ids));
  const keep = rows.find((row) => row.id === keepId);
  if (
    !keep ||
    rows.length !== ids.length ||
    rows.some(
      (row) =>
        row.deletedAt ||
        row.ledgerTransferId ||
        row.accountId !== keep.accountId ||
        row.amount !== keep.amount ||
        row.kind !== keep.kind,
    )
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Attach requires live transactions with the same account, movement and kind, outside a transfer pair.",
    );
  const allocations = await q
    .select()
    .from(financialTransactionAllocation)
    .where(
      and(
        inArray(financialTransactionAllocation.transactionId, ids),
        isNull(financialTransactionAllocation.deletedAt),
      ),
    );
  const allocated = new Set(allocations.map((row) => row.transactionId));
  if (allocated.size > 1)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Both transactions already hold spending. Reconcile their allocations before attaching this statement.",
    );
  const { repointOwnedReference } = await import("~/server/kernel/api");
  await repointOwnedReference(db, {
    table: financialTransactionAllocation,
    column: "transactionId",
    fromIds: loserIds,
    toId: keep.id,
  });
  const moved = await q
    .update(sourceOccurrence)
    .set({ acceptedTransactionId: keep.id })
    .where(
      inArray(
        sourceOccurrence.acceptedTransactionId,
        loserIds.map((id) => parseEntityId("financialTransaction", id)),
      ),
    )
    .returning({ id: sourceOccurrence.id });
  const { emitWrites } = await import("~/server/kernel/api");
  await emitWrites(db, {
    table: sourceOccurrence,
    ids: moved.map((row) => row.id),
    columns: ["acceptedTransactionId"],
  });
  const { finalizeMerge } = await import("~/server/generic/merge/repo/core");
  const { withTransaction } = await import("~/server/db/helpers/core");
  await withTransaction(db, (tx) =>
    finalizeMerge(tx, {
      entity: "financialTransaction",
      table: financialTransaction,
      keepId: keep.id,
      loserIds: loserIds.map((id) => parseEntityId("financialTransaction", id)),
      removal: "soft",
      actor,
    }),
  );
};
