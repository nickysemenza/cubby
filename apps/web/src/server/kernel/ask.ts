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
  askState,
  kernelWaitCause,
  MACHINERY_RESPONSE_BYTES,
} from "@cubby/schemas/kernel/machinery";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { UnparsedError } from "~/lib/error-utils";
import { askResponseClaims } from "~/server/ai/response-cache";
import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { answer } from "~/server/db/kernel-schema";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
  type RepositoryQueryClient,
} from "~/server/db/repository-access.boundary";
import { WorkDeferredError } from "~/server/kernel/work-errors";

import type { AskOutcome } from "./ask-gap";
import {
  claimAsks,
  claimAsk,
  claimExternalAskRow,
  rawError,
  renewClaim,
  settleFailure,
  type ClaimedAsk,
} from "./claim";
import type { AskKind, Json, Produced, ScopeRef, EvidenceRow } from "./define";
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
  new WorkDeferredError(
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

/** Every requester retains a durable reference to the Answer, including a replay. */
async function recordAnswerReceipts(q: Q, askId: string, inputHash: string) {
  await q.execute(sql`UPDATE "AskScope" s SET receipt=jsonb_build_object(${"answer"}::text, jsonb_build_object(${"inputHash"}::text, a."inputHash"))
    FROM "Answer" a WHERE s."askId"=${askId}::uuid AND a."inputHash"=${inputHash} AND s.receipt IS NULL`);
}

type AskRow = {
  id: string;
  state: string;
  attempts: number;
  maxAttempts: number;
  lapsed: boolean;
  cancelled: boolean;
  availableAt: string;
  waitCause: string | null;
};

export type AskWaiters = {
  /** A retained host request may have transmitted before kernel ownership existed. */
  initialOutcome?: "unknown";
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
  preferredId?: string,
): Promise<AskRow> {
  const result = await q.execute<AskRow>(sql`
    INSERT INTO "Ask" (id,"inputHash", feature, producer, "promptVersion", input, "maxAttempts",executor, hosted, state)
    VALUES (coalesce(${preferredId ?? null}::uuid,gen_random_uuid()),${inputHash}, ${kind.feature}, ${kind.producer}, ${kind.promptVersion},
      ${JSON.stringify(envelope)}::jsonb, ${kind.maxAttempts},${kind.produce ? null : "external"}, ${kind.hosted ?? false}, ${waiters.initialOutcome === "unknown" ? ASK.unknown : ASK.queued})
    ON CONFLICT ("inputHash") DO UPDATE SET "inputHash" = excluded."inputHash"
    RETURNING id, state, attempts, "maxAttempts", "waitCause", ${isoText(sql`"availableAt"`)} AS "availableAt",
      (state = ${ASK.sent} AND "claimDeadline" <= now()) AS lapsed,
      "cancelledAt" IS NOT NULL AS cancelled`);
  const row = result.rows[0]!;
  const runId = waiters.runId ?? null;
  const scopes = waiters.scopes ?? [];
  const rows = [
    ...scopes.map((scope) => ({ kind: scope.kind, key: scope.key, runId })),
    ...(runId ? [{ kind: RUN_WAITER, key: runId, runId }] : []),
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
  await recordAnswerReceipts(q, row.id, inputHash);
  return row;
}

/** Passes waiting on an ask run as soon as it settles. */
async function wakeWaitingPasses(q: Q, askId: string): Promise<void> {
  await q.execute(sql`
    UPDATE "Pass" p SET "availableAt" = now(), "waitCause" = NULL, "wakeVersion" = p."wakeVersion" + 1
    FROM "AskScope" s
    WHERE s."askId" = ${askId}::uuid AND s."cancelledAt" IS NULL AND s."scopeKind" = ${PASS_WAITER}
      AND s."scopeKey" = p.name || ':' || p.key AND p."doneAt" IS NULL AND p."waitCause" IS DISTINCT FROM ${kernelWaitCause.enum.funding}`);
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
    WHERE "askId" = ${askId}::uuid AND "cancelledAt" IS NULL AND "scopeKind" <> ${RUN_WAITER}`);
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
    await recordAnswerReceipts(q, ask.id, ask.inputHash);
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
  ask: { id: string; token: string },
  error: UnparsedError,
): Promise<void> {
  // Admission failures settle before sent. Once sent, an unclassified failure
  // or malformed response cannot prove that the provider did no paid work.
  await repositoryTransactionDatabase(db, async (tx) => {
    const q = repositoryQueries(tx);
    const changed = await q.execute<{ id: string }>(sql`
      UPDATE "Ask" SET state = ${ASK.unknown}, "claimToken" = NULL, "claimDeadline" = NULL,
        "lastError" = ${rawError(error)}
      WHERE id = ${ask.id}::uuid AND state = ${ASK.sent} AND "claimToken" = ${ask.token}::uuid
      RETURNING id`);
    if (!changed.rows.length) return;
    await markDirty(q, registry, {
      keys: [],
      discovers: await waitingScopes(q, ask.id),
      reason: "ask-unknown",
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
  background = false,
): Promise<AskResult<unknown>[]> {
  const q = repositoryQueries(db);
  const results: AskResult<unknown>[] = entries.map(() => ({
    status: "failed",
    error: new Error("Ask not run"),
  }));
  const ready: { index: number; cacheToken: string }[] = [];
  const requesters = new Map<string, string | null>();
  for (const [index, entry] of entries.entries()) {
    const target = { table: "Ask" as const, id: entry.ask.id };
    try {
      if (!entry.kind.produce)
        throw new Error(`Ask ${entry.kind.feature} declares no producer`);
      const owners = runId
        ? null
        : await q.execute<{ runId: string }>(sql`
        SELECT s."runId" FROM "AskScope" s JOIN "Run" r ON r.id=s."runId"
        WHERE s."askId"=${entry.ask.id}::uuid AND s."cancelledAt" IS NULL
          AND r.status=${"running"} AND r."retiredAt" IS NULL AND ${notDeleted("r")}
        ORDER BY s."createdAt", s."runId" LIMIT 1`);
      const requester = runId ?? owners?.rows[0]?.runId ?? null;
      requesters.set(entry.ask.id, requester);
      await entry.kind.admit?.(db, {
        runId: requester,
        askId: entry.ask.id,
        background,
      });
      const claim = await askResponseClaims.claim(entry.ask.inputHash);
      if (claim.kind === "hit") {
        const replay = storedProduced.parse(JSON.parse(claim.value));
        await commitAnswer(
          db,
          registry,
          entry.kind,
          entry.ask,
          replay,
          requesters.get(entry.ask.id) ?? null,
        );
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
        entry.ask.wakeVersion,
      );
      results[index] = { status: "failed", error };
    }
  }
  if (!ready.length) return results;
  // One statement marks the batch sent before any request leaves.
  const marked = await q.execute<{ id: string }>(sql`
    UPDATE "Ask" a SET state = ${ASK.sent}, "sentAt" = now(), "waitCause" = NULL, executor = NULL
    FROM jsonb_to_recordset(${JSON.stringify(
      ready.map(({ index }) => ({
        id: entries[index]!.ask.id,
        token: entries[index]!.ask.token,
      })),
    )}::jsonb) AS r(id uuid, token uuid)
    WHERE a.id = r.id AND a."claimToken" = r.token AND a.state = ${ASK.queued}
      AND a."claimDeadline" > now() AND a."cancelledAt" IS NULL
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
          ask: {
            id: ask.id,
            inputHash: ask.inputHash,
            promptVersion: kind.promptVersion,
          },
          runId: requesters.get(ask.id) ?? null,
        });
        produced = { ...produced, output: kind.output.parse(produced.output) };
      } catch (error) {
        clearInterval(heartbeat);
        await askResponseClaims
          .release(ask.inputHash, cacheToken)
          // SILENT: an unreleased cache claim lapses on its own lease.
          .catch(() => undefined);
        await settleSent(db, registry, ask, error);
        results[index] = { status: "failed", error };
        return;
      }
      // Store the completed response before attempting database publication. A
      // database failure must never cause another paid request for this hash.
      const cached = await askResponseClaims
        .publish(ask.inputHash, cacheToken, JSON.stringify(produced))
        .catch(() => false);
      try {
        await commitAnswer(
          db,
          registry,
          kind,
          ask,
          produced,
          requesters.get(ask.id) ?? null,
        );
        results[index] = { status: "answered", output: produced.output };
      } catch (error) {
        await q.execute(sql`
          UPDATE "Ask" SET state = ${cached ? ASK.queued : ASK.unknown},
            "sentAt" = CASE WHEN ${cached} THEN NULL ELSE "sentAt" END,
            "claimToken" = NULL, "claimDeadline" = NULL,
            "availableAt" = now() + interval '1 second', "lastError" = ${rawError(error)}
          WHERE id = ${ask.id}::uuid AND "claimToken" = ${ask.token}::uuid`);
        results[index] = { status: "failed", error };
      } finally {
        clearInterval(heartbeat);
      }
    }),
  );
  return results;
}

/**
 * The execution wrapper for a producer call made in line: returns the
 * committed Answer's output, or places the call once under the kernel's
 * claims. Throws a wait (`WorkDeferredError`) while another worker holds the
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
  if (kind.hosted && !options.pass)
    throw new KernelContractError("A hosted Ask must name its waiting Pass");
  const untyped: AskKind = kind;
  const q = repositoryQueries(db);
  const envelope = askEnvelope(untyped, input);
  const inputHash = await inputHashOf(envelope);
  const row = await ensureAsk(q, untyped, envelope, inputHash, options);
  const known = await readAnswerOutput(q, inputHash);
  if (known !== undefined) return kind.output.parse(known);
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
  if (row.waitCause === "funding" && new Date(row.availableAt) > new Date())
    throw new WorkDeferredError(
      "The model Ask waits for funding",
      new Date(row.availableAt),
      "ai_funding_window",
    );
  const claimed = await claimAsk(db, row.id, kind.claimLimit);
  if (!claimed)
    throw inFlight(
      "Another worker holds this ask or its claim partition is full.",
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
          attempts: claimed.attempts,
          wakeVersion: claimed.wakeVersion,
          deadline: claimed.deadline,
          token: claimed.token,
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
  const runnable = [...registry.asks.values()].filter(
    (kind) => kind.produce && !kind.hosted,
  );
  const claimed = await claimAsks(db, runnable, limit);
  if (!claimed.length) return 0;
  const entries: ClaimedEntry[] = [];
  for (const ask of claimed) {
    const kind = registry.asks.get(ask.feature)!;
    const envelope = z
      .object({ input: z.unknown(), promptVersion: z.string() })
      .parse(ask.input);
    if (envelope.promptVersion !== kind.promptVersion) {
      const cached = await askResponseClaims.claim(ask.inputHash);
      if (cached.kind === "hit") {
        await commitAnswer(
          db,
          registry,
          { ...kind, promptVersion: envelope.promptVersion },
          ask,
          storedProduced.parse(JSON.parse(cached.value)),
          null,
        );
        continue;
      }
      if (cached.kind === "claimed")
        await askResponseClaims.release(ask.inputHash, cached.token);
      await repositoryTransactionDatabase(db, async (tx) => {
        const q = repositoryQueries(tx);
        const nextEnvelope = askEnvelope(kind, envelope.input);
        const nextHash = await inputHashOf(nextEnvelope);
        const next = await ensureAsk(q, kind, nextEnvelope, nextHash, {});
        await q.execute(sql`INSERT INTO "AskScope" ("askId", "scopeKind", "scopeKey", "runId", sequence, "cancelledAt")
          SELECT ${next.id}::uuid, "scopeKind", "scopeKey", "runId", sequence, "cancelledAt" FROM "AskScope" WHERE "askId" = ${ask.id}::uuid
          ON CONFLICT DO NOTHING`);
        await q.execute(sql`UPDATE "Ask" SET "cancelledAt" = now(), "claimToken" = NULL, "claimDeadline" = NULL,
          "lastError" = ${`Prompt version changed from ${envelope.promptVersion} to ${kind.promptVersion}; request re-keyed`}
          WHERE id = ${ask.id}::uuid AND "claimToken" = ${ask.token}::uuid`);
      });
      continue;
    }
    entries.push({
      kind,
      input: envelope.input,
      ask: { ...ask, maxAttempts: kind.maxAttempts },
    });
  }
  await executeClaimed(db, registry, entries, null, true);
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
  const lapsed = await repositoryQueries(db).execute<{
    id: string;
    inputHash: string;
    feature: string;
    promptVersion: string;
  }>(sql`
    SELECT id, "inputHash", feature, "promptVersion" FROM "Ask"
    WHERE state = ${ASK.sent} AND "claimDeadline" <= now()`);
  for (const row of lapsed.rows) {
    const kind = registry.asks.get(row.feature);
    if (!kind) continue;
    const cached = await askResponseClaims.claim(row.inputHash);
    if (cached.kind === "hit")
      await commitAnswer(
        db,
        registry,
        { ...kind, promptVersion: row.promptVersion },
        row,
        storedProduced.parse(JSON.parse(cached.value)),
        null,
      );
    else if (cached.kind === "claimed")
      await askResponseClaims.release(row.inputHash, cached.token);
  }
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
          "claimToken" = CASE WHEN a.executor IS NOT NULL THEN a."claimToken" ELSE NULL END, "claimDeadline" = NULL
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

/** Queue an owed answer without running its producer (external executors and passes). */
export async function queueAsk<I, O>(
  db: Database,
  kind: AskKind<I, O>,
  input: I,
  waiters: AskWaiters = {},
  preferredId?: string,
): Promise<string> {
  const envelope = askEnvelope(kind, input);
  return (
    await ensureAsk(
      repositoryQueries(db),
      kind,
      envelope,
      await inputHashOf(envelope),
      waiters,
      preferredId,
    )
  ).id;
}

export type ExternalAskClaim<I> = {
  id: string;
  token: string;
  deadline: Date;
  executor: string;
  input: I;
};

/** Claim external work. Replay-safe executors may replace a lapsed token; paid calls keep unknown outcomes. */
export async function claimExternalAsk<I, O>(
  db: Database,
  kind: AskKind<I, O>,
  options: {
    id: string;
    executor: string;
    leaseMs: number;
    reclaimExpired?: boolean;
  },
): Promise<ExternalAskClaim<I> | null> {
  if (kind.produce)
    throw new KernelContractError(
      "An externally claimed Ask must not have an inline producer",
    );
  if (!options.executor || options.leaseMs <= 0)
    throw new KernelContractError(
      "An external claim needs an executor and positive lease",
    );
  const row = await claimExternalAskRow(db, kind, options);
  if (!row) return null;
  return {
    id: row.id,
    token: row.token,
    executor: options.executor,
    deadline: row.deadline,
    input: kind.input.parse(
      z.object({ input: z.unknown() }).parse(row.input).input,
    ),
  };
}

/** A heartbeat accepts an expired but unchanged device claim, matching late result adoption. */
export async function renewExternalAsk(
  db: Database,
  claim: Pick<ExternalAskClaim<unknown>, "id" | "token" | "executor">,
  leaseMs = 60_000,
): Promise<Date | null> {
  const result = await repositoryQueries(db).execute<{ deadline: string }>(sql`
    UPDATE "Ask" SET state=${ASK.sent}, "claimDeadline"=clock_timestamp()+make_interval(secs=>${leaseMs / 1000})
    WHERE id=${claim.id}::uuid AND "claimToken"=${claim.token}::uuid AND executor=${claim.executor}
      AND state IN (${ASK.sent},${ASK.unknown}) AND "cancelledAt" IS NULL
    RETURNING ${isoText(sql`"claimDeadline"`)} AS deadline`);
  const row = result.rows[0];
  if (!row) return null;
  const deadline = new Date(row.deadline);
  await wakeClaimRecovery(deadline);
  return deadline;
}

/** A device promises it stopped before a result; release spends no attempt. */
export async function releaseExternalAsk(
  db: Database,
  claim: Pick<ExternalAskClaim<unknown>, "id" | "token" | "executor">,
  availableAt?: Date,
): Promise<boolean> {
  const result = await repositoryQueries(db).execute<{ id: string }>(sql`
    UPDATE "Ask" SET state=${ASK.queued}, "sentAt"=NULL, "claimToken"=NULL, "claimDeadline"=NULL,
      "availableAt"=${availableAt ? sql`${availableAt.toISOString()}::timestamp` : sql`now()`}
    WHERE id=${claim.id}::uuid AND "claimToken"=${claim.token}::uuid AND executor=${claim.executor}
      AND state IN (${ASK.sent},${ASK.unknown}) AND "cancelledAt" IS NULL RETURNING id`);
  return result.rows.length > 0;
}

/** Cancellation refuses every later claim and settlement. */
export async function cancelExternalAsk(
  db: Database,
  id: string,
): Promise<void> {
  await repositoryQueries(db).execute(
    sql`UPDATE "Ask" SET "cancelledAt"=coalesce("cancelledAt",now()) WHERE id=${id}::uuid`,
  );
}

/**
 * Settle once, with the Answer and evidence in one transaction. The unchanged
 * claim may report late; a released, cancelled or superseded claim cannot.
 * Source validation runs under the same transaction before any append.
 */
export async function settleExternalAsk<I, O>(
  db: Database,
  registry: KernelRegistry,
  kind: AskKind<I, O>,
  claim: Pick<ExternalAskClaim<I>, "id" | "token" | "executor">,
  produced: Produced<O>,
  options: {
    validate(tx: Database, input: I): Promise<boolean>;
    evidence(tx: Database, output: O): Promise<readonly EvidenceRow[]>;
    runId?: string | null;
  },
): Promise<
  { status: "settled" | "replayed"; output: O } | { status: "refused" }
> {
  return repositoryTransactionDatabase(db, async (tx) => {
    const q = repositoryQueries(tx);
    const result = await q.execute<{
      inputHash: string;
      input: unknown;
      state: string;
      token: string | null;
      executor: string | null;
      cancelled: boolean;
    }>(sql`
      SELECT "inputHash",input,state,"claimToken" AS token,executor,"cancelledAt" IS NOT NULL AS cancelled FROM "Ask" WHERE id=${claim.id}::uuid AND feature=${kind.feature} FOR UPDATE`);
    const row = result.rows[0];
    if (!row) return { status: "refused" };
    const [stored] = await q
      .select()
      .from(answer)
      .where(sql`${answer.inputHash}=${row.inputHash}`);
    if (stored)
      return stored.claimToken === claim.token &&
        stored.executor === claim.executor
        ? { status: "replayed", output: kind.output.parse(stored.output) }
        : { status: "refused" };
    if (
      row.cancelled ||
      row.token !== claim.token ||
      row.executor !== claim.executor ||
      ![askState.enum.sent, askState.enum.unknown].some(
        (state) => state === row.state,
      )
    )
      return { status: "refused" };
    const input = kind.input.parse(
      z.object({ input: z.unknown() }).parse(row.input).input,
    );
    if (!(await options.validate(tx, input))) return { status: "refused" };
    const output = kind.output.parse(produced.output);
    const { append } = await import("./append");
    await append(tx, registry, await options.evidence(tx, output), {
      runId: options.runId,
    });
    await commitAnswer(
      tx,
      registry,
      kind,
      { id: claim.id, inputHash: row.inputHash },
      { ...produced, output },
      options.runId ?? null,
    );
    await q.execute(
      sql`UPDATE "Answer" SET "claimToken"=${claim.token}::uuid,executor=${claim.executor} WHERE "inputHash"=${row.inputHash}`,
    );
    return { status: "settled", output };
  });
}
