import { suggestionStatus } from "@cubby/schemas/ai";
import type {
  AssessmentFamily,
  AssessmentProducer,
} from "@cubby/schemas/assessment";
import { createLogger } from "@cubby/worker-tracing";
import { and, asc, count, eq, inArray, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { forEachConcurrently } from "~/lib/concurrency-limiter";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { assessmentState } from "~/server/db/schema";
import { publishAssessments } from "~/server/generic/assessment/repo/assessment";
import { transitionAssessmentStates } from "~/server/generic/assessment/repo/assessment-state";
import {
  assertWorkflowEffect,
  isWorkflowInterrupted,
} from "~/server/workflows/runs/execution";

const log = createLogger("suggestion-publication");

const suggestionData = z.record(z.string(), z.json());

/** Candidates one publication transaction admits together. */
const SUGGESTION_BATCH = 32;

/** One locked AssessmentState row of a slot, newest first. */
export type SuggestionRow = {
  id: string;
  status: string;
  active: boolean;
  fingerprint: string | null;
  evidenceFingerprint: string | null;
  suppression: unknown;
  createdAt: string;
  data: z.infer<typeof suggestionData>;
  producer: unknown;
  judgment: unknown;
};

/**
 * The rows one subject's Suggestions occupy: an advisory lock key every
 * publisher of the subject takes, and the `data` text fields that select its
 * AssessmentState history. Every slot of a family names the same fields.
 */
type SuggestionSlot = {
  lock: string;
  fields: Readonly<Record<string, string>>;
};

type Publication = Parameters<typeof publishAssessments>[1][number];

/** A family check after suppression and before the unchanged match. */
type SuggestionPrecheck<Reason extends string> =
  /** Terminal; the family already made any writes it needs. */
  | { kind: "resolved"; reason: Reason }
  /** Terminal; active pending slot rows retire under `cause`. */
  | { kind: "retire"; cause: string; reason: Reason }
  /** Batch admission only: publish this candidate one at a time instead. */
  | { kind: "defer" };

type SuggestionContext<Loaded> = { batch: boolean; loaded: Loaded };

/**
 * A Suggestion family published by Sweep Run steps. Generic publication owns
 * lock → suppression → precheck → unchanged match → retire → publish; the
 * family owns evidence, subject identity and the steps between.
 */
export type SuggestionFamily<
  Candidate,
  Row extends SuggestionRow = SuggestionRow,
  Reason extends string = never,
  Loaded = undefined,
> = {
  family: AssessmentFamily;
  slot(candidate: Candidate): SuggestionSlot;
  fingerprint(candidate: Candidate): string | Promise<string>;
  /** The rule evidence alone: a rule producer leaves equal evidence unchanged. */
  evidenceFingerprint(candidate: Candidate): string | Promise<string>;
  /** Locked rows in the family's own shape. */
  row?(row: SuggestionRow): Row;
  /** Before slot locks, over every candidate the transaction admits. */
  admit?(tx: Database, candidates: readonly Candidate[]): Promise<void>;
  /** After slot locks: current reads the prechecks share. */
  load?(
    tx: Database,
    candidates: readonly Candidate[],
    batch: boolean,
  ): Promise<Loaded>;
  precheck?(
    tx: Database,
    candidate: Candidate,
    rows: readonly Row[],
    producer: AssessmentProducer,
    context: SuggestionContext<Loaded>,
  ): Promise<SuggestionPrecheck<Reason> | undefined>;
  /** A row that never counts as unchanged, such as an obsolete label revision. */
  obsolete?(row: Row, producer: AssessmentProducer): boolean;
  /** `reconfirm` moves unchanged rows to the producer's Run under its cause. */
  onUnchanged: "none" | { reconfirm: string };
  /** Family steps between the unchanged match and publication. */
  prepare?(
    tx: Database,
    candidate: Candidate,
    rows: readonly Row[],
    producer: AssessmentProducer,
    context: SuggestionContext<Loaded>,
  ): Promise<{ candidate: Candidate; producer: AssessmentProducer } | "defer">;
  publication(
    candidate: Candidate,
    rows: readonly Row[],
    producer: AssessmentProducer,
    fingerprints: { fingerprint: string; evidenceFingerprint: string },
  ): Publication;
  afterPublish?(
    tx: Database,
    published: readonly {
      assessmentId: string;
      candidate: Candidate;
      producer: AssessmentProducer;
    }[],
    context: SuggestionContext<Loaded>,
  ): Promise<void>;
  /** False publishes the candidate one at a time, outside any batch. */
  batchable?(candidate: Candidate): boolean;
  /** Pending work a label pass owns, over `AssessmentState s`. */
  labelBacklog: SQL;
};

export type SuggestionOutcome<
  Candidate,
  Row extends SuggestionRow = SuggestionRow,
  Reason extends string = never,
> =
  | { outcome: "suppressed" }
  | { outcome: "resolved"; reason: Reason }
  | { outcome: "unchanged"; rows: Row[] }
  | {
      outcome: "published";
      assessmentId: string;
      candidate: Candidate;
      producer: AssessmentProducer;
    }
  | { outcome: "deferred" };

/**
 * Take every slot's advisory lock in key order, then lock and read each
 * slot's history. Stable order keeps overlapping batches deadlock-free.
 */
export async function lockSuggestionSlots<
  Candidate,
  Row extends SuggestionRow,
  Reason extends string,
  Loaded,
>(
  tx: Database,
  family: SuggestionFamily<Candidate, Row, Reason, Loaded>,
  candidates: readonly Candidate[],
): Promise<Row[][]> {
  if (!candidates.length) return [];
  const slots = candidates.map((candidate) => family.slot(candidate));
  const client = getDb(tx);
  await client.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(locks.key, 0))
    FROM (SELECT key FROM unnest(ARRAY[${sql.join(
      slots.map((slot) => sql`${slot.lock}`),
      sql`, `,
    )}]::text[]) AS keys(key) ORDER BY key) locks
  `);
  const names = Object.keys(slots[0]!.fields);
  const fields = sql.join(
    names.map((name) => sql`s.data->>${name}`),
    sql`, `,
  );
  const { rows } = await client.execute<SuggestionRow & { slot: string[] }>(
    sql`
    SELECT s.id::text AS id, s.status, s.active, s.fingerprint, s.suppression, s.data,
      s.data->>'evidenceFingerprint' AS "evidenceFingerprint",
      to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "createdAt",
      a.producer, a.judgment, ARRAY[${fields}] AS slot
    FROM "AssessmentState" s JOIN "Assessment" a ON a.id = s.id
    WHERE s.family = ${family.family} AND (${fields}) IN (${sql.join(
      slots.map(
        (slot) =>
          sql`(${sql.join(
            names.map((name) => sql`${slot.fields[name]}`),
            sql`, `,
          )})`,
      ),
      sql`, `,
    )})
    ORDER BY s."createdAt" DESC, s.id DESC
    FOR UPDATE OF s
  `,
  );
  // SAFETY: a family without `row` keeps the default `Row = SuggestionRow`.
  const toRow = family.row ?? ((row: SuggestionRow) => row as Row);
  const bySlot = new Map<string, Row[]>();
  for (const { slot, ...row } of rows) {
    const key = JSON.stringify(slot);
    bySlot.set(key, [
      ...(bySlot.get(key) ?? []),
      toRow({ ...row, data: suggestionData.parse(row.data) }),
    ]);
  }
  return slots.map(
    (slot) =>
      bySlot.get(
        JSON.stringify(names.map((name) => slot.fields[name] ?? null)),
      ) ?? [],
  );
}

/** Active rows equal to the candidate; a rule producer also matches equal evidence. */
export async function unchangedSuggestions<
  Candidate,
  Row extends SuggestionRow,
  Reason extends string,
  Loaded,
>(
  family: SuggestionFamily<Candidate, Row, Reason, Loaded>,
  rows: readonly Row[],
  candidate: Candidate,
  producer: AssessmentProducer,
): Promise<Row[]> {
  const fingerprint = await family.fingerprint(candidate);
  const evidenceFingerprint = await family.evidenceFingerprint(candidate);
  return rows.filter(
    (row) =>
      row.active &&
      !family.obsolete?.(row, producer) &&
      (row.fingerprint === fingerprint ||
        (producer.kind === "rule" &&
          row.evidenceFingerprint === evidenceFingerprint)),
  );
}

/** Retire replaced rows before their replacement takes the slot. */
export async function retireSupersededSuggestions(
  tx: Database,
  ids: readonly string[],
) {
  if (!ids.length) return;
  await transitionAssessmentStates(
    tx,
    inArray(assessmentState.id, [...ids]),
    (row) => ({
      active: false,
      ...(row.status === "pending" && { status: "superseded" }),
    }),
    { kind: "superseded_by_publication" },
  );
}

async function publishLocked<
  Candidate,
  Row extends SuggestionRow,
  Reason extends string,
  Loaded,
>(
  tx: Database,
  family: SuggestionFamily<Candidate, Row, Reason, Loaded>,
  candidates: readonly Candidate[],
  producer: AssessmentProducer,
  batch: boolean,
): Promise<SuggestionOutcome<Candidate, Row, Reason>[]> {
  await family.admit?.(tx, candidates);
  const history = await lockSuggestionSlots(tx, family, candidates);
  const context: SuggestionContext<Loaded> = {
    batch,
    // SAFETY: a family without `load` keeps the default `Loaded = undefined`.
    loaded: (await family.load?.(tx, candidates, batch)) as Loaded,
  };
  const outcomes: SuggestionOutcome<Candidate, Row, Reason>[] = [];
  const publications: {
    index: number;
    candidate: Candidate;
    producer: AssessmentProducer;
    rows: readonly Row[];
  }[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const rows = history[index]!;
    // A dismissal holds over every later publication, active or not.
    if (rows.some((row) => row.suppression !== null)) {
      outcomes[index] = { outcome: "suppressed" };
      continue;
    }
    const check = await family.precheck?.(
      tx,
      candidate,
      rows,
      producer,
      context,
    );
    if (check?.kind === "defer") {
      outcomes[index] = { outcome: "deferred" };
      continue;
    }
    if (check?.kind === "retire") {
      const pending = rows
        .filter(
          (row) => row.active && row.status === suggestionStatus.enum.pending,
        )
        .map((row) => row.id);
      if (pending.length)
        await transitionAssessmentStates(
          tx,
          inArray(assessmentState.id, pending),
          { active: false, status: "superseded" },
          { kind: check.cause },
        );
    }
    if (check) {
      outcomes[index] = { outcome: "resolved", reason: check.reason };
      continue;
    }
    const unchanged = await unchangedSuggestions(
      family,
      rows,
      candidate,
      producer,
    );
    if (unchanged.length) {
      // The state follows the Run that last confirmed it, so a later
      // run-scoped label pass still finds work an earlier Run left behind.
      if (family.onUnchanged !== "none" && producer.runId)
        await transitionAssessmentStates(
          tx,
          inArray(
            assessmentState.id,
            unchanged.map((row) => row.id),
          ),
          { runId: producer.runId },
          { kind: family.onUnchanged.reconfirm },
        );
      outcomes[index] = { outcome: "unchanged", rows: unchanged };
      continue;
    }
    const prepared = family.prepare
      ? await family.prepare(tx, candidate, rows, producer, context)
      : { candidate, producer };
    if (prepared === "defer") {
      outcomes[index] = { outcome: "deferred" };
      continue;
    }
    publications.push({ index, ...prepared, rows });
  }
  if (!publications.length) return outcomes;
  await retireSupersededSuggestions(
    tx,
    publications.flatMap(({ rows }) =>
      rows.filter((row) => row.active).map((row) => row.id),
    ),
  );
  const entries = await Promise.all(
    publications.map(async ({ candidate, producer: by, rows }) =>
      family.publication(candidate, rows, by, {
        fingerprint: await family.fingerprint(candidate),
        evidenceFingerprint: await family.evidenceFingerprint(candidate),
      }),
    ),
  );
  const published = await publishAssessments(tx, entries);
  const receipts = publications.map(
    ({ index, candidate, producer: by }, at) => {
      const assessment = published[at];
      if (!assessment)
        throw new Error("Suggestion publication returned no row");
      outcomes[index] = {
        outcome: "published",
        assessmentId: assessment.id,
        candidate,
        producer: by,
      };
      return { assessmentId: assessment.id, candidate, producer: by };
    },
  );
  await family.afterPublish?.(tx, receipts, context);
  return outcomes;
}

/**
 * Publish one candidate in its own fenced transaction. The slot is locked
 * first, so a member's review serializes with its replacement.
 */
export async function publishSuggestion<
  Candidate,
  Row extends SuggestionRow,
  Reason extends string,
  Loaded,
>(
  db: Database,
  family: SuggestionFamily<Candidate, Row, Reason, Loaded>,
  candidate: Candidate,
  producer: AssessmentProducer,
): Promise<SuggestionOutcome<Candidate, Row, Reason>> {
  return withTransactionDatabase(db, async (tx) => {
    await assertWorkflowEffect(tx);
    const [outcome] = await publishLocked(
      tx,
      family,
      [candidate],
      producer,
      false,
    );
    if (!outcome || outcome.outcome === "deferred")
      throw new Error("One-at-a-time suggestion publication cannot defer");
    return outcome;
  });
}

/**
 * Run batches of 32 concurrently. A failed batch rolls back together, so
 * each item it left without an outcome runs through `one`, isolating only
 * the genuinely failed item.
 */
export async function inSuggestionBatches<Item, Outcome>(
  items: readonly Item[],
  input: {
    concurrency: number;
    label: string;
    batch: (items: readonly Item[]) => Promise<(Outcome | undefined)[]>;
    one: (item: Item) => Promise<Outcome>;
    onOutcome: (item: Item, outcome: Outcome) => void;
    onFailure: (item: Item, error: Error) => void;
  },
) {
  const batches: Item[][] = [];
  for (let offset = 0; offset < items.length; offset += SUGGESTION_BATCH)
    batches.push(items.slice(offset, offset + SUGGESTION_BATCH));
  await forEachConcurrently(batches, input.concurrency, async (batch) => {
    let outcomes: (Outcome | undefined)[] = [];
    try {
      outcomes = await input.batch(batch);
    } catch (error) {
      if (isWorkflowInterrupted(error)) throw error;
      log.warn("Suggestion batch falling back to one-at-a-time publication", {
        family: input.label,
        count: batch.length,
      });
    }
    for (const [index, item] of batch.entries()) {
      const outcome = outcomes[index];
      if (outcome !== undefined) {
        input.onOutcome(item, outcome);
        continue;
      }
      try {
        input.onOutcome(item, await input.one(item));
      } catch (error) {
        if (isWorkflowInterrupted(error)) throw error;
        input.onFailure(
          item,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  });
}

/**
 * Publish a generation page: batchable candidates share one fenced
 * transaction per batch; deferred and unbatchable ones publish alone.
 */
export async function publishSuggestionBatches<
  Candidate,
  Row extends SuggestionRow,
  Reason extends string,
  Loaded,
>(
  db: Database,
  family: SuggestionFamily<Candidate, Row, Reason, Loaded>,
  candidates: readonly Candidate[],
  producer: AssessmentProducer,
  input: {
    concurrency: number;
    onOutcome: (
      candidate: Candidate,
      outcome: SuggestionOutcome<Candidate, Row, Reason>,
    ) => void;
    onFailure: (candidate: Candidate, error: Error) => void;
  },
) {
  await inSuggestionBatches(candidates, {
    concurrency: input.concurrency,
    label: family.family,
    batch: async (batch) => {
      const admitted = batch.flatMap((candidate, index) =>
        family.batchable?.(candidate) === false ? [] : [{ candidate, index }],
      );
      const outcomes: (
        | SuggestionOutcome<Candidate, Row, Reason>
        | undefined
      )[] = [];
      if (!admitted.length) return outcomes;
      const published = await withTransactionDatabase(db, async (tx) => {
        await assertWorkflowEffect(tx);
        return publishLocked(
          tx,
          family,
          admitted.map(({ candidate }) => candidate),
          producer,
          true,
        );
      });
      for (const [at, { index }] of admitted.entries()) {
        const outcome = published[at];
        if (outcome?.outcome !== "deferred") outcomes[index] = outcome;
      }
      return outcomes;
    },
    one: (candidate) => publishSuggestion(db, family, candidate, producer),
    onOutcome: input.onOutcome,
    onFailure: input.onFailure,
  });
}

/** A label pass's position in `(createdAt, id)` order. */
export type SuggestionLabelCursor = { createdAt: string; id: string };

/** Family label predicates read the backlog as `AssessmentState s`. */
const backlogState = alias(assessmentState, "s");
const backlogCreatedAt = sql<string>`to_char(${backlogState.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
const backlogWhere = (
  family: Pick<SuggestionFamily<unknown>, "family" | "labelBacklog">,
  ...more: (SQL | undefined)[]
) => and(eq(backlogState.family, family.family), family.labelBacklog, ...more);

/** The family's label backlog after the cursor, oldest first. */
export async function suggestionLabelBacklog(
  db: Database,
  family: Pick<SuggestionFamily<unknown>, "family" | "labelBacklog">,
  input: {
    limit: number;
    after?: SuggestionLabelCursor | null;
    where?: SQL;
  },
) {
  return getDb(db)
    .select({
      id: sql<string>`${backlogState.id}::text`,
      createdAt: backlogCreatedAt,
      data: backlogState.data,
    })
    .from(backlogState)
    .where(
      backlogWhere(
        family,
        input.where,
        input.after
          ? sql`(${backlogState.createdAt}, ${backlogState.id}) > (${input.after.createdAt}::timestamp, ${input.after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(backlogState.createdAt), asc(backlogState.id))
    .limit(input.limit);
}

/** Remaining label backlog, for a Sweep's estimate. */
export async function countSuggestionLabelBacklog(
  db: Database,
  family: Pick<SuggestionFamily<unknown>, "family" | "labelBacklog">,
  where?: SQL,
) {
  const [row] = await getDb(db)
    .select({ count: count() })
    .from(backlogState)
    .where(backlogWhere(family, where));
  return row?.count ?? 0;
}
