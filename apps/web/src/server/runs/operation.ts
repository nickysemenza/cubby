import { type RunId, runEntityId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import type { z } from "zod";

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

type LedgerClient = Parameters<typeof readOperation>[0];
type RecordedResult = Parameters<typeof completeOperation>[2];

/** How an atomic operation's work records itself inside its own transaction. */
export type AtomicOperationLedger = {
  /**
   * The recorded result, parsed by the site's output schema, when this
   * operation id already ran; else `undefined`. A different fingerprint is a
   * conflict, and a row that never completed (a `failed` commit) is
   * uncertain: neither is retried.
   */
  replay<R>(
    client: LedgerClient,
    schema: z.ZodType<R>,
    options?: { forUpdate?: boolean },
  ): Promise<R | undefined>;
  /** Claim the operation `started` ahead of the business writes that follow. */
  start(client: LedgerClient): Promise<void>;
  /** Record the replayable result: completes a started row, else inserts it completed. */
  complete(client: LedgerClient, result: RecordedResult): Promise<void>;
};

/**
 * The atomic replay policy for writers whose ledger row commits or rolls back
 * with their business writes: purchase prepare and commit. A completed operation
 * replays its recorded result; any other row under the id throws, because an
 * attempt that did not complete has an unknown outcome.
 *
 * Each site keeps its own transaction, lock order, and the points where it
 * calls `replay`, `start`, and `complete`. The fingerprint is
 * `sha256Hex(JSON.stringify(payload))`: the object each site passes, and its
 * key order, are the identity of rows already stored. With `recordFailure`,
 * an error after rollback (which took the transaction's own row with it) is
 * recorded `failed` on a fresh connection, never over another attempt's row.
 */
export async function executeAtomicOperation<T>(
  db: Database,
  operation: {
    runId: RunId;
    operationId: string;
    kind: string;
    payload: unknown;
    /** Names the operation in the uncertain-outcome error ("Commit"). */
    subject: string;
    recordFailure?: boolean;
    /** Retain a rejected research proposal outside its rolled-back transaction. */
    retainAttempt?: boolean;
  },
  work: (ledger: AtomicOperationLedger) => Promise<T>,
): Promise<T> {
  const key = { runId: operation.runId, operationId: operation.operationId };
  const row = {
    ...key,
    kind: operation.kind,
    inputFingerprint: await sha256Hex(JSON.stringify(operation.payload)),
  };
  let started = false;
  const ledger: AtomicOperationLedger = {
    async replay(client, schema, options) {
      const recorded = await readOperation(client, key, options);
      if (!recorded) return undefined;
      if (recorded.inputFingerprint !== row.inputFingerprint)
        throw new Error("Operation id was replayed with different input");
      if (recorded.state !== "completed")
        throw new Error(
          `${operation.subject} outcome is uncertain; inspect operation status`,
        );
      return schema.parse(recorded.result);
    },
    async start(client) {
      await insertOperation(client, row);
      started = true;
    },
    async complete(client, result) {
      if (started) await completeOperation(client, key, result);
      else
        await insertOperation(client, { ...row, state: "completed", result });
    },
  };
  if (!operation.recordFailure) return work(ledger);
  try {
    return await work(ledger);
  } catch (error) {
    await insertOperation(
      getDb(db),
      {
        ...row,
        state: "failed",
        error: error instanceof Error ? error.message : "unknown",
        result: operation.retainAttempt
          ? { attempt: operation.payload }
          : undefined,
      },
      { ifAbsent: true },
    );
    throw error;
  }
}
