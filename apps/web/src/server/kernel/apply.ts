/**
 * Apply (ADR 0029 section 6). Loading and computing happen before the
 * transaction opens; the apply transaction takes the household write gate
 * for the money lane, locks each read key's `KeyRev` and the scope's
 * `ScopeDirty` row, and writes nothing for a scope whose `rev` or `seq`
 * moved since its load. A conflict spends no attempt; after three in a row
 * the scope runs locked: load, compute and apply in one bounded transaction.
 */
import { resolveStage, nextActor } from "@cubby/schemas/kernel/stage";
import type { KernelGap } from "@cubby/schemas/kernel/stage";
import { getTableColumns, getTableName, sql, type SQL } from "drizzle-orm";
import { getTableConfig, type PgColumn } from "drizzle-orm/pg-core";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db/database";
import { withKernelApply } from "~/server/db/kernel-apply-context";
import {
  evidenceBinding,
  recordKey,
  scopeState,
} from "~/server/db/kernel-schema";
import {
  repositoryQueries,
  repositorySavepoint,
  repositoryTransactionDatabase,
  type RepositoryQueryClient,
} from "~/server/db/repository-access.boundary";
import { isShortcodeEntity } from "~/server/entity-kernel/repo/entity-identity";
import {
  insertPayloadsWithIdentities,
  isEntityShortcodeCollision,
} from "~/server/entity-kernel/repo/entity-identity-writer";
import { findPgError } from "~/server/errors/db-errors";
import { recordChange } from "~/server/generic/changes/repo/change";

import {
  askGapState,
  askIsStuck,
  askMemberGap,
  type AskCondition,
} from "./ask-gap";
import { auditApply } from "./audit";
import {
  ClaimLapsedError,
  LOCKED_RUN_AFTER_CONFLICTS,
  MAX_SCOPE_ATTEMPTS,
  rawError,
  recordConflict,
  settleFailure,
  type ClaimedScope,
} from "./claim";
import {
  computeBatch,
  recordEntity,
  usedInputs,
  type Computed,
} from "./compute";
import type {
  ColumnRef,
  ColumnValues,
  Key,
  Outcome,
  Reconciler,
  ScopeRef,
} from "./define";
import { difference, type Difference } from "./diff";
import { lockKeyRevs, markDirty } from "./dirty";
import { recordDrift } from "./drift";
import {
  BACKGROUND_GATE_YIELD_MS,
  enterWriteTransaction,
  HouseholdWriteBusyError,
  type WriteMode,
} from "./gate";
import { mergeRecords, markRejected, removeRecords } from "./identity";
import {
  bindingEventKey,
  bindingFactKey,
  recordSubject,
  rowKey,
  tableKey,
} from "./keys";
import { KernelContractError } from "./reads";
import type { KernelRegistry } from "./registry";
import { wakeAfterCommit } from "./wake";

type Q = Pick<
  RepositoryQueryClient,
  "execute" | "insert" | "select" | "update" | "delete"
>;

/** An input moved after the load: write nothing, keep the scope dirty. */
class KernelConflict extends Error {
  override name = "KernelConflict";
}

export type ApplyOptions = {
  /** Drift approval: the scope's baseline bindings give way to the derivation. */
  releaseBaseline: boolean;
};

const isConflict = (error: UnparsedError) =>
  error instanceof KernelConflict ||
  isEntityShortcodeCollision(error, "Entity") ||
  ["40001", "40P01"].includes(findPgError(error)?.code ?? "");

/** A bound value cast to its column's type, for a typed VALUES list. */
function typed(value: unknown, column: PgColumn): SQL {
  const type = sql.raw(column.getSQLType());
  return value === null || value === undefined
    ? sql`NULL::${type}`
    : sql`${sql.param(value, column)}::${type}`;
}

async function insertRecords(
  tx: Database,
  q: Q,
  target: ColumnRef,
  rows: readonly ColumnValues[],
) {
  if (!rows.length) return;
  const entity = target.entity;
  if (entity && isShortcodeEntity(entity)) {
    // SAFETY: the reconciler declared these as columns of this entity's
    // table, and the shortcode insert supplies only the identity columns.
    await repositorySavepoint(tx, (nested) =>
      insertPayloadsWithIdentities(
        nested,
        target.table,
        entity,
        rows as never[],
      ),
    );
    return;
  }
  // SAFETY: as above; the declared columns are this table's own.
  await q.insert(target.table).values(rows as never[]);
}

/** Dependency waves preserve foreign keys, including links within one table. */
function orderedInserts(
  inserts: Difference["inserts"],
): Difference["inserts"][] {
  const pending = new Map(
    inserts.map((entry) => [`${entry.target.name}:${entry.id}`, entry]),
  );
  const groups: Difference["inserts"][] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((entry) => {
      const columns = getTableColumns(entry.target.table);
      return getTableConfig(entry.target.table).foreignKeys.every((fk) => {
        const reference = fk.reference();
        return reference.columns.every((column, index) => {
          if (reference.foreignColumns[index]?.name !== "id") return true;
          const property = Object.keys(columns).find(
            (key) => columns[key] === column,
          );
          return (
            !property ||
            !pending.has(
              `${getTableName(reference.foreignTable)}:${String(entry.values[property])}`,
            )
          );
        });
      });
    });
    if (!ready.length)
      throw new KernelContractError(
        "New reconciled records contain a foreign-key cycle",
      );
    const byTable = new Map<string, Difference["inserts"]>();
    for (const entry of ready) {
      pending.delete(`${entry.target.name}:${entry.id}`);
      const rows = byTable.get(entry.target.name) ?? [];
      rows.push(entry);
      byTable.set(entry.target.name, rows);
    }
    groups.push(...byTable.values());
  }
  return groups;
}

/**
 * Set-based compare-and-set updates: one statement per table and column set,
 * each row updated only while its columns still hold the values the load saw.
 * A row that moved is a conflict.
 */
async function updateRecords(q: Q, updates: Difference["updates"]) {
  const groups = new Map<string, Difference["updates"]>();
  for (const update of updates) {
    const id = `${update.target.name}\u0000${Object.keys(update.set).sort().join(",")}`;
    groups.set(id, [...(groups.get(id) ?? []), update]);
  }
  for (const group of groups.values()) {
    const target = group[0]!.target;
    const columns = getTableColumns(target.table);
    const props = Object.keys(group[0]!.set).sort();
    const column = (prop: string) => {
      const found = columns[prop];
      if (!found) throw new Error(`${target.name} has no column ${prop}`);
      return found;
    };
    const values = sql.join(
      group.map(
        (entry) =>
          sql`(${entry.id}::uuid, ${sql.join(
            [
              ...props.map((prop) => typed(entry.set[prop], column(prop))),
              ...props.map((prop) => typed(entry.seen[prop], column(prop))),
            ],
            sql`, `,
          )})`,
      ),
      sql`, `,
    );
    const names = [
      "id",
      ...props.map((_, index) => `s${index}`),
      ...props.map((_, index) => `o${index}`),
    ].join(", ");
    const sets = sql.join(
      props.map(
        (prop, index) =>
          sql`${sql.identifier(column(prop).name)} = v.${sql.raw(`s${index}`)}`,
      ),
      sql`, `,
    );
    const touched =
      columns.updatedAt && !props.includes("updatedAt")
        ? sql`, "updatedAt" = now()`
        : sql``;
    const unchanged = sql.join(
      props.map(
        (prop, index) =>
          sql`t.${sql.identifier(column(prop).name)} IS NOT DISTINCT FROM v.${sql.raw(`o${index}`)}`,
      ),
      sql` AND `,
    );
    const result = await q.execute<{ id: string }>(sql`
      UPDATE ${target.table} AS t SET ${sets}${touched}
      FROM (VALUES ${values}) AS v(${sql.raw(names)})
      WHERE t.id = v.id AND ${unchanged}
      RETURNING t.id`);
    if (result.rows.length !== group.length)
      throw new KernelConflict(
        `${target.name}: ${group.length - result.rows.length} records changed since the load`,
      );
  }
}

/** Queue each missing answer once and record that this scope waits on it. */
async function fileAsks(q: Q, computed: Computed) {
  const { scope } = computed;
  const wanted = computed.missing.map((missing) => ({
    inputHash: missing.inputHash,
    feature: missing.kind.feature,
    producer: missing.kind.producer,
    promptVersion: missing.kind.promptVersion,
    input: missing.envelope,
    maxAttempts: missing.kind.maxAttempts,
  }));
  if (wanted.length)
    await q.execute(sql`
      WITH wanted AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(wanted)}::jsonb) AS w(
          "inputHash" text, feature text, producer text, "promptVersion" text,
          input jsonb, "maxAttempts" int)
      ), inserted AS (
        INSERT INTO "Ask" ("inputHash", feature, producer, "promptVersion", input, "maxAttempts")
        SELECT "inputHash", feature, producer, "promptVersion", input, "maxAttempts" FROM wanted
        ON CONFLICT ("inputHash") DO NOTHING
        RETURNING id, "inputHash"
      )
      INSERT INTO "AskScope" ("askId", "scopeKind", "scopeKey")
      SELECT coalesce(inserted.id, existing.id), ${scope.kind}, ${scope.key}
      FROM wanted
      LEFT JOIN inserted ON inserted."inputHash" = wanted."inputHash"
      LEFT JOIN "Ask" existing ON existing."inputHash" = wanted."inputHash"
      ON CONFLICT DO NOTHING`);
  await q.execute(sql`
    DELETE FROM "AskScope" WHERE "scopeKind" = ${scope.kind} AND "scopeKey" = ${scope.key}
      AND "askId" NOT IN (SELECT id FROM "Ask" WHERE "inputHash" IN (
        SELECT value FROM jsonb_array_elements_text(${JSON.stringify(wanted.map((entry) => entry.inputHash))}::jsonb)))`);
}

/** The asks a scope waits on, with what a member must know about each. */
async function scopeAsks(q: Q, scope: ScopeRef): Promise<AskCondition[]> {
  const result = await q.execute<AskCondition>(sql`
    SELECT a."inputHash", a.state, a.attempts, a."maxAttempts",
      a."cancelledAt" IS NOT NULL AS cancelled
    FROM "AskScope" s JOIN "Ask" a ON a.id = s."askId"
    WHERE s."scopeKind" = ${scope.kind} AND s."scopeKey" = ${scope.key}`);
  return result.rows;
}

/**
 * Apply one computed scope inside the caller's transaction. Throws
 * {@link KernelConflict} when an input moved since the load, and
 * {@link ClaimLapsedError} when the claim can no longer publish.
 */
async function applyScope(
  tx: Database,
  registry: KernelRegistry,
  computed: Computed,
  claim: { token: string; seq: number; dirtiedAt: Date },
  options: ApplyOptions,
): Promise<KernelGap[]> {
  const q = repositoryQueries(tx);
  const { scope, reconciler } = computed;
  const desired = computed.desired!;

  // The rev fence first, in key order, as every mutation takes it.
  const keys = [...computed.keys.keys()].sort();
  const revs = await lockKeyRevs(q, keys);
  for (const [key, seen] of computed.keys)
    if ((revs.get(key) ?? 0) !== seen)
      throw new KernelConflict(`Key ${key} changed since the load`);
  const fence = await q.execute<{ seq: string | number; live: boolean }>(sql`
    SELECT seq, ("claimToken" = ${claim.token}::uuid AND "claimDeadline" > now()) AS live
    FROM "ScopeDirty" WHERE "scopeKind" = ${scope.kind} AND "scopeKey" = ${scope.key}
    FOR UPDATE`);
  const row = fence.rows[0];
  if (!row?.live) throw new ClaimLapsedError();
  if (Number(row.seq) !== claim.seq)
    throw new KernelConflict(
      `Scope ${scope.kind}:${scope.key} was dirtied since the load`,
    );

  const proposed = difference(computed, options);
  const decisionIds = new Set(
    computed.decisions.map((decision) => decision.id),
  );
  const heldBaseline =
    desired.disagreements.length > 0 ||
    (!options.releaseBaseline &&
      computed.storedBindings.some((binding) => binding.basis === "baseline") &&
      (proposed.inserts.some((insert) => {
        const record = desired.records.find(
          (record) =>
            record.target.name === insert.target.name &&
            record.naturalKey === insert.naturalKey,
        );
        return (
          !record ||
          Object.keys(record.values).some(
            (field) => !decisionIds.has(record.provenance[field] ?? ""),
          )
        );
      }) ||
        proposed.removals.length > 0 ||
        proposed.merges.length > 0 ||
        proposed.rejections.length > 0 ||
        computed.missing.length > 0 ||
        proposed.updates.some((update) =>
          Object.keys(update.set).some((field) => {
            const desiredRecord = desired.records.find(
              (record) =>
                record.target.name === update.target.name &&
                record.naturalKey === update.naturalKey,
            );
            return !decisionIds.has(desiredRecord?.provenance[field] ?? "");
          }),
        ) ||
        proposed.bindingsAdd.some(
          (binding) =>
            binding.basis !== "decision" &&
            !computed.storedBindings.some(
              (stored) =>
                stored.basis === "baseline" &&
                stored.fact.kind === binding.fact.kind &&
                stored.fact.id === binding.fact.id &&
                stored.eventKey === binding.eventKey,
            ),
        )));
  if (heldBaseline) await recordDrift(q, computed, proposed);
  const diff: Difference = heldBaseline
    ? {
        inserts: [],
        updates: [],
        removals: [],
        rejections: [],
        bindingsAdd: [],
        bindingsRemove: [],
        merges: [],
      }
    : proposed;
  const changed: Key[] = [];
  const discovered: ScopeRef[] = [...desired.emits];
  const entities = new Set<string>();
  const touch = (target: ColumnRef, row: ColumnValues) => {
    changed.push(
      tableKey(target.name),
      rowKey(target.name, String(row.id)),
      tableKey(target.name),
      ...(target.keys?.(row) ?? []),
    );
    discovered.push(...(target.discovers?.(row) ?? []));
    if (target.entity) entities.add(target.entity);
  };
  const gaps: KernelGap[] = heldBaseline
    ? [
        {
          kind: "decision",
          input: "approval of the change to accepted records",
          actor: "you",
          since: null,
          until: null,
          actions: [],
          inputHash: null,
        },
      ]
    : [...desired.gaps];

  const byTarget = <T extends { target: ColumnRef }>(items: readonly T[]) => {
    const groups = new Map<string, T[]>();
    for (const item of items)
      groups.set(item.target.name, [
        ...(groups.get(item.target.name) ?? []),
        item,
      ]);
    return [...groups.values()];
  };
  for (const group of orderedInserts(diff.inserts)) {
    const target = group[0]!.target;
    const rows = group.map((entry) => ({ ...entry.values, id: entry.id }));
    await insertRecords(tx, q, target, rows);
    await q.insert(recordKey).values(
      group.map((entry) => ({
        scopeKind: scope.kind,
        scopeKey: scope.key,
        entity: recordEntity(target),
        naturalKey: entry.naturalKey,
        entityId: entry.id,
        minted: true,
      })),
    );
    for (const row of rows) touch(target, row);
  }
  if (diff.updates.length) {
    await updateRecords(q, diff.updates);
    for (const update of diff.updates) touch(update.target, update.row);
  }
  await auditApply(tx, diff);
  for (const group of byTarget(diff.removals)) {
    const target = group[0]!.target;
    await removeRecords(
      tx,
      target,
      group.map((entry) => entry.id),
    );
    await q.execute(sql`
      DELETE FROM "RecordKey" WHERE "scopeKind" = ${scope.kind} AND "scopeKey" = ${scope.key}
        AND entity = ${recordEntity(target)}
        AND "entityId" IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(group.map((entry) => entry.id))}::jsonb))`);
    for (const entry of group) touch(target, entry.row ?? { id: entry.id });
  }
  for (const rejection of diff.rejections)
    await markRejected(q, recordEntity(rejection.target), rejection.id);
  for (const merge of diff.merges) {
    const verdict = await mergeRecords(tx, registry, {
      target: merge.target,
      a: merge.survivorId,
      b: merge.absorbedId,
      basis: merge.basis,
    });
    if (verdict.merged) {
      changed.push(...verdict.keys);
      discovered.push(...verdict.scopes);
      if (merge.target.entity) entities.add(merge.target.entity);
      continue;
    }
    const entity = recordEntity(merge.target);
    const [first, second] = [
      recordSubject(entity, merge.survivorId),
      recordSubject(entity, merge.absorbedId),
    ].sort();
    gaps.push({
      kind: "decision",
      input: "whether these two records are the same",
      actor: "you",
      since: null,
      until: null,
      inputHash: null,
      actions: [
        {
          channel: "identity",
          kind: "same",
          subject: first!,
          field: second!,
          label: "Same record",
        },
        {
          channel: "identity",
          kind: "distinct",
          subject: first!,
          field: second!,
          label: "Different records",
        },
      ],
    });
  }
  if (diff.bindingsRemove.length) {
    await q.execute(sql`
      DELETE FROM "EvidenceBinding" b USING jsonb_to_recordset(${JSON.stringify(
        diff.bindingsRemove.map((entry) => ({
          kind: entry.fact.kind,
          id: entry.fact.id,
          basis: entry.basis,
        })),
      )}::jsonb) AS r(kind text, id text, basis text)
      WHERE b."factKind" = r.kind AND b."factId" = r.id AND b.basis = r.basis`);
  }
  if (diff.bindingsAdd.length)
    await q
      .insert(evidenceBinding)
      .values(
        diff.bindingsAdd.map((entry) => ({
          factKind: entry.fact.kind,
          factId: entry.fact.id,
          basis: entry.basis,
          eventKey: entry.eventKey,
          scopeKind: scope.kind,
          scopeKey: scope.key,
        })),
      )
      .onConflictDoUpdate({
        target: [
          evidenceBinding.factKind,
          evidenceBinding.factId,
          evidenceBinding.basis,
        ],
        set: {
          eventKey: sql`excluded."eventKey"`,
          scopeKind: sql`excluded."scopeKind"`,
          scopeKey: sql`excluded."scopeKey"`,
        },
      });
  for (const entry of [...diff.bindingsAdd, ...diff.bindingsRemove])
    changed.push(bindingEventKey(entry.eventKey), bindingFactKey(entry.fact));

  if (!heldBaseline) await fileAsks(q, computed);
  // An answer Cubby cannot settle alone becomes the member's gap; an unknown
  // or exhausted ask makes the scope Stuck.
  const asks = await scopeAsks(q, scope);
  const stuck = asks.some(askIsStuck);
  for (const [index, gap] of gaps.entries()) {
    const ask = gap.inputHash
      ? asks.find((entry) => entry.inputHash === gap.inputHash)
      : undefined;
    const member = ask ? askMemberGap(ask, gap.input, gap.since) : null;
    if (member) gaps[index] = member;
    else if (ask)
      gaps[index] = {
        ...gap,
        askState: askGapState(ask),
      };
  }

  // Downstream readers of the output run again; this scope never does.
  const downstream = await markDirty(q, registry, {
    keys: [...new Set(changed)],
    discovers: discovered,
    exclude: scope,
    reason: `output:${scope.kind}`,
  });
  if (downstream) await wakeAfterCommit(tx);

  await q.execute(sql`
    DELETE FROM "ScopeDep" WHERE "scopeKind" = ${scope.kind} AND "scopeKey" = ${scope.key}`);
  if (keys.length)
    await q.execute(sql`
      INSERT INTO "ScopeDep" ("scopeKind", "scopeKey", key)
      SELECT ${scope.kind}, ${scope.key}, value
      FROM jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb)`);

  const stage = resolveStage({ ended: false, stuck, working: false, gaps });
  const state = {
    version: reconciler.version,
    rules: reconciler.rules,
    gaps,
    inputs: usedInputs(computed),
    stage,
    nextActor: nextActor(gaps),
    firstGap: gaps[0]?.input ?? null,
    inputsHash: computed.inputsHash,
    durationMs: Math.round(computed.durationMs),
    errorClass: null,
    error: null,
    reconciledAt: sql`now()`,
    inputsChangedAt: claim.dirtiedAt,
  };
  await q
    .insert(scopeState)
    .values({ scopeKind: scope.kind, scopeKey: scope.key, ...state })
    .onConflictDoUpdate({
      target: [scopeState.scopeKind, scopeState.scopeKey],
      set: state,
    });
  if (!heldBaseline)
    await q.execute(sql`
    DELETE FROM "Drift" WHERE "scopeKind" = ${scope.kind} AND "scopeKey" = ${scope.key}`);
  await q.execute(sql`
    DELETE FROM "ScopeDirty" WHERE "scopeKind" = ${scope.kind} AND "scopeKey" = ${scope.key}
      AND seq = ${claim.seq} AND "claimToken" = ${claim.token}::uuid`);
  if (entities.size)
    await recordChange(tx, { kind: "source", categories: [...entities] });
  return gaps;
}

/** Record a failed run: the claim settles through the classifier; the state keeps the raw error. */
async function recordScopeFailure(
  q: Q,
  reconciler: Reconciler,
  claimed: ClaimedScope,
  error: UnparsedError,
): Promise<void> {
  const failure = await settleFailure(
    q,
    { table: "ScopeDirty", kind: claimed.kind, key: claimed.key },
    claimed.token,
    claimed.attempts,
    error,
  );
  if (failure.kind === "interrupted") return;
  const exhausted =
    (failure.kind === "failed" || failure.kind === "isolated") &&
    claimed.attempts + 1 >= MAX_SCOPE_ATTEMPTS;
  await q
    .insert(scopeState)
    .values({
      scopeKind: claimed.kind,
      scopeKey: claimed.key,
      version: reconciler.version,
      rules: reconciler.rules,
      stage: exhausted ? "stuck" : "waiting",
      errorClass: failure.kind,
      error: rawError(error),
    })
    .onConflictDoUpdate({
      target: [scopeState.scopeKind, scopeState.scopeKey],
      set: {
        errorClass: failure.kind,
        error: rawError(error),
        ...(exhausted && { stage: "stuck" as const }),
      },
    });
}

const outcome = (
  scope: ScopeRef,
  status: Outcome["status"],
  gaps: readonly KernelGap[] = [],
  error?: UnparsedError,
): Outcome => ({
  scope,
  status,
  gaps,
  ...(error !== undefined && { error: rawError(error), cause: error }),
});

/** One scope inside an open apply transaction, isolated by a savepoint. */
async function applyOne(
  tx: Database,
  registry: KernelRegistry,
  computed: Computed,
  claimed: ClaimedScope,
  options: ApplyOptions,
): Promise<Outcome> {
  const q = repositoryQueries(tx);
  const scope = computed.scope;
  if (computed.error !== null || !computed.desired) {
    await recordScopeFailure(q, computed.reconciler, claimed, computed.error);
    return outcome(scope, "failed", [], computed.error);
  }
  try {
    // The apply step alone may write owned columns; its audit rows carry
    // this scope, its version and the inputs that decided it.
    const gaps = await withKernelApply(
      {
        scope: computed.scope,
        version: computed.reconciler.version,
        inputs: usedInputs(computed),
      },
      () =>
        repositoryTransactionDatabase(tx, (inner) =>
          applyScope(inner, registry, computed, claimed, options),
        ),
    );
    return outcome(scope, gaps.length ? "waiting" : "applied", gaps);
  } catch (error) {
    if (isConflict(error)) {
      await recordConflict(q, claimed);
      return outcome(scope, "conflict");
    }
    if (error instanceof ClaimLapsedError)
      return outcome(scope, "failed", [], error);
    await recordScopeFailure(q, computed.reconciler, claimed, error);
    return outcome(scope, "failed", [], error);
  }
}

/** Settle claimed scopes whose whole apply transaction failed. */
async function settleBatchFailure(
  db: Database,
  reconciler: Reconciler,
  claimed: readonly ClaimedScope[],
  error: UnparsedError,
  mode: WriteMode,
): Promise<Outcome[]> {
  const surfaced =
    mode === "member" && findPgError(error)?.code === "55P03"
      ? new HouseholdWriteBusyError(error)
      : error;
  const q = repositoryQueries(db);
  const outcomes: Outcome[] = [];
  for (const scope of claimed) {
    await recordScopeFailure(q, reconciler, scope, surfaced);
    outcomes.push(
      outcome({ kind: scope.kind, key: scope.key }, "failed", [], surfaced),
    );
  }
  return outcomes;
}

/**
 * A scope whose record merged into another scope's survivor is Ended: it
 * writes nothing again and its runs become the survivor's, so evidence that
 * still reaches it dirties the survivor.
 */
async function redirectMergedScopes(
  db: Database,
  registry: KernelRegistry,
  reconciler: Reconciler,
  claimed: readonly ClaimedScope[],
): Promise<Map<string, Outcome>> {
  const ended = new Map<string, Outcome>();
  if (!claimed.length) return ended;
  const rows = await repositoryQueries(db).execute<{
    key: string;
    into: string;
  }>(sql`
    SELECT "scopeKey" AS key, "mergedIntoKey" AS into FROM "ScopeState"
    WHERE "scopeKind" = ${reconciler.scope} AND "mergedIntoKey" IS NOT NULL
      AND "scopeKey" IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(claimed.map((scope) => scope.key))}::jsonb))`);
  if (!rows.rows.length) return ended;
  await repositoryTransactionDatabase(db, async (tx) => {
    const q = repositoryQueries(tx);
    await markDirty(q, registry, {
      keys: [],
      discovers: rows.rows.map((row) => ({
        kind: reconciler.scope,
        key: row.into,
      })),
      reason: `merged:${reconciler.scope}`,
    });
    for (const row of rows.rows) {
      const scope = claimed.find((entry) => entry.key === row.key)!;
      await q.execute(sql`
        DELETE FROM "ScopeDirty" WHERE "scopeKind" = ${scope.kind} AND "scopeKey" = ${scope.key}
          AND "claimToken" = ${scope.token}::uuid`);
      ended.set(
        row.key,
        outcome({ kind: scope.kind, key: scope.key }, "clean"),
      );
    }
    await wakeAfterCommit(tx);
  });
  return ended;
}

/**
 * Compute claimed scopes outside any transaction, then apply them. Scopes
 * past three conflicts run locked, one per transaction.
 */
export async function runClaimedScopes(
  db: Database,
  registry: KernelRegistry,
  reconciler: Reconciler,
  claimedScopes: readonly ClaimedScope[],
  options: ApplyOptions & { mode: WriteMode; hideBaseline?: boolean },
): Promise<Outcome[]> {
  const ended = await redirectMergedScopes(
    db,
    registry,
    reconciler,
    claimedScopes,
  );
  const claimed = claimedScopes.filter((scope) => !ended.has(scope.key));
  const locked = claimed.filter(
    (scope) => scope.conflicts >= LOCKED_RUN_AFTER_CONFLICTS,
  );
  const loose = claimed.filter(
    (scope) => scope.conflicts < LOCKED_RUN_AFTER_CONFLICTS,
  );
  const outcomes: Outcome[] = [...ended.values()];
  for (const scope of locked)
    outcomes.push(await runLocked(db, registry, reconciler, scope, options));
  if (!loose.length) return outcomes;
  const computed = await computeBatch(
    repositoryQueries(db),
    registry,
    reconciler,
    loose.map((scope) => ({ kind: scope.kind, key: scope.key })),
    { db, locked: false, hideBaseline: options.hideBaseline ?? false },
  );
  return [
    ...outcomes,
    ...(await applyComputed(
      db,
      registry,
      reconciler,
      computed,
      loose,
      options,
    )),
  ];
}

/**
 * Apply computed scopes in transactions that yield the gate after 1.5 s in
 * the background money lane. `claimed[i]` is `computed[i]`'s claim.
 */
export async function applyComputed(
  db: Database,
  registry: KernelRegistry,
  reconciler: Reconciler,
  computed: readonly Computed[],
  claimed: readonly ClaimedScope[],
  options: ApplyOptions & { mode: WriteMode },
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  let index = 0;
  while (index < computed.length) {
    const start = index;
    const pending: Outcome[] = [];
    try {
      await repositoryTransactionDatabase(db, async (tx) => {
        await enterWriteTransaction(repositoryQueries(tx), {
          lane: reconciler.lane,
          mode: options.mode,
        });
        const opened = Date.now();
        do {
          pending.push(
            await applyOne(
              tx,
              registry,
              computed[index]!,
              claimed[index]!,
              options,
            ),
          );
          index++;
        } while (
          index < computed.length &&
          !(
            reconciler.lane === "money" &&
            options.mode === "background" &&
            Date.now() - opened >= BACKGROUND_GATE_YIELD_MS
          )
        );
      });
      outcomes.push(...pending);
    } catch (error) {
      // The whole transaction rolled back: every scope from `start` is unapplied.
      outcomes.push(
        ...(await settleBatchFailure(
          db,
          reconciler,
          claimed.slice(start),
          error,
          options.mode,
        )),
      );
      break;
    }
  }
  return outcomes;
}

/**
 * The fallback after three conflicts: take the gate (money), then load with
 * each key's revision row held, lock the dirty row, compute and apply, all in
 * one bounded transaction. Producer calls never happen here: a missing answer
 * is filed as an ask.
 */
async function runLocked(
  db: Database,
  registry: KernelRegistry,
  reconciler: Reconciler,
  claimed: ClaimedScope,
  options: ApplyOptions & { mode: WriteMode; hideBaseline?: boolean },
): Promise<Outcome> {
  const scope = { kind: claimed.kind, key: claimed.key };
  try {
    return await repositoryTransactionDatabase(db, async (tx) => {
      const q = repositoryQueries(tx);
      await enterWriteTransaction(q, {
        lane: reconciler.lane,
        mode: options.mode,
      });
      const [computed] = await computeBatch(q, registry, reconciler, [scope], {
        db: tx,
        locked: true,
        hideBaseline: options.hideBaseline ?? false,
      });
      const fence = await q.execute<{
        seq: string | number;
        live: boolean;
      }>(sql`
        SELECT seq, ("claimToken" = ${claimed.token}::uuid AND "claimDeadline" > now()) AS live
        FROM "ScopeDirty" WHERE "scopeKind" = ${scope.kind} AND "scopeKey" = ${scope.key}
        FOR UPDATE`);
      const row = fence.rows[0];
      if (!row?.live) throw new ClaimLapsedError();
      return applyOne(
        tx,
        registry,
        computed!,
        { ...claimed, seq: Number(row.seq) },
        options,
      );
    });
  } catch (error) {
    const [failed] = await settleBatchFailure(
      db,
      reconciler,
      [claimed],
      error,
      options.mode,
    );
    return failed!;
  }
}
