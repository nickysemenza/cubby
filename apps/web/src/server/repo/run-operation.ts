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
import { type RunId, runEntityId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";

import type { purchaseImportDebugEvent } from "~/lib/purchase-import-debug";
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

type OperationRow = OperationKey & {
  kind: string;
  inputFingerprint: string;
  state?: OperationState;
  result?: OperationResult;
  error?: string;
  /** The device or agent that performed the operation, when one reported it. */
  executor?: typeof runOperation.$inferInsert.executor;
};

/**
 * Record one or more new operations, `started` unless a state is given. A
 * duplicate key throws, except with `ifAbsent` (`ON CONFLICT DO NOTHING`),
 * which leaves an existing row (another attempt's outcome) untouched. Returns
 * how many rows this call inserted.
 */
export async function insertOperation(
  client: Client,
  rows: OperationRow | OperationRow[],
  options: { ifAbsent?: boolean } = {},
) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return 0;
  const insert = client.insert(runOperation).values(
    list.map((row) => ({
      runId: row.runId,
      operationId: row.operationId,
      kind: row.kind,
      inputFingerprint: row.inputFingerprint,
      state: row.state ?? "started",
      result: row.result,
      error: row.error === undefined ? undefined : boundedError(row.error),
      executor: row.executor,
      completedAt: row.state === "completed" ? new Date() : undefined,
    })),
  );
  const inserted = await (
    options.ifAbsent ? insert.onConflictDoNothing() : insert
  ).returning({ id: runOperation.id });
  return inserted.length;
}

type PurchaseImportDebugEvent = z.output<typeof purchaseImportDebugEvent>;

/** The reserved kind for device diagnostics recorded on a Run's ledger. */
export const DEBUG_EVENT_KIND = "__debug_event";

/**
 * Record device debug events as completed ledger rows keyed by event id, so a
 * re-sent batch is ignored rather than duplicated. Returns how many were new.
 */
export function insertDebugEventOperations(
  client: Client,
  events: readonly PurchaseImportDebugEvent[],
) {
  return insertOperation(
    client,
    events.map((event) => ({
      runId: runEntityId.parse(event.runId),
      operationId: `${DEBUG_EVENT_KIND}:${event.id}`,
      kind: DEBUG_EVENT_KIND,
      inputFingerprint: event.id,
      state: "completed" as const,
      result: event,
      executor: event.executor ?? null,
    })),
    { ifAbsent: true },
  );
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

/**
 * Store the operation's replayable result and mark it `completed`, clearing a
 * previous attempt's error unless `keepError` (a re-dispatched browser command
 * whose recorded terminal failure the broker still holds).
 */
export async function completeOperation(
  client: Client,
  key: OperationKey,
  result: OperationResult,
  options: { keepError?: boolean } = {},
) {
  await client
    .update(runOperation)
    .set({
      state: "completed",
      result,
      error: options.keepError ? undefined : null,
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
