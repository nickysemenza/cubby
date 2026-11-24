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
import type { DecisionActorKind } from "@cubby/schemas/kernel/stage";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { UnparsedError } from "~/lib/error-utils";
import { askResponseClaims } from "~/server/ai/response-cache";
import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { answer } from "~/server/db/kernel-schema";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
  type RepositoryQueryClient,
} from "~/server/db/repository-access.boundary";
import { findPgError } from "~/server/errors/db-errors";
import {
  WorkDeferredError,
  WorkEvidenceObsoleteError,
  WorkRetryableError,
} from "~/server/kernel/work-errors";

import type { AskOutcome } from "./ask-gap";
import {
  claimAsks,
  claimAsk,
  claimExternalAskRow,
  rawError,
  runnerAskKinds,
  renewClaim,
  settleFailure,
  type ClaimedAsk,
} from "./claim";
import type { AskKind, Json, Produced, ScopeRef, EvidenceRow } from "./define";
import { markDirty } from "./dirty";
import { askEnvelope, inputHashOf, type AskEnvelope } from "./envelope";
import { enterHouseholdGate } from "./gate";
import { answerKey } from "./keys";
import { runProduce } from "./produce-ledger";
import { KernelContractError } from "./reads";
import type { KernelRegistry } from "./registry";
import { isoText } from "./sql-time";
import { ASK, PASS_WAITER, RECORD_WAITER, RUN_WAITER } from "./vocab";
import { wakeAfterCommit, wakeAtDeadline, wakeClaimRecovery } from "./wake";

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

/** Read an immutable Answer without claiming work or invoking its producer. */
export async function readAskAnswer<I, O>(
  db: Database,
  kind: AskKind<I, O>,
  input: I,
): Promise<O | undefined> {
  const envelope = askEnvelope(kind, input);
  const output = await readAnswerOutput(
    repositoryQueries(db),
    await inputHashOf(envelope),
  );
  return output === undefined ? undefined : kind.output.parse(output);
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

/**
 * Whether filing this Ask with these waiters can leave a row the background
 * runner claims (`runnerAsk`): its producer runs here and someone waits.
 */
const runnerOwned = (kind: AskKind, waiters: AskWaiters): boolean =>
  !!kind.produce &&
  !kind.hosted &&
  !!(waiters.scopes?.length || waiters.runId || waiters.record || waiters.pass);

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

/** Passes waiting on an ask run as soon as it settles; returns how many became due. */
async function wakeWaitingPasses(q: Q, askId: string): Promise<number> {
  const woken = await q.execute<{ woken: number }>(sql`
    UPDATE "Pass" p SET "availableAt" = now(), "waitCause" = NULL, "wakeVersion" = p."wakeVersion" + 1
    FROM "AskScope" s
    WHERE s."askId" = ${askId}::uuid AND s."cancelledAt" IS NULL AND s."scopeKind" = ${PASS_WAITER}
      AND s."scopeKey" = p.name || ':' || p.key AND p."doneAt" IS NULL AND p."waitCause" IS DISTINCT FROM ${kernelWaitCause.enum.funding}
    RETURNING 1 AS woken`);
  return woken.rows.length;
}

/**
 * A member's statement about an ask Cubby cannot settle alone, applied in
 * the decision's transaction: `retry` accepts a possible repeat charge for an
 * unknown call or re-queues one that failed or was given up; `abandoned` gives
 * up. Waiting scopes rerun and waiting passes run.
 */
export async function settleAskOutcome(
  tx: Database,
  registry: KernelRegistry,
  inputHash: string,
  outcome: AskOutcome,
  actor: DecisionActorKind,
): Promise<void> {
  const q = repositoryQueries(tx);
  const updated = await q.execute<{ id: string }>(
    outcome === "retry"
      ? sql`UPDATE "Ask" SET state = ${ASK.queued}, attempts = 0, "cancelledAt" = NULL, "sentAt" = NULL,
            "claimToken" = NULL, "claimDeadline" = NULL, "waitCause" = NULL, "availableAt" = now()
          WHERE "inputHash" = ${inputHash}
            AND ((state = ${ASK.unknown} AND ${actor === "member"}) OR (state = ${ASK.queued}
              AND ("cancelledAt" IS NOT NULL OR attempts >= "maxAttempts")))
            AND NOT coalesce("claimDeadline" > now(), false)
          RETURNING id`
      : sql`UPDATE "Ask" SET "cancelledAt" = coalesce("cancelledAt", now()),
            "claimToken" = NULL, "claimDeadline" = NULL
          WHERE "inputHash" = ${inputHash} AND state IN (${ASK.queued}, ${ASK.unknown})
          RETURNING id`,
  );
  const ask = updated.rows[0];
  if (!ask)
    throw new KernelContractError(
      `The ask ${inputHash} is not in a state that "${outcome}" applies to.${outcome === "retry" && actor !== "member" ? " A member must choose whether to retry an unknown call; it may charge again." : ""}`,
    );
  const passes = await wakeWaitingPasses(q, ask.id);
  const dirtied = await markDirty(q, registry, {
    keys: [answerKey(inputHash)],
    discovers: await waitingScopes(q, ask.id),
    reason: `ask:${outcome}`,
  });
  if (passes || dirtied || outcome === "retry") await wakeAfterCommit(tx);
}

/** Scopes waiting on an ask, so its settlement dirties them. */
async function waitingScopes(q: Q, askId: string): Promise<ScopeRef[]> {
  const result = await q.execute<{ kind: string; key: string }>(sql`
    SELECT "scopeKind" AS kind, "scopeKey" AS key FROM "AskScope"
    WHERE "askId" = ${askId}::uuid AND "cancelledAt" IS NULL AND "scopeKind" <> ${RUN_WAITER}`);
  return result.rows;
}

/** Errors {@link commitAnswer} met entering the gate: a lock wait that gave up (55P03). */
const gateRefusals = new WeakSet<object>();
const gateRefused = (error: unknown) =>
  error instanceof Object && gateRefusals.has(error);

async function commitAnswer(
  db: Database,
  registry: KernelRegistry,
  kind: AskKind,
  ask: { id: string; inputHash: string },
  produced: Produced<unknown>,
  runId: string | null,
  holder?: string,
): Promise<boolean> {
  return repositoryTransactionDatabase(db, async (tx) => {
    try {
      await enterHouseholdGate(tx);
    } catch (error) {
      // Marked, not wrapped: every caller still observes the error it threw.
      if (error instanceof Object && findPgError(error)?.code === "55P03")
        gateRefusals.add(error);
      throw error;
    }
    const q = repositoryQueries(tx);
    // A retry publishes only for the caller that still holds a live claim on
    // an Ask nobody cancelled while it waited; the row lock follows the gate.
    if (holder) {
      const held = await q.execute<{ held: number }>(sql`
        SELECT 1 AS held FROM "Ask" WHERE id = ${ask.id}::uuid AND "claimToken" = ${holder}::uuid
          AND "claimDeadline" > now() AND "cancelledAt" IS NULL FOR UPDATE`);
      if (!held.rows.length) return false;
    }
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
    const passes = await wakeWaitingPasses(q, ask.id);
    if (dirtied || passes) await wakeAfterCommit(tx);
    return true;
  });
}

/** A hosted turn's publication budget, far inside its request's lifetime. */
const HOSTED_PUBLISH_BUDGET_MS = 20_000;
/** The member lock wait a publication's gate entry may take. */
const GATE_LOCK_WAIT_MS = 2_000;

/**
 * Publish a response already in hand. The in-line host of a hosted Ask retries
 * a publication only the household gate refused, each try a fresh transaction
 * that takes the gate first, never calling the provider again. It renews its
 * claim as soon as a try is refused, before waiting, and each retry checks
 * that claim again under the gate. It stops on a renewal that fails, a claim
 * that moved, or when the budget runs out, rethrowing the first refusal so
 * the caller settles it as any failed publication. Every other publication
 * is tried once.
 */
async function publishAnswer(
  db: Database,
  registry: KernelRegistry,
  kind: AskKind,
  ask: { id: string; inputHash: string; token: string },
  produced: Produced<unknown>,
  runId: string | null,
): Promise<void> {
  const deadline = Date.now() + HOSTED_PUBLISH_BUDGET_MS;
  let refused: unknown;
  for (let delay = 250; ; delay = Math.min(delay * 2, 4_000)) {
    try {
      // The first try is the one every publication makes. A retry also checks
      // its claim under the gate and publishes nothing once it is lost.
      const published = await commitAnswer(
        db,
        registry,
        kind,
        ask,
        produced,
        runId,
        refused === undefined ? undefined : ask.token,
      );
      if (published) return;
      throw refused;
    } catch (error) {
      if (refused !== undefined && error === refused) throw error;
      refused ??= error;
      if (!kind.hosted || !gateRefused(error)) throw error;
      // The whole of the next try, lock wait included, stays inside the budget.
      if (Date.now() + delay + GATE_LOCK_WAIT_MS >= deadline) throw refused;
      // Renew before waiting, at the moment the caller would otherwise settle
      // the failure: a claim about to lapse must not lapse during the wait,
      // where expiry would settle a held response as unknown.
      const renewed = await renewClaim(
        repositoryQueries(db),
        { table: "Ask", id: ask.id },
        ask.token,
      ).catch(() => false);
      if (!renewed) throw refused;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Settle a call that failed after it was marked `sent`. A failure the produce
 * ledger proves unsent (a declared refusal and no request on the wire) is
 * queued again and settled by the claim classifier with its refusal, so a
 * wait keeps its cause and spends no attempt. An input found stale spends
 * none either: its waiting scopes re-derive and drop it, or ask it again
 * after a backoff when their inputs return to it. Anything else, including a
 * malformed response or a provider error after a request left, cannot prove
 * that the provider did no paid work and becomes `unknown`.
 */
async function settleSent(
  db: Database,
  registry: KernelRegistry,
  ask: ClaimedAsk,
  error: UnparsedError,
  unsent: UnparsedError | null,
): Promise<void> {
  await repositoryTransactionDatabase(db, async (tx) => {
    const q = repositoryQueries(tx);
    if (unsent) {
      const requeued = await q.execute<{ id: string }>(sql`
        UPDATE "Ask" SET state = ${ASK.queued}, "sentAt" = NULL
        WHERE id = ${ask.id}::uuid AND state = ${ASK.sent} AND "claimToken" = ${ask.token}::uuid
        RETURNING id`);
      if (!requeued.rows.length) return;
      const stale = unsent instanceof WorkEvidenceObsoleteError;
      await settleFailure(
        q,
        { table: "Ask", id: ask.id },
        ask.token,
        ask.attempts,
        stale
          ? new WorkRetryableError(unsent.message, { cause: unsent })
          : unsent,
        ask.wakeVersion,
      );
      if (
        stale &&
        (await markDirty(q, registry, {
          keys: [],
          discovers: await waitingScopes(q, ask.id),
          reason: "ask-stale-input",
        }))
      )
        await wakeAfterCommit(tx);
      return;
    }
    const changed = await q.execute<{ id: string }>(sql`
      UPDATE "Ask" SET state = ${ASK.unknown}, "claimToken" = NULL, "claimDeadline" = NULL,
        "lastError" = ${rawError(error)}
      WHERE id = ${ask.id}::uuid AND state = ${ASK.sent} AND "claimToken" = ${ask.token}::uuid
      RETURNING id`);
    if (!changed.rows.length) return;
    if (
      await markDirty(q, registry, {
        keys: [],
        discovers: await waitingScopes(q, ask.id),
        reason: "ask-unknown",
      })
    )
      await wakeAfterCommit(tx);
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
        await publishAnswer(
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
      const outcome = await runProduce(() =>
        kind.produce!(entry.input, {
          db,
          signal: controller.signal,
          ask: {
            id: ask.id,
            inputHash: ask.inputHash,
            promptVersion: kind.promptVersion,
          },
          runId: requesters.get(ask.id) ?? null,
        }),
      );
      let produced: Produced<unknown>;
      try {
        if (outcome.status === "failed") throw outcome.error;
        produced = {
          ...outcome.value,
          output: kind.output.parse(outcome.value.output),
          costMicros:
            outcome.value.costMicros === undefined
              ? outcome.costMicros
              : outcome.value.costMicros,
        };
      } catch (error) {
        clearInterval(heartbeat);
        await askResponseClaims
          .release(ask.inputHash, cacheToken)
          // SILENT: an unreleased cache claim lapses on its own lease.
          .catch(() => undefined);
        await settleSent(
          db,
          registry,
          ask,
          error,
          outcome.status === "failed" ? outcome.unsent : null,
        );
        results[index] = { status: "failed", error };
        return;
      }
      // Store the completed response before attempting database publication. A
      // database failure must never cause another paid request for this hash.
      const cached = await askResponseClaims
        .publish(ask.inputHash, cacheToken, JSON.stringify(produced))
        .catch(() => false);
      try {
        await publishAnswer(
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
        if (cached)
          await wakeAtDeadline(
            db,
            new Date(Date.now() + 1_000),
            "kernel.ask-requeue",
          );
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
  let row: AskRow;
  let claimed: NonNullable<Awaited<ReturnType<typeof claimAsk>>>;
  try {
    row = await ensureAsk(q, untyped, envelope, inputHash, options);
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
    const held = await claimAsk(db, row.id, kind.claimLimit);
    if (!held)
      throw inFlight(
        new Date(row.availableAt) > new Date()
          ? `The ${kind.feature} call waits until ${row.availableAt}${row.waitCause ? ` for ${row.waitCause}` : " before its next try"}; no call was placed.`
          : `Another request holds this ask${kind.claimLimit ? " or its claim partition is full" : ""}; no duplicate call was placed.`,
      );
    claimed = held;
  } catch (error) {
    // On a pool handle `ensureAsk` may already have committed a queued Ask
    // and its waiter, which the runner claims; a failure before this call's
    // own claim leaves it to the runner.
    if (runnerOwned(untyped, options)) await wakeAfterCommit(db);
    throw error;
  }
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
  const claimed = await claimAsks(db, runnerAskKinds(registry), limit);
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
        await q.execute(sql`INSERT INTO "AskScope" ("askId", "scopeKind", "scopeKey", "runId", receipt, sequence, "cancelledAt")
          SELECT ${next.id}::uuid, "scopeKind", "scopeKey", "runId", receipt, sequence, "cancelledAt" FROM "AskScope" WHERE "askId" = ${ask.id}::uuid
          ON CONFLICT ("askId", "scopeKind", "scopeKey") DO UPDATE
          SET "runId" = excluded."runId", receipt = excluded.receipt,
            sequence = excluded.sequence, "cancelledAt" = excluded."cancelledAt"
          WHERE coalesce(excluded.sequence, 0) > coalesce("AskScope".sequence, 0)`);
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
    if (
      scopes.length &&
      (await markDirty(q, registry, {
        keys: [],
        discovers: scopes.map((row) => ({ kind: row.kind, key: row.key })),
        reason: "ask-expired",
      }))
    )
      await wakeAfterCommit(tx);
    return new Set(result.rows.map((row) => row.id)).size;
  });
}

/**
 * Queue an owed answer without running its producer (external executors and
 * passes). An Ask the runner produces wakes it after commit.
 */
export async function queueAsk<I, O>(
  db: Database,
  kind: AskKind<I, O>,
  input: I,
  waiters: AskWaiters = {},
  preferredId?: string,
): Promise<string> {
  const envelope = askEnvelope(kind, input);
  const inputHash = await inputHashOf(envelope);
  try {
    return (
      await ensureAsk(
        repositoryQueries(db),
        kind,
        envelope,
        inputHash,
        waiters,
        preferredId,
      )
    ).id;
  } finally {
    // Its waiter may commit before a later statement fails.
    if (runnerOwned(kind, waiters)) await wakeAfterCommit(db);
  }
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
  await wakeClaimRecovery(deadline, db);
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

/**
 * Make released external Asks claimable now: a deferral their executor set
 * ends early because what it waited for arrived. Funding waits keep their
 * deadline. The caller owns the commit wake.
 */
export async function bringExternalAsksForward(
  db: Database,
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  await repositoryQueries(db).execute(sql`
    UPDATE "Ask" SET "availableAt" = now()
    WHERE id = ANY(${uuidArrayParam(ids)}) AND state = ${ASK.queued} AND "claimToken" IS NULL
      AND "cancelledAt" IS NULL AND "availableAt" > now()
      AND "waitCause" IS DISTINCT FROM ${kernelWaitCause.enum.funding}`);
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
    // The gate precedes the Ask row: commitAnswer and batch filing take the
    // gate before they touch Ask rows.
    await enterHouseholdGate(tx);
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
