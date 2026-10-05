import { runEntityId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";

import type { Database } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";
import {
  completeOperation,
  failOperation,
  insertOperation,
  readOperation,
  reclaimOperation,
} from "~/server/repo/run-operation";

/** A `started` row younger than this belongs to a live attempt. */
const LEASE_MS = 5 * 60_000;

/**
 * The leased replay policy for agent tools whose work runs outside the ledger
 * row's transaction. A completed operation returns its original result even
 * after the run becomes terminal. A concurrent delivery sees `started` and
 * retries later; a `started` row older than the lease is a crashed attempt
 * and is reclaimed. External writers retain their own source claims for the
 * crash window between their commit and this completion write.
 *
 * The fingerprint is `sha256Hex(JSON.stringify(payload))` — the caller's key
 * order is part of the identity of rows already stored.
 */
export async function executeLeasedOperation<T extends object | null>(
  db: Database,
  input: {
    runId: string;
    operationId: string;
    kind: string;
    payload: unknown;
    /**
     * Only for `work` that is a single transaction: a `failed` row holds no
     * partial side effects, so a changed payload may take the operation over.
     */
    retryFailedWithChangedInput?: boolean;
  },
  work: () => Promise<T>,
): Promise<T> {
  const key = {
    runId: runEntityId.parse(input.runId),
    operationId: input.operationId,
  };
  const fingerprint = await sha256Hex(JSON.stringify(input.payload));
  const database = getDb(db);
  const inserted = await insertOperation(
    database,
    { ...key, kind: input.kind, inputFingerprint: fingerprint },
    { ifAbsent: true },
  );
  if (!inserted) {
    const recorded = await readOperation(database, key);
    const takesOverFailed =
      input.retryFailedWithChangedInput === true &&
      recorded?.state === "failed";
    if (
      !recorded ||
      (recorded.inputFingerprint !== fingerprint && !takesOverFailed)
    )
      throw new Error("Operation id was replayed with different input");
    if (recorded.state === "completed") {
      // SAFETY: the unique operation row is written only by this generic call
      // with the same fingerprint, so its completed JSON has work's T shape.
      return recorded.result as T;
    }
    if (
      recorded.state === "started" &&
      Date.now() - recorded.updatedAt.getTime() < LEASE_MS
    )
      throw new Error("Import operation is already in progress");
    if (
      !(await reclaimOperation(database, key, {
        read: recorded,
        inputFingerprint: fingerprint,
      }))
    )
      throw new Error("Import operation is already in progress");
  }
  try {
    const result = await work();
    await completeOperation(database, key, result);
    return result;
  } catch (error) {
    await failOperation(
      database,
      key,
      error instanceof Error ? error.message : "unknown",
    );
    throw error;
  }
}
