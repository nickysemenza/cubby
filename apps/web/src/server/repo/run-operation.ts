/**
 * Storage for the RunOperation replay ledger. Every write to the table goes
 * through these primitives; the replay policy (lease, atomic, approval,
 * browser command) stays with its caller (`server/runs/operation.ts` and the
 * owning writers).
 *
 * Identity is frozen for rows already written: the `(runId, operationId)`
 * key, the four states, and a fingerprint each caller computes from its own
 * input. These functions store that fingerprint verbatim; they never
 * canonicalize it and never add `kind` to the identity.
 */
import type { RunId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";

import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import { runOperation } from "~/server/db/schema";

type Client = DrizzleClient | DrizzleTransaction;

export type OperationKey = { runId: RunId; operationId: string };

type OperationState = "started" | "paused_approval" | "completed" | "failed";

/** The JSON a caller replays; its shape is owned by the writing site. */
type OperationResult = typeof runOperation.$inferInsert.result;

const matchesKey = (key: OperationKey) =>
  and(
    eq(runOperation.runId, key.runId),
    eq(runOperation.operationId, key.operationId),
  );

/** A `failed` row keeps a bounded diagnostic. */
const boundedError = (message: string) => message.slice(0, 2_000);

/** The recorded row for `key`; `forUpdate` locks it for the enclosing transaction. */
export async function readOperation(
  client: Client,
  key: OperationKey,
  options: { forUpdate?: boolean } = {},
) {
  const query = client
    .select({
      kind: runOperation.kind,
      state: runOperation.state,
      inputFingerprint: runOperation.inputFingerprint,
      result: runOperation.result,
      error: runOperation.error,
      startedAt: runOperation.startedAt,
      completedAt: runOperation.completedAt,
      updatedAt: runOperation.updatedAt,
    })
    .from(runOperation)
    .where(matchesKey(key))
    .limit(1);
  const [row] = await (options.forUpdate ? query.for("update") : query);
  return row;
}

/**
 * Record a new operation, `started` unless a state is given. A duplicate key
 * throws, except with `ifAbsent`, which leaves the existing row (another
 * attempt's outcome) untouched. Returns whether this call inserted the row.
 */
export async function insertOperation(
  client: Client,
  row: OperationKey & {
    kind: string;
    inputFingerprint: string;
    state?: OperationState;
    result?: OperationResult;
    error?: string;
  },
  options: { ifAbsent?: boolean } = {},
) {
  const insert = client.insert(runOperation).values({
    runId: row.runId,
    operationId: row.operationId,
    kind: row.kind,
    inputFingerprint: row.inputFingerprint,
    state: row.state ?? "started",
    result: row.result,
    error: row.error === undefined ? undefined : boundedError(row.error),
    completedAt: row.state === "completed" ? new Date() : undefined,
  });
  const inserted = await (
    options.ifAbsent ? insert.onConflictDoNothing() : insert
  ).returning({ id: runOperation.id });
  return inserted.length > 0;
}

/**
 * Take over a `failed` or abandoned `started` row for a new attempt. A
 * compare-and-set on the state and fingerprint the caller read, so two
 * deliveries that read the same row cannot both claim it.
 */
export async function reclaimOperation(
  client: Client,
  key: OperationKey,
  input: {
    read: { state: string; inputFingerprint: string };
    inputFingerprint: string;
  },
) {
  const claimed = await client
    .update(runOperation)
    .set({
      state: "started",
      error: null,
      inputFingerprint: input.inputFingerprint,
      updatedAt: new Date(),
    })
    .where(
      and(
        matchesKey(key),
        eq(runOperation.state, input.read.state),
        eq(runOperation.inputFingerprint, input.read.inputFingerprint),
      ),
    )
    .returning({ id: runOperation.id });
  return claimed.length > 0;
}

/** Store the operation's replayable result and mark it `completed`. */
export async function completeOperation(
  client: Client,
  key: OperationKey,
  result: OperationResult,
) {
  await client
    .update(runOperation)
    .set({
      state: "completed",
      result,
      error: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(matchesKey(key));
}

/** Replace the stored result without changing state (an approval decision). */
export async function setOperationResult(
  client: Client,
  key: OperationKey,
  result: OperationResult,
) {
  await client
    .update(runOperation)
    .set({ result, updatedAt: new Date() })
    .where(matchesKey(key));
}

/** Mark the operation `failed` with a bounded diagnostic. */
export async function failOperation(
  client: Client,
  key: OperationKey,
  error: string,
) {
  await client
    .update(runOperation)
    .set({
      state: "failed",
      error: boundedError(error),
      updatedAt: new Date(),
    })
    .where(matchesKey(key));
}

/** Fail every operation of a Run that is still in flight or awaiting approval. */
export async function failOperationsForRun(
  client: Client,
  runId: RunId,
  error: string,
) {
  await client
    .update(runOperation)
    .set({
      state: "failed",
      error: boundedError(error),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runOperation.runId, runId),
        inArray(runOperation.state, ["started", "paused_approval"]),
      ),
    );
}
