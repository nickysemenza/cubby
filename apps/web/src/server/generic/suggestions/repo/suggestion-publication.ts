import { suggestionStatus } from "@cubby/schemas/ai";
import {
  mailDecisionFamily,
  suggestionJudgments,
  suggestionProjectionTargets,
  suggestionPublication,
  type SuggestionFamily as StoredSuggestionFamily,
  type SuggestionProducer,
} from "@cubby/schemas/suggestion";
import { createLogger } from "@cubby/worker-tracing";
import { and, count, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { forEachConcurrently } from "~/lib/concurrency-limiter";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import { recordChange } from "~/server/generic/changes/repo/change";
import type { SuggestionPublication } from "~/server/generic/suggestions/repo/suggestion";
import { transitionSuggestionStates } from "~/server/generic/suggestions/repo/suggestion-state";
import {
  assertWorkflowEffect,
  isWorkflowInterrupted,
} from "~/server/workflows/runs/execution";

const log = createLogger("suggestion-publication");

const suggestionData = z.record(z.string(), z.json());

/** Candidates one publication transaction admits together. */
const SUGGESTION_BATCH = 32;

/** One locked Suggestion row of a slot, newest first. */
export type SuggestionRow = {
  id: string;
  publicationKey: string;
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
 * publisher of the subject takes, and the text fields that select its
 * history. A field names the `entity`, `recordId`, `field` or
 * `publicationKey` column, a `subject.` key, or else a `data` key. Every slot
 * of a family names the same fields.
 */
type SuggestionSlot = {
  lock: string;
  fields: Readonly<Record<string, string>>;
};

function slotField(name: string) {
  const column =
    name === "entity"
      ? sql`s.entity`
      : name === "recordId"
        ? sql`s."recordId"`
        : name === "field"
          ? sql`s.field`
          : name === "publicationKey"
            ? sql`s."publicationKey"`
            : name.startsWith("subject.")
              ? sql`s.subject->>${name.slice("subject.".length)}`
              : sql`s.data->>${name}`;
  return {
    column,
    // The uuid column compares uncast so its index still applies.
    value: (value: string | undefined) =>
      name === "recordId" ? sql`${value ?? null}::uuid` : sql`${value ?? null}`,
  };
}

type Fingerprints = { fingerprint: string; evidenceFingerprint: string };

/** A family check after suppression and before the unchanged match. */
type SuggestionPrecheck<Reason extends string> =
  /** Terminal; the family already made any writes it needs. */
  | { kind: "resolved"; reason: Reason }
  /** Terminal; active pending slot rows retire. */
  | { kind: "retire"; reason: Reason }
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
  family: StoredSuggestionFamily;
  financial?: boolean;
  slot(candidate: Candidate): SuggestionSlot;
  fingerprint(candidate: Candidate): string | Promise<string>;
  /** The rule evidence alone: a rule producer leaves equal evidence unchanged. */
  evidenceFingerprint(candidate: Candidate): string | Promise<string>;
  /** Locked rows in the family's own shape. */
  row?(row: SuggestionRow): Row;
  /** Whether a suppressed row holds the slot; by default every suppression does. */
  suppresses?(row: Row, fingerprints: Fingerprints): boolean;
  /**
   * A candidate no review could apply. Checked before `precheck` and treated
   * as its `retire`, so no pending row is published without an apply path.
   */
  unapplicable?(candidate: Candidate): Reason | null;
  /** Before slot locks, over every candidate the transaction admits. */
  admit?(tx: Database, candidates: readonly Candidate[]): Promise<void>;
  /** After slot locks: current reads the prechecks share, given each slot's locked rows. */
  load?(
    tx: Database,
    candidates: readonly Candidate[],
    batch: boolean,
    rows: readonly (readonly Row[])[],
    producer: SuggestionProducer,
  ): Promise<Loaded>;
  precheck?(
    tx: Database,
    candidate: Candidate,
    rows: readonly Row[],
    producer: SuggestionProducer,
    context: SuggestionContext<Loaded>,
  ): Promise<SuggestionPrecheck<Reason> | undefined>;
  /**
   * A row that never counts as unchanged, such as an obsolete label revision
   * or a booking whose current replan differs. `loaded` is absent outside
   * {@link publishLocked}.
   */
  obsolete?(row: Row, producer: SuggestionProducer, loaded?: Loaded): boolean;
  /** `reconfirm` moves unchanged rows to the producer's Run under its cause. */
  onUnchanged: "none" | { reconfirm: string };
  /**
   * What a publication does to the slot's other rows: `retire` deactivates
   * active rows and deletes superseded ones no decision or authority retains,
   * `deactivate` keeps them as history, and `keep` leaves them to the family.
   * Defaults to `retire`.
   */
  replaced?: "retire" | "deactivate" | "keep";
  /** Family steps between the unchanged match and publication. */
  prepare?(
    tx: Database,
    candidate: Candidate,
    rows: readonly Row[],
    producer: SuggestionProducer,
    context: SuggestionContext<Loaded>,
  ): Promise<{ candidate: Candidate; producer: SuggestionProducer } | "defer">;
  publication(
    candidate: Candidate,
    rows: readonly Row[],
    producer: SuggestionProducer,
    fingerprints: Fingerprints,
  ): SuggestionPublication;
  afterPublish?(
    tx: Database,
    published: readonly {
      suggestionId: string;
      candidate: Candidate;
      producer: SuggestionProducer;
    }[],
    context: SuggestionContext<Loaded>,
  ): Promise<void>;
  /** False publishes the candidate one at a time, outside any batch. */
  batchable?(candidate: Candidate): boolean;
  /** Pending work a label pass owns, over `Suggestion s`. */
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
      suggestionId: string;
      row: PublishedSuggestion;
      candidate: Candidate;
      producer: SuggestionProducer;
    }
  | { outcome: "deferred" };

type PublishedSuggestion = typeof suggestionTable.$inferSelect;

/** Financial feedback dismisses this revision, not every later bank event or proposal. */
export const revisionSuppresses = (row: SuggestionRow, f: Fingerprints) =>
  row.active &&
  (row.fingerprint === f.fingerprint ||
    row.evidenceFingerprint === f.evidenceFingerprint);

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
  const fields = names.map(slotField);
  const rows = await client.execute<SuggestionRow & { slot: string[] }>(
    sql`
    SELECT s.id::text AS id, s."publicationKey", s.status, s.active, s.fingerprint, s.suppression, s.data,
      s.data->>'evidenceFingerprint' AS "evidenceFingerprint",
      to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "createdAt",
      s.producer, s.judgment,
      ARRAY[${sql.join(
        fields.map(({ column }) => sql`${column}::text`),
        sql`, `,
      )}] AS slot
    FROM "Suggestion" s
    WHERE s.family = ${family.family} AND (${sql.join(
      fields.map(({ column }) => column),
      sql`, `,
    )}) IN (${sql.join(
      slots.map(
        (slot) =>
          sql`(${sql.join(
            fields.map(({ value }, at) => value(slot.fields[names[at]!])),
            sql`, `,
          )})`,
      ),
      sql`, `,
    )})
    ORDER BY s."createdAt" DESC, s.id DESC
    FOR UPDATE OF s
  `,
    "objects",
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
  producer: SuggestionProducer,
  loaded?: Loaded,
): Promise<Row[]> {
  const fingerprint = await family.fingerprint(candidate);
  const evidenceFingerprint = await family.evidenceFingerprint(candidate);
  return rows.filter(
    (row) =>
      row.active &&
      !family.obsolete?.(row, producer, loaded) &&
      (row.fingerprint === fingerprint ||
        (producer.kind === "rule" &&
          row.evidenceFingerprint === evidenceFingerprint)),
  );
}

/** Retire replaced rows before their replacement takes the slot. */
async function retireSupersededSuggestions(
  tx: Database,
  ids: readonly string[],
) {
  if (!ids.length) return;
  await transitionSuggestionStates(
    tx,
    inArray(suggestionTable.id, [...ids]),
    (row) => ({
      active: false,
      ...(row.status === "pending" && { status: "superseded" }),
    }),
  );
}

/** Inserts immutable evidence atomically, returning one row per input in order. */
async function insertSuggestions(
  db: Database,
  entries: readonly SuggestionPublication[],
) {
  // Validate every publication and creation snapshot before any writes.
  const prepared = entries.map(({ input: raw, projection = {} }) => {
    const input = suggestionPublication.parse(raw);
    suggestionJudgments[input.family].parse(input.judgment);
    const suggestedValue =
      projection.suggestedValue === undefined
        ? input.judgment
        : projection.suggestedValue;
    if (mailDecisionFamily.safeParse(input.family).success)
      throw new Error("Mail decisions live with their domain owners");
    const { entity, recordId } = input.subject;
    const state = {
      // An answer for an unsaved record has no target to validate yet.
      ...(recordId === null
        ? { entity, recordId }
        : suggestionProjectionTargets[input.family].parse({
            entity,
            recordId,
            ...projection,
          })),
      field: input.subject.kind === "field" ? input.subject.field : "",
      fingerprint: input.fingerprint,
      ...projection,
      suggestedValue,
    };
    return { input, state };
  });
  if (!prepared.length) return [];
  const publications = new Map<string, (typeof prepared)[number]>();
  for (const entry of prepared) {
    const previous = publications.get(entry.input.publicationKey);
    if (previous && !isEqual(previous.input, entry.input))
      throw new Error(
        "Suggestion publication retry changed immutable evidence",
      );
    // Sequential replays keep the first creation projection for this key.
    if (!previous) publications.set(entry.input.publicationKey, entry);
  }
  return withTransactionDatabase(db, async (transactionDb) => {
    const client = getDb(transactionDb);
    const inserted = await client
      .insert(suggestionTable)
      .values(
        [...publications.values()].map(({ input, state }) => ({
          ...input,
          ...state,
          family: input.family,
          judgment:
            input.judgment === null ? sql`'null'::jsonb` : input.judgment,
          // A JSON null suggestion stays a JSON value, not SQL NULL.
          suggestedValue:
            state.suggestedValue === null
              ? sql`'null'::jsonb`
              : state.suggestedValue,
        })),
      )
      .onConflictDoNothing({ target: suggestionTable.publicationKey })
      .returning();
    const rowsByKey = new Map(inserted.map((row) => [row.publicationKey, row]));
    const conflicts = [...publications.keys()].filter(
      (key) => !rowsByKey.has(key),
    );
    if (conflicts.length) {
      const existing = await client
        .select()
        .from(suggestionTable)
        .where(inArray(suggestionTable.publicationKey, conflicts));
      for (const row of existing) rowsByKey.set(row.publicationKey, row);
    }
    const rows = prepared.map(({ input }) => {
      const row = rowsByKey.get(input.publicationKey);
      if (!row) throw new Error("Suggestion publication returned no row");
      // State may later take its own fingerprint; a retry compares what it proposed.
      if (
        !isEqual(
          { ...input, fingerprint: null },
          { ...suggestionPublication.parse(row), fingerprint: null },
        )
      )
        throw new Error(
          "Suggestion publication retry changed immutable evidence",
        );
      return row;
    });
    if (inserted.length)
      await recordChange(transactionDb, {
        kind: "projection",
        categories: [
          ...new Set([
            "ai",
            "suggestions",
            "problems",
            ...inserted.map((row) => row.entity),
          ]),
        ],
      });
    return rows;
  });
}

/**
 * Replaced opinions are not history: a superseded row with no decision or
 * authority of its own goes once its replacement is published.
 */
async function pruneReplacedSuggestions(tx: Database, ids: readonly string[]) {
  if (!ids.length) return;
  await getDb(tx)
    .delete(suggestionTable)
    .where(
      and(
        inArray(suggestionTable.id, [...ids]),
        eq(suggestionTable.status, "superseded"),
        sql`${suggestionTable.decisions} = '[]'::jsonb`,
        isNull(suggestionTable.suppression),
        isNull(suggestionTable.confirmedValue),
        isNull(suggestionTable.acceptanceReceipt),
      ),
    );
}

/**
 * Publish replacements for locked slots: the family's `replaced` policy
 * settles each slot's earlier rows, except the row a publication replays by
 * key, which keeps its place.
 */
export async function publishReplacements(
  tx: Database,
  family: { replaced?: "retire" | "deactivate" | "keep" },
  replacements: readonly {
    rows: readonly SuggestionRow[];
    publication: SuggestionPublication;
  }[],
): Promise<PublishedSuggestion[]> {
  const replaced = family.replaced ?? "retire";
  const keys = new Set(
    replacements.map(({ publication }) => publication.input.publicationKey),
  );
  const earlier =
    replaced === "keep"
      ? []
      : replacements.flatMap(({ rows }) =>
          rows.filter((row) => !keys.has(row.publicationKey)),
        );
  await retireSupersededSuggestions(
    tx,
    earlier.filter((row) => row.active).map((row) => row.id),
  );
  const published = await insertSuggestions(
    tx,
    replacements.map(({ publication }) => publication),
  );
  if (replaced === "retire")
    await pruneReplacedSuggestions(
      tx,
      earlier.map((row) => row.id),
    );
  return published;
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
  producer: SuggestionProducer,
  batch: boolean,
): Promise<SuggestionOutcome<Candidate, Row, Reason>[]> {
  await family.admit?.(tx, candidates);
  const history = await lockSuggestionSlots(tx, family, candidates);
  const context: SuggestionContext<Loaded> = {
    batch,
    // SAFETY: a family without `load` keeps the default `Loaded = undefined`.
    loaded: (await family.load?.(
      tx,
      candidates,
      batch,
      history,
      producer,
    )) as Loaded,
  };
  const suppresses = family.suppresses ?? (() => true);
  const outcomes: SuggestionOutcome<Candidate, Row, Reason>[] = [];
  const publications: {
    index: number;
    candidate: Candidate;
    producer: SuggestionProducer;
    rows: readonly Row[];
  }[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const rows = history[index]!;
    const fingerprints = {
      fingerprint: await family.fingerprint(candidate),
      evidenceFingerprint: await family.evidenceFingerprint(candidate),
    };
    if (
      rows.some(
        (row) => row.suppression !== null && suppresses(row, fingerprints),
      )
    ) {
      outcomes[index] = { outcome: "suppressed" };
      continue;
    }
    const unapplicable = family.unapplicable?.(candidate) ?? null;
    const check =
      unapplicable === null
        ? await family.precheck?.(tx, candidate, rows, producer, context)
        : { kind: "retire" as const, reason: unapplicable };
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
        await transitionSuggestionStates(
          tx,
          inArray(suggestionTable.id, pending),
          { active: false, status: "superseded" },
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
      context.loaded,
    );
    if (unchanged.length) {
      // The state follows the Run that last confirmed it, so a later
      // run-scoped label pass still finds work an earlier Run left behind.
      if (family.onUnchanged !== "none" && producer.runId)
        await transitionSuggestionStates(
          tx,
          inArray(
            suggestionTable.id,
            unchanged.map((row) => row.id),
          ),
          { runId: producer.runId },
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
  const published = await publishReplacements(
    tx,
    family,
    await Promise.all(
      publications.map(async ({ candidate, producer: by, rows }) => ({
        rows,
        publication: family.publication(candidate, rows, by, {
          fingerprint: await family.fingerprint(candidate),
          evidenceFingerprint: await family.evidenceFingerprint(candidate),
        }),
      })),
    ),
  );
  const receipts = publications.map(
    ({ index, candidate, producer: by }, at) => {
      const row = published[at];
      if (!row) throw new Error("Suggestion publication returned no row");
      outcomes[index] = {
        outcome: "published",
        suggestionId: row.id,
        row,
        candidate,
        producer: by,
      };
      return { suggestionId: row.id, candidate, producer: by };
    },
  );
  await family.afterPublish?.(tx, receipts, context);
  return outcomes;
}

/**
 * Publish candidates together in one fenced transaction, one at a time in
 * effect: nothing defers. Slots are locked first, so a member's review
 * serializes with its replacement.
 */
export async function publishSuggestionSet<
  Candidate,
  Row extends SuggestionRow,
  Reason extends string,
  Loaded,
>(
  db: Database,
  family: SuggestionFamily<Candidate, Row, Reason, Loaded>,
  candidates: readonly Candidate[],
  producer: SuggestionProducer,
): Promise<
  Exclude<SuggestionOutcome<Candidate, Row, Reason>, { outcome: "deferred" }>[]
> {
  if (!candidates.length) return [];
  return withTransactionDatabase(db, async (tx) => {
    await assertWorkflowEffect(tx);
    const outcomes = await publishLocked(
      tx,
      family,
      candidates,
      producer,
      false,
    );
    return candidates.map((_, index) => {
      const outcome = outcomes[index];
      if (!outcome || outcome.outcome === "deferred")
        throw new Error("One-at-a-time suggestion publication cannot defer");
      return outcome;
    });
  });
}

/** Publish one candidate in its own fenced transaction. */
export async function publishSuggestion<
  Candidate,
  Row extends SuggestionRow,
  Reason extends string,
  Loaded,
>(
  db: Database,
  family: SuggestionFamily<Candidate, Row, Reason, Loaded>,
  candidate: Candidate,
  producer: SuggestionProducer,
) {
  const [outcome] = await publishSuggestionSet(
    db,
    family,
    [candidate],
    producer,
  );
  if (!outcome) throw new Error("Suggestion publication returned no outcome");
  return outcome;
}

/**
 * A slot of one immutable publication. It never suppresses, matches or
 * settles another row, so a replay returns the row its key names. Run
 * evidence and live answers that occupy no queue slot publish this way.
 */
const exactSuggestions = (
  family: StoredSuggestionFamily,
): SuggestionFamily<SuggestionPublication> => ({
  family,
  slot: ({ input }) => ({
    lock: input.publicationKey,
    fields: { publicationKey: input.publicationKey },
  }),
  fingerprint: ({ input }) => input.fingerprint ?? "",
  evidenceFingerprint: ({ input }) => input.fingerprint ?? "",
  suppresses: () => false,
  obsolete: () => true,
  onUnchanged: "none",
  replaced: "keep",
  publication: (entry) => entry,
  labelBacklog: sql`false`,
});

/**
 * Publish exact immutable evidence of one family atomically, returning the row
 * each key names in input order.
 */
export async function publishExactSuggestions(
  db: Database,
  entries: readonly SuggestionPublication[],
): Promise<PublishedSuggestion[]> {
  const family = entries[0]?.input.family;
  if (!family) return [];
  if (entries.some(({ input }) => input.family !== family))
    throw new Error("Exact suggestion publications share one family");
  const outcomes = await publishSuggestionSet(
    db,
    exactSuggestions(family),
    entries,
    // Exact publications store their own producer; this one only steers matching.
    {
      kind: "agent",
      model: null,
      revision: null,
      runId: null,
      evaluationId: null,
    },
  );
  return outcomes.map((outcome) => {
    if (outcome.outcome !== "published")
      throw new Error("Exact suggestion publication did not publish");
    return outcome.row;
  });
}

/** One exact publication, or the row its key already names. */
export async function publishExactSuggestion(
  db: Database,
  input: SuggestionPublication["input"],
  projection: SuggestionPublication["projection"] = {},
): Promise<PublishedSuggestion> {
  const [row] = await publishExactSuggestions(db, [{ input, projection }]);
  if (!row) throw new Error("Suggestion publication returned no row");
  return row;
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
  producer: SuggestionProducer,
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

/** Family label predicates read the backlog as `Suggestion s`. */
const backlogState = alias(suggestionTable, "s");
const backlogWhere = (
  family: Pick<SuggestionFamily<unknown>, "family" | "labelBacklog">,
  ...more: (SQL | undefined)[]
) => and(eq(backlogState.family, family.family), family.labelBacklog, ...more);

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
