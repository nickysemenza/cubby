import { recordScopeKey } from "@cubby/schemas/kernel/capability";
/**
 * Paid producer calls (ADR 0029 section 8). An Ask moves `queued → sent →
 * answered`, or to `unknown`. Funding admission comes first; a refusal, or a
 * failure proven to have sent nothing, leaves the ask `queued` with a wait
 * cause. A batch is marked `sent` in one statement before any request
 * leaves, under the response cache's in-flight claim for each `inputHash`.
 * The `Answer` is committed before a result is returned or applied. A `sent`
 * ask whose claim lapses with no Answer becomes `unknown`, and an `unknown`
 * ask is never sent again automatically.
 */
import {
  kernelJson,
  MACHINERY_RESPONSE_BYTES,
} from "@cubby/schemas/kernel/machinery";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { UnparsedError } from "~/lib/error-utils";
import { askResponseClaims } from "~/server/ai/response-cache";
import type { Database } from "~/server/db/database";
import { answer } from "~/server/db/kernel-schema";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
  type RepositoryQueryClient,
} from "~/server/db/repository-access.boundary";
import { JobDeferredError } from "~/server/generic/jobs/errors";
import { classifyJobFailure } from "~/server/generic/jobs/failure";

import type { AskOutcome } from "./ask-gap";
import {
  backoffMs,
  claimAsks,
  rawError,
  renewClaim,
  settleFailure,
  type ClaimedAsk,
} from "./claim";
import type { AskKind, Json, Produced, ScopeRef } from "./define";
import { markDirty } from "./dirty";
import { askEnvelope, inputHashOf, type AskEnvelope } from "./envelope";
import { answerKey } from "./keys";
import { KernelContractError } from "./reads";
import type { KernelRegistry } from "./registry";
import { isoText } from "./sql-time";
import { ASK, PASS_WAITER, RECORD_WAITER, RUN_WAITER } from "./vocab";
import { wakeAfterCommit, wakeClaimRecovery } from "./wake";

type Q = Pick<RepositoryQueryClient, "execute" | "insert" | "select">;

/** The ask's call went out and its outcome is unknown; a member settles it. */
export class AskUnknownError extends Error {
  override name = "AskUnknownError";
}
/** A member gave up on this answer; it is not produced unless they ask again. */
export class AskAbandonedError extends Error {
  override name = "AskAbandonedError";
}
/** The ask spent its attempts; it stays queued and Stuck until a member retries it. */
export class AskExhaustedError extends Error {
  override name = "AskExhaustedError";
}

const IN_FLIGHT_WAIT_MS = 15_000;
const RENEW_EVERY_MS = 20_000;

const inFlight = (message: string) =>
  new JobDeferredError(
    message,
    new Date(Date.now() + IN_FLIGHT_WAIT_MS),
    "provider_capacity",
  );

const capRaw = (raw: string | null | undefined) => {
  if (!raw) return null;
  const bytes = new TextEncoder().encode(raw);
  return bytes.byteLength <= MACHINERY_RESPONSE_BYTES
    ? raw
    : new TextDecoder().decode(bytes.slice(0, MACHINERY_RESPONSE_BYTES));
};

const storedProduced = z.object({
  output: z.json(),
  model: z.string().nullable().optional(),
  tier: z.string().nullable().optional(),
  costMicros: z.number().nullable().optional(),
});

async function readAnswerOutput(
  q: Q,
  inputHash: string,
): Promise<Json | undefined> {
  const [row] = await q
    .select({ output: answer.output })
    .from(answer)
    .where(sql`${answer.inputHash} = ${inputHash}`);
  return row ? row.output : undefined;
}

type AskRow = {
  id: string;
  state: string;
  attempts: number;
  maxAttempts: number;
  lapsed: boolean;
  cancelled: boolean;
};

export type AskWaiters = {
  scopes?: readonly ScopeRef[];
  runId?: string | null;
  /** A record that shows this ask in its machinery. */
  record?: { entity: string; id: string };
  /** A pass that continues once this ask settles. */
  pass?: { name: string; key: string };
};

/** Upsert the ask and record its waiters; returns its current state. */
async function ensureAsk(
  q: Q,
  kind: AskKind,
  envelope: AskEnvelope,
  inputHash: string,
  waiters: AskWaiters,
): Promise<AskRow> {
  const result = await q.execute<AskRow>(sql`
    INSERT INTO "Ask" ("inputHash", feature, producer, "promptVersion", input, "maxAttempts")
    VALUES (${inputHash}, ${kind.feature}, ${kind.producer}, ${kind.promptVersion},
      ${JSON.stringify(envelope)}::jsonb, ${kind.maxAttempts})
    ON CONFLICT ("inputHash") DO UPDATE SET "inputHash" = excluded."inputHash"
    RETURNING id, state, attempts, "maxAttempts",
      (state = ${ASK.sent} AND "claimDeadline" <= now()) AS lapsed,
      "cancelledAt" IS NOT NULL AS cancelled`);
  const row = result.rows[0]!;
  const runId = waiters.runId ?? null;
  const scopes = waiters.scopes ?? [];
  const rows = [
    ...scopes.map((scope) => ({ kind: scope.kind, key: scope.key, runId })),
    ...(runId && !scopes.length
      ? [{ kind: RUN_WAITER, key: runId, runId }]
      : []),
    ...(waiters.record
      ? [
          {
            kind: RECORD_WAITER,
            key: recordScopeKey(waiters.record.entity, waiters.record.id),
            runId,
          },
        ]
      : []),
    ...(waiters.pass
      ? [
          {
            kind: PASS_WAITER,
            key: `${waiters.pass.name}:${waiters.pass.key}`,
            runId,
          },
        ]
      : []),
  ];
  if (rows.length)
    await q.execute(sql`
      INSERT INTO "AskScope" ("askId", "scopeKind", "scopeKey", "runId")
      SELECT ${row.id}::uuid, w.kind, w.key, w."runId"::uuid
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS w(kind text, key text, "runId" text)
      ON CONFLICT DO NOTHING`);
  return row;
}

/** Passes waiting on an ask run as soon as it settles. */
async function wakeWaitingPasses(q: Q, askId: string): Promise<void> {
  await q.execute(sql`
    UPDATE "Pass" p SET "availableAt" = now()
    FROM "AskScope" s
    WHERE s."askId" = ${askId}::uuid AND s."scopeKind" = ${PASS_WAITER}
      AND s."scopeKey" = p.name || ':' || p.key AND p."doneAt" IS NULL`);
}

/**
 * A member's statement about an ask Cubby cannot settle alone, applied in
 * the decision's transaction: `not_sent` returns an unknown ask to the
 * queue, `retry` re-queues one that failed or was given up, `abandoned`
 * gives up. Waiting scopes rerun and waiting passes run.
 */
export async function settleAskOutcome(
  tx: Database,
  registry: KernelRegistry,
  inputHash: string,
  outcome: AskOutcome,
): Promise<void> {
  const q = repositoryQueries(tx);
  const updated = await q.execute<{ id: string }>(
    outcome === "not_sent"
      ? sql`UPDATE "Ask" SET state = ${ASK.queued}, "sentAt" = NULL, "claimToken" = NULL,
          "claimDeadline" = NULL, "waitCause" = NULL, "availableAt" = now()
        WHERE "inputHash" = ${inputHash} AND state = ${ASK.unknown} AND "cancelledAt" IS NULL
        RETURNING id`
      : outcome === "retry"
        ? sql`UPDATE "Ask" SET state = ${ASK.queued}, attempts = 0, "cancelledAt" = NULL,
            "claimToken" = NULL, "claimDeadline" = NULL, "waitCause" = NULL, "availableAt" = now()
          WHERE "inputHash" = ${inputHash} AND state = ${ASK.queued}
            AND ("cancelledAt" IS NOT NULL OR attempts >= "maxAttempts")
          RETURNING id`
        : sql`UPDATE "Ask" SET "cancelledAt" = coalesce("cancelledAt", now()),
            "claimToken" = NULL, "claimDeadline" = NULL
          WHERE "inputHash" = ${inputHash} AND state IN (${ASK.queued}, ${ASK.unknown})
          RETURNING id`,
  );
  const ask = updated.rows[0];
  if (!ask)
    throw new KernelContractError(
      `The ask ${inputHash} is not in a state that "${outcome}" applies to`,
    );
  await wakeWaitingPasses(q, ask.id);
  await markDirty(q, registry, {
    keys: [answerKey(inputHash)],
    discovers: await waitingScopes(q, ask.id),
    reason: `ask:${outcome}`,
  });
}

/** Scopes waiting on an ask, so its settlement dirties them. */
async function waitingScopes(q: Q, askId: string): Promise<ScopeRef[]> {
  const result = await q.execute<{ kind: string; key: string }>(sql`
    SELECT "scopeKind" AS kind, "scopeKey" AS key FROM "AskScope"
    WHERE "askId" = ${askId}::uuid AND "scopeKind" <> ${RUN_WAITER}`);
  return result.rows;
}

async function commitAnswer(
  db: Database,
  registry: KernelRegistry,
  kind: AskKind,
  ask: { id: string; inputHash: string },
  produced: Produced<unknown>,
  runId: string | null,
): Promise<void> {
  await repositoryTransactionDatabase(db, async (tx) => {
    const q = repositoryQueries(tx);
    await q
      .insert(answer)
      .values({
        inputHash: ask.inputHash,
        feature: kind.feature,
        producer: kind.producer,
        promptVersion: kind.promptVersion,
        output: kernelJson.parse(produced.output),
        model: produced.model ?? null,
        tier: produced.tier ?? null,
        costMicros: produced.costMicros ?? null,
        raw: capRaw(produced.raw),
        askId: ask.id,
        runId,
      })
      .onConflictDoNothing();
    // A late receipt may settle the attempt; applies still fence on their inputs.
    await q.execute(sql`
      UPDATE "Ask" SET state = ${ASK.answered}, "answeredAt" = now(), "claimToken" = NULL,
        "claimDeadline" = NULL, "waitCause" = NULL, "lastError" = NULL
      WHERE id = ${ask.id}::uuid`);
    const dirtied = await markDirty(q, registry, {
      keys: [answerKey(ask.inputHash)],
      discovers: await waitingScopes(q, ask.id),
      reason: `answer:${kind.feature}`,
    });
    await wakeWaitingPasses(q, ask.id);
    if (dirtied) await wakeAfterCommit(tx);
  });
}

/**
 * Settle a call that failed after it was marked `sent`. A wait proves nothing
 * left (funding admission refuses before the request), so the ask is queued
 * again with its cause; a lost connection or lapsed claim leaves the outcome
 * unknown; any other failure was answered by the provider and spends an
 * attempt.
 */
async function settleSent(
  db: Database,
  registry: KernelRegistry,
  ask: { id: string; token: string; attempts: number; maxAttempts: number },
  error: UnparsedError,
  aborted: boolean,
): Promise<void> {
  const failure = classifyJobFailure(error);
  const raw = rawError(error);
  await repositoryTransactionDatabase(db, async (tx) => {
    const q = repositoryQueries(tx);
    const owned = sql`id = ${ask.id}::uuid AND state = ${ASK.sent} AND "claimToken" = ${ask.token}::uuid`;
    let dirties = false;
    if (
      !aborted &&
      (failure.kind === "deferred" || failure.kind === "paused")
    ) {
      const until =
        failure.kind === "deferred"
          ? failure.until
          : new Date(Date.now() + backoffMs(1));
      const cause =
        failure.kind === "deferred" && failure.reason === "ai_funding_window"
          ? "funding"
          : "provider_capacity";
      await q.execute(sql`
        UPDATE "Ask" SET state = ${ASK.queued}, "sentAt" = NULL, "claimToken" = NULL, "claimDeadline" = NULL,
          "availableAt" = ${until.toISOString()}::timestamp, "waitCause" = ${cause}, "lastError" = ${raw}
        WHERE ${owned}`);
    } else if (
      aborted ||
      failure.kind === "transient" ||
      failure.kind === "interrupted"
    ) {
      await q.execute(sql`
        UPDATE "Ask" SET state = ${ASK.unknown}, "claimToken" = NULL, "claimDeadline" = NULL,
          "lastError" = ${raw}
        WHERE ${owned}`);
      dirties = true;
    } else {
      await q.execute(sql`
        UPDATE "Ask" SET state = ${ASK.queued}, "sentAt" = NULL, "claimToken" = NULL, "claimDeadline" = NULL,
          attempts = attempts + 1, "waitCause" = NULL, "lastError" = ${raw},
          "availableAt" = now() + make_interval(secs => ${backoffMs(ask.attempts + 1) / 1000})
        WHERE ${owned}`);
      dirties = ask.attempts + 1 >= ask.maxAttempts;
    }
    if (dirties)
      await markDirty(q, registry, {
        keys: [],
        discovers: await waitingScopes(q, ask.id),
        reason: "ask-stuck",
      });
  });
}

type AskResult<O> =
  | { status: "answered"; output: O }
  | { status: "failed"; error: UnparsedError };

type ClaimedEntry = {
  kind: AskKind;
  input: unknown;
  ask: ClaimedAsk & { maxAttempts: number };
};

/**
 * Run claimed asks: admission, the response cache's in-flight claims, one
 * `sent` statement for the batch, the calls, then each Answer committed.
 */
async function executeClaimed(
  db: Database,
  registry: KernelRegistry,
  entries: readonly ClaimedEntry[],
  runId: string | null,
): Promise<AskResult<unknown>[]> {
  const q = repositoryQueries(db);
  if (entries[0]) await wakeClaimRecovery(entries[0].ask.deadline);
  const results: AskResult<unknown>[] = entries.map(() => ({
    status: "failed",
    error: new Error("Ask not run"),
  }));
  const ready: { index: number; cacheToken: string }[] = [];
  for (const [index, entry] of entries.entries()) {
    const target = { table: "Ask" as const, id: entry.ask.id };
    try {
      if (!entry.kind.produce)
        throw new Error(`Ask ${entry.kind.feature} declares no producer`);
      await entry.kind.admit?.(db);
      const claim = await askResponseClaims.claim(entry.ask.inputHash);
      if (claim.kind === "hit") {
        const replay = storedProduced.parse(JSON.parse(claim.value));
        await commitAnswer(db, registry, entry.kind, entry.ask, replay, runId);
        results[index] = {
          status: "answered",
          output: entry.kind.output.parse(replay.output),
        };
        continue;
      }
      if (claim.kind === "busy")
        throw inFlight(
          "Another request holds this answer's call; no duplicate call was placed.",
        );
      ready.push({ index, cacheToken: claim.token });
    } catch (error) {
      await settleFailure(
        q,
        target,
        entry.ask.token,
        entry.ask.attempts,
        error,
      );
      results[index] = { status: "failed", error };
    }
  }
  if (!ready.length) return results;
  // One statement marks the batch sent before any request leaves.
  const marked = await q.execute<{ id: string }>(sql`
    UPDATE "Ask" a SET state = ${ASK.sent}, "sentAt" = now(), "waitCause" = NULL
    FROM jsonb_to_recordset(${JSON.stringify(
      ready.map(({ index }) => ({
        id: entries[index]!.ask.id,
        token: entries[index]!.ask.token,
      })),
    )}::jsonb) AS r(id uuid, token uuid)
    WHERE a.id = r.id AND a."claimToken" = r.token AND a.state = ${ASK.queued}
      AND a."claimDeadline" > now()
    RETURNING a.id`);
  const sent = new Set(marked.rows.map((row) => row.id));
  await Promise.all(
    ready.map(async ({ index, cacheToken }) => {
      const entry = entries[index]!;
      const { ask, kind } = entry;
      if (!sent.has(ask.id)) {
        await askResponseClaims.release(ask.inputHash, cacheToken);
        results[index] = {
          status: "failed",
          error: inFlight("The ask's claim lapsed before it was sent."),
        };
        return;
      }
      const controller = new AbortController();
      const heartbeat = setInterval(() => {
        void Promise.all([
          renewClaim(q, { table: "Ask", id: ask.id }, ask.token),
          askResponseClaims.renew(ask.inputHash, cacheToken),
        ])
          .then(([held, cached]) => {
            if (!held || !cached) controller.abort();
          })
          .catch(() => {
            // SILENT: a failed renewal lets the claim lapse; expiry settles it.
          });
      }, RENEW_EVERY_MS);
      let produced: Produced<unknown>;
      try {
        produced = await kind.produce!(entry.input, {
          db,
          signal: controller.signal,
          ask: { id: ask.id, inputHash: ask.inputHash },
          runId,
        });
        produced = { ...produced, output: kind.output.parse(produced.output) };
      } catch (error) {
        clearInterval(heartbeat);
        await askResponseClaims
          .release(ask.inputHash, cacheToken)
          // SILENT: an unreleased cache claim lapses on its own lease.
          .catch(() => undefined);
        await settleSent(
          db,
          registry,
          { ...ask, maxAttempts: ask.maxAttempts },
          error,
          controller.signal.aborted,
        );
        results[index] = { status: "failed", error };
        return;
      }
      clearInterval(heartbeat);
      await commitAnswer(db, registry, kind, ask, produced, runId);
      await askResponseClaims
        .publish(ask.inputHash, cacheToken, JSON.stringify(produced))
        // SILENT: the replay copy is rebuildable from the committed Answer.
        .catch(() => undefined);
      results[index] = { status: "answered", output: produced.output };
    }),
  );
  return results;
}

/**
 * The execution wrapper for a producer call made in line: returns the
 * committed Answer's output, or places the call once under the kernel's
 * claims. Throws a wait (`JobDeferredError`) while another worker holds the
 * call or funding refuses it, and {@link AskUnknownError} for an ask whose
 * outcome is unknown.
 */
export async function withAsk<I, O>(
  db: Database,
  registry: KernelRegistry,
  kind: AskKind<I, O>,
  input: I,
  options: AskWaiters = {},
): Promise<O> {
  const untyped: AskKind = kind;
  const q = repositoryQueries(db);
  const envelope = askEnvelope(untyped, input);
  const inputHash = await inputHashOf(envelope);
  const known = await readAnswerOutput(q, inputHash);
  if (known !== undefined) return kind.output.parse(known);
  const row = await ensureAsk(q, untyped, envelope, inputHash, options);
  if (row.cancelled)
    throw new AskAbandonedError(
      `A member gave up on the ${kind.feature} answer for ${inputHash}.`,
    );
  if (row.state === "answered") {
    const settled = await readAnswerOutput(q, inputHash);
    if (settled !== undefined) return kind.output.parse(settled);
  }
  if (row.state === "sent" && row.lapsed) await expireAsks(db, registry);
  if (row.state === "unknown" || (row.state === "sent" && row.lapsed))
    throw new AskUnknownError(
      `The ${kind.feature} call for ${inputHash} went out and its outcome is unknown; it is not sent again automatically.`,
    );
  if (row.state === "sent")
    throw inFlight(
      "Another worker is placing this call; no duplicate call was placed.",
    );
  if (row.attempts >= row.maxAttempts)
    throw new AskExhaustedError(
      `The ${kind.feature} call for ${inputHash} spent its ${row.maxAttempts} attempts.`,
    );
  const token = crypto.randomUUID();
  const claimed = await q.execute<{ attempts: number; deadline: string }>(sql`
    UPDATE "Ask" SET "claimToken" = ${token}::uuid,
      "claimDeadline" = now() + make_interval(secs => 90)
    WHERE id = ${row.id}::uuid AND state = ${ASK.queued} AND "cancelledAt" IS NULL
      AND ("claimToken" IS NULL OR "claimDeadline" <= now())
    RETURNING attempts, ${isoText(sql`"claimDeadline"`)} AS deadline`);
  if (!claimed.rows[0])
    throw inFlight(
      "Another worker holds this ask's claim; no duplicate call was placed.",
    );
  const [result] = await executeClaimed(
    db,
    registry,
    [
      {
        kind: untyped,
        input: envelope.input,
        ask: {
          id: row.id,
          inputHash,
          feature: kind.feature,
          input: envelope,
          attempts: claimed.rows[0].attempts,
          deadline: new Date(claimed.rows[0].deadline),
          token,
          maxAttempts: row.maxAttempts,
        },
      },
    ],
    options.runId ?? null,
  );
  if (result!.status === "answered") return kind.output.parse(result!.output);
  throw result!.error;
}

/** Queued asks with a waiting scope, run by the background runner. */
export async function runQueuedAsks(
  db: Database,
  registry: KernelRegistry,
  limit: number,
): Promise<number> {
  const runnable = [...registry.asks.values()].filter((kind) => kind.produce);
  const claimed = await claimAsks(
    repositoryQueries(db),
    runnable.map((kind) => kind.feature),
    limit,
  );
  if (!claimed.length) return 0;
  const entries = claimed.map((ask) => {
    const kind = registry.asks.get(ask.feature)!;
    const envelope = z.object({ input: z.unknown() }).parse(ask.input);
    return {
      kind,
      input: envelope.input,
      ask: { ...ask, maxAttempts: kind.maxAttempts },
    };
  });
  await executeClaimed(db, registry, entries, null);
  return claimed.length;
}

/**
 * Claim expiry for asks: a `sent` ask whose claim lapsed becomes `answered`
 * when its Answer committed, otherwise `unknown`; its waiting scopes rerun.
 */
export async function expireAsks(
  db: Database,
  registry: KernelRegistry,
): Promise<number> {
  return repositoryTransactionDatabase(db, async (tx) => {
    const q = repositoryQueries(tx);
    const result = await q.execute<{
      kind: string;
      key: string;
      id: string;
    }>(sql`
      WITH lapsed AS (
        UPDATE "Ask" a SET
          state = CASE WHEN EXISTS (SELECT 1 FROM "Answer" WHERE "inputHash" = a."inputHash")
            THEN ${ASK.answered} ELSE ${ASK.unknown} END,
          "claimToken" = NULL, "claimDeadline" = NULL
        WHERE a.state = ${ASK.sent} AND a."claimDeadline" <= now()
        RETURNING a.id
      )
      SELECT lapsed.id, s."scopeKind" AS kind, s."scopeKey" AS key
      FROM lapsed LEFT JOIN "AskScope" s ON s."askId" = lapsed.id AND s."scopeKind" <> ${RUN_WAITER}`);
    const scopes = result.rows.filter((row) => row.kind !== null);
    if (scopes.length)
      await markDirty(q, registry, {
        keys: [],
        discovers: scopes.map((row) => ({ kind: row.kind, key: row.key })),
        reason: "ask-expired",
      });
    return new Set(result.rows.map((row) => row.id)).size;
  });
}
