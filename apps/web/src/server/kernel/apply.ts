import type { KernelAuditProvenance } from "@cubby/schemas/kernel/machinery";
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
import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db/database";
import { withDatabaseOperationPhase } from "~/server/db/db-observability";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { orderedTextArrayParam } from "~/server/db/helpers/array-param";
import { withKernelApply } from "~/server/db/kernel-apply-context";
import {
  evidenceBinding,
  recordKey,
  scopeState,
} from "~/server/db/kernel-schema";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
  type RepositoryQueryClient,
} from "~/server/db/repository-access.boundary";
import { isShortcodeEntity } from "~/server/entity-kernel/repo/entity-identity";
import { isEntityShortcodeCollision } from "~/server/entity-kernel/repo/entity-identity-writer";
import { findPgError } from "~/server/errors/db-errors";
import { recordChange } from "~/server/generic/changes/repo/change";
import { classifyWorkFailure } from "~/server/kernel/failure";
import { WorkTargetError } from "~/server/kernel/work-errors";

import {
  askGapState,
  askIsStuck,
  askMemberGap,
  type AskCondition,
} from "./ask-gap";
import { auditApply } from "./audit";
import { insertRows, physicalValues } from "./bulk-write";
import {
  ClaimLapsedError,
  LOCKED_RUN_AFTER_CONFLICTS,
  MAX_SCOPE_ATTEMPTS,
  rawError,
  renewScopeClaims,
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
  IndexChange,
  Outcome,
  Reconciler,
  ScopeRef,
} from "./define";
import { difference, type Difference } from "./diff";
import { insertFactKeys, lockKeyRevs, markDirty } from "./dirty";
import { recordDrifts } from "./drift";
import {
  enterWriteTransaction,
  HouseholdWriteBusyError,
  type WriteMode,
} from "./gate";
import { heldBaselineGap } from "./held-gap";
import { mergeRecords, removeRecords } from "./identity";
import {
  indexFacts,
  membershipKeys,
  relatedMemberships,
  rowIndexKeys,
} from "./index-keys";
import {
  canonicalJson,
  decisionKey,
  columnKey,
  bindingEventKey,
  bindingFactKey,
  recordSubject,
  rowKey,
  tableKey,
} from "./keys";
import { KernelContractError, LockedReadChangedError } from "./reads";
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

/** Baseline-hidden computations of held scopes, by scope id. */
type Proposals = ReadonlyMap<string, Computed>;

const isConflict = (error: UnparsedError) =>
  error instanceof KernelConflict ||
  error instanceof LockedReadChangedError ||
  isEntityShortcodeCollision(error, "Entity") ||
  ["40001", "40P01", "55P03"].includes(findPgError(error)?.code ?? "");

/** The tables of the new rows `entry` references by id, among `pending`. */
function newReferences(
  entry: Difference["inserts"][number],
  pending: ReadonlyMap<string, unknown>,
): string[] {
  const columns = getTableColumns(entry.target.table);
  return getTableConfig(entry.target.table).foreignKeys.flatMap((fk) => {
    const reference = fk.reference();
    const foreign = getTableName(reference.foreignTable);
    return reference.columns.flatMap((column, index) => {
      if (reference.foreignColumns[index]?.name !== "id") return [];
      const property = Object.keys(columns).find(
        (key) => columns[key]!.name === column.name,
      );
      return property &&
        pending.has(`${foreign}:${String(entry.values[property])}`)
        ? [foreign]
        : [];
    });
  });
}

/**
 * Foreign keys order the inserts: one statement per table in table order, and
 * dependency waves within a table that links to its own new rows. Row waves
 * order everything when the new rows' tables reference each other in a cycle.
 */
function orderedInserts(
  inserts: Difference["inserts"],
): Difference["inserts"][] {
  const all = new Map(
    inserts.map((entry) => [`${entry.target.name}:${entry.id}`, entry]),
  );
  const tables = new Map<string, Difference["inserts"]>();
  const after = new Map<string, Set<string>>();
  for (const entry of inserts) {
    const rows = tables.get(entry.target.name) ?? [];
    rows.push(entry);
    tables.set(entry.target.name, rows);
    const needs = after.get(entry.target.name) ?? new Set<string>();
    for (const table of newReferences(entry, all))
      if (table !== entry.target.name) needs.add(table);
    after.set(entry.target.name, needs);
  }
  const groups: Difference["inserts"][] = [];
  const done = new Set<string>();
  while (done.size < tables.size) {
    const ready = [...tables.keys()].filter(
      (table) =>
        !done.has(table) && [...after.get(table)!].every((d) => done.has(d)),
    );
    if (!ready.length) return insertWaves(inserts);
    for (const table of ready) {
      done.add(table);
      groups.push(...insertWaves(tables.get(table)!));
    }
  }
  return groups;
}

/** Dependency waves preserve foreign keys, including links within one table. */
function insertWaves(inserts: Difference["inserts"]): Difference["inserts"][] {
  const pending = new Map(
    inserts.map((entry) => [`${entry.target.name}:${entry.id}`, entry]),
  );
  const groups: Difference["inserts"][] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter(
      (entry) => !newReferences(entry, pending).length,
    );
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
  const tables = new Map<string, Map<string, Difference["updates"][number]>>();
  for (const entry of updates) {
    const rows = tables.get(entry.target.name) ?? new Map();
    const existing = rows.get(entry.id);
    if (existing) {
      for (const [column, value] of Object.entries(entry.set))
        if (
          Object.hasOwn(existing.set, column) &&
          canonicalJson(existing.set[column]) !== canonicalJson(value)
        )
          throw new KernelContractError(
            `Conflicting declarations for ${entry.target.name}.${column}`,
          );
      rows.set(entry.id, {
        ...entry,
        set: { ...existing.set, ...entry.set },
        seen: { ...existing.seen, ...entry.seen },
      });
    } else rows.set(entry.id, entry);
    tables.set(entry.target.name, rows);
  }
  for (const table of tables.values()) {
    const group = [...table.values()];
    const target = group[0]!.target;
    const columns = getTableColumns(target.table);
    const props = [
      ...new Set(group.flatMap((entry) => Object.keys(entry.set))),
    ].sort();
    const rows = group.map((entry) => ({
      id: entry.id,
      nextValues: physicalValues(target.table, entry.set),
      seen: physicalValues(target.table, entry.seen),
    }));
    const sets = props.map((prop) => {
      const name = columns[prop]!.name;
      return sql`${sql.identifier(name)} = CASE WHEN incoming.value->'nextValues' ? ${name} THEN desired.${sql.identifier(name)} ELSE t.${sql.identifier(name)} END`;
    });
    const conditions = props.map((prop) => {
      const name = columns[prop]!.name;
      return sql`(NOT (incoming.value->'seen' ? ${name}) OR t.${sql.identifier(name)} IS NOT DISTINCT FROM seen.${sql.identifier(name)})`;
    });
    const touched =
      columns.updatedAt && !props.includes("updatedAt")
        ? sql`, "updatedAt" = now()`
        : sql``;
    const result = await q.execute<{ id: string }>(sql`
      UPDATE ${target.table} t SET ${sql.join(sets, sql`, `)}${touched}
      FROM jsonb_array_elements(${canonicalJson(rows)}::jsonb) AS incoming(value)
      CROSS JOIN LATERAL jsonb_populate_record(NULL::${target.table}, incoming.value->'nextValues') AS desired
      CROSS JOIN LATERAL jsonb_populate_record(NULL::${target.table}, incoming.value->'seen') AS seen
      WHERE t.id = (incoming.value->>'id')::uuid AND ${sql.join(conditions, sql` AND `)} RETURNING t.id`);
    if (result.rows.length !== group.length)
      throw new KernelConflict(
        `${target.name}: a record changed since the load`,
      );
  }
}

/** A new record whose supplied values all cite current Decisions. */
function citesDecisions(
  computed: Computed,
  insert: Difference["inserts"][number],
): boolean {
  const decisionIds = new Set(
    computed.decisions.map((decision) => decision.id),
  );
  const record = computed.desired!.records.find(
    (record) =>
      record.target.name === insert.target.name &&
      record.naturalKey === insert.naturalKey,
  );
  return (
    !!record &&
    Object.keys(record.values).every((field) =>
      decisionIds.has(record.provenance[field] ?? ""),
    )
  );
}

function holdsBaseline(
  computed: Computed,
  proposed: Difference,
  options: ApplyOptions,
): boolean {
  const desired = computed.desired!;
  const decisionIds = new Set(
    computed.decisions.map((decision) => decision.id),
  );
  return (
    desired.disagreements.length > 0 ||
    (!options.releaseBaseline &&
      computed.storedBindings.some((binding) => binding.basis === "baseline") &&
      (proposed.inserts.some((insert) => !citesDecisions(computed, insert)) ||
        proposed.removals.some(
          (removal) => !decisionIds.has(removal.decision ?? ""),
        ) ||
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
        )))
  );
}

/**
 * A held scope still applies what current Decisions supply: field updates
 * citing them, new records whose values all cite them, removals they require,
 * and decision-basis bindings with the decision binding each replaces.
 */
function decisionUpdates(computed: Computed, proposed: Difference): Difference {
  const decisionIds = new Set(
    computed.decisions.map((decision) => decision.id),
  );
  const records = computed.desired!.records;
  const result = emptyDifference();
  for (const update of proposed.updates) {
    const record = records.find(
      (record) =>
        record.target.name === update.target.name && record.id === update.id,
    );
    const fields = Object.keys(update.set).filter((field) =>
      decisionIds.has(record?.provenance[field] ?? ""),
    );
    if (!fields.length) continue;
    const set = Object.fromEntries(
      fields.map((field) => [field, update.set[field]]),
    );
    result.updates.push({
      ...update,
      set,
      seen: Object.fromEntries(
        fields.map((field) => [field, update.seen[field]]),
      ),
      row: { ...update.row, ...update.seen, ...set },
    });
  }
  // A carried record never references a new record that stays held.
  let inserts = proposed.inserts.filter((insert) =>
    citesDecisions(computed, insert),
  );
  for (let size = -1; size !== inserts.length;) {
    size = inserts.length;
    const held = new Set(
      proposed.inserts
        .filter((insert) => !inserts.includes(insert))
        .map((insert) => insert.id),
    );
    inserts = inserts.filter(
      (insert) =>
        !Object.values(insert.values).some(
          (value) => typeof value === "string" && held.has(value),
        ),
    );
  }
  result.inserts = inserts;
  result.removals = proposed.removals.filter((removal) =>
    decisionIds.has(removal.decision ?? ""),
  );
  const fact = (entry: { fact: { kind: string; id: string } }) =>
    `${entry.fact.kind}:${entry.fact.id}`;
  result.bindingsAdd = proposed.bindingsAdd.filter(
    (binding) => binding.basis === "decision",
  );
  const replaced = new Set(result.bindingsAdd.map(fact));
  result.bindingsRemove = proposed.bindingsRemove.filter(
    (binding) => binding.basis === "decision" && replaced.has(fact(binding)),
  );
  return result;
}

/** What remains of a proposed difference once a held scope applies its decision changes. */
function withoutApplied(proposed: Difference, applied: Difference): Difference {
  const binding = (entry: Difference["bindingsRemove"][number]) =>
    `${entry.fact.kind}:${entry.fact.id}:${entry.basis}:${entry.eventKey}`;
  const added = new Set(applied.bindingsAdd.map(binding));
  const unbound = new Set(applied.bindingsRemove.map(binding));
  const inserted = new Set(
    applied.inserts.map((entry) => `${entry.target.name}:${entry.naturalKey}`),
  );
  const removed = new Set(
    applied.removals.map((entry) => `${entry.target.name}:${entry.id}`),
  );
  return {
    ...proposed,
    inserts: proposed.inserts.filter(
      (entry) => !inserted.has(`${entry.target.name}:${entry.naturalKey}`),
    ),
    updates: proposed.updates.flatMap((entry) => {
      const done = applied.updates.find(
        (update) =>
          update.target.name === entry.target.name && update.id === entry.id,
      );
      const columns = Object.keys(entry.set).filter(
        (column) =>
          !done ||
          !Object.hasOwn(done.set, column) ||
          canonicalJson(done.set[column]) !== canonicalJson(entry.set[column]),
      );
      if (!columns.length) return [];
      const pick = (values: ColumnValues) =>
        Object.fromEntries(columns.map((column) => [column, values[column]]));
      return [{ ...entry, set: pick(entry.set), seen: pick(entry.seen) }];
    }),
    bindingsAdd: proposed.bindingsAdd.filter(
      (entry) => !added.has(binding(entry)),
    ),
    removals: proposed.removals.filter(
      (entry) => !removed.has(`${entry.target.name}:${entry.id}`),
    ),
    bindingsRemove: proposed.bindingsRemove.filter(
      (entry) => !unbound.has(binding(entry)),
    ),
  };
}

type Plan = {
  computed: Computed;
  claim: ClaimedScope;
  diff: Difference;
  heldBaseline: boolean;
  gaps: KernelGap[];
};

const emptyDifference = (): Difference => ({
  inserts: [],
  updates: [],
  removals: [],
  rejections: [],
  bindingsAdd: [],
  bindingsRemove: [],
  merges: [],
});
const scopeId = (scope: ScopeRef) => `${scope.kind}\u0000${scope.key}`;

/** Output membership keys are known from the plan, before any dirty claim is locked. */
function plannedKeys(
  computed: readonly Computed[],
  options: ApplyOptions,
  registry: KernelRegistry,
): Key[] {
  const keys = new Set<Key>();
  const touch = (target: ColumnRef, row: ColumnValues) => {
    keys.add(tableKey(target.name));
    for (const column of [...target.columns, ...(target.createOnly ?? [])])
      keys.add(columnKey(target.name, column));
    keys.add(rowKey(target.name, String(row.id)));
    keys.add(`record:${recordEntity(target)}:${String(row.id)}`);
    for (const key of target.keys?.(row) ?? []) keys.add(key);
    for (const key of rowIndexKeys(registry, target.name, row)) keys.add(key);
  };
  for (const item of computed) {
    if (!item.desired || item.error) continue;
    for (const attachment of item.desired.attachments ?? [])
      keys.add(`record:${recordEntity(attachment.target)}:${attachment.id}`);
    const diff = difference(item, options);
    for (const entry of diff.inserts)
      touch(entry.target, { ...entry.values, id: entry.id });
    for (const entry of diff.updates) {
      touch(entry.target, entry.row);
      touch(entry.target, { ...entry.row, ...entry.seen });
    }
    for (const entry of diff.removals)
      touch(entry.target, entry.row ?? { id: entry.id });
    for (const entry of [...diff.bindingsAdd, ...diff.bindingsRemove]) {
      keys.add(bindingEventKey(entry.eventKey));
      keys.add(bindingFactKey(entry.fact));
    }
    for (const entry of diff.merges) {
      keys.add(tableKey(entry.target.name));
      for (const id of [entry.survivorId, entry.absorbedId]) {
        keys.add(rowKey(entry.target.name, id));
        keys.add(decisionKey(recordSubject(recordEntity(entry.target), id)));
      }
      for (const binding of item.storedBindings) {
        keys.add(bindingEventKey(binding.eventKey));
        keys.add(bindingFactKey(binding.fact));
      }
    }
  }
  return [...keys];
}

/** A merge can move bindings owned by other scopes; fence those keys before dirty claims too. */
async function mergeOutputKeys(
  q: Q,
  computed: readonly Computed[],
  options: ApplyOptions,
): Promise<Key[]> {
  const merges = computed.flatMap((item) =>
    item.desired && !item.error
      ? difference(item, options).merges.map((merge) => ({
          entity: recordEntity(merge.target),
          ids: [merge.survivorId, merge.absorbedId],
        }))
      : [],
  );
  if (!merges.length) return [];
  const result = await q.execute<{
    event: string;
    kind: string | null;
    id: string | null;
  }>(sql`
    SELECT DISTINCT k."scopeKey" AS event, b."factKind" AS kind, b."factId" AS id
    FROM jsonb_to_recordset(${JSON.stringify(merges)}::jsonb) AS m(entity text, ids jsonb)
    JOIN "RecordKey" k ON k.entity=m.entity AND k."entityId"::text IN (SELECT jsonb_array_elements_text(m.ids))
    LEFT JOIN "EvidenceBinding" b ON b."eventKey"=k."scopeKey"`);
  return result.rows.flatMap((row) => [
    bindingEventKey(row.event),
    ...(row.kind && row.id
      ? [bindingFactKey({ kind: row.kind, id: row.id })]
      : []),
  ]);
}

function indexChanges(
  computed: readonly Computed[],
  options: ApplyOptions,
): IndexChange[] {
  return computed.flatMap((item) =>
    !item.desired || item.error ? [] : changesOf(difference(item, options)),
  );
}

function changesOf(diff: Difference): IndexChange[] {
  return [
    ...diff.inserts.map((entry) => ({
      table: entry.target.name,
      id: entry.id,
      before: null,
      after: { ...entry.values, id: entry.id },
    })),
    ...diff.updates.map((entry) => ({
      table: entry.target.name,
      id: entry.id,
      before: { ...entry.row, ...entry.seen },
      after: entry.row,
    })),
    ...diff.removals.map((entry) => ({
      table: entry.target.name,
      id: entry.id,
      before: entry.row,
      after: null,
    })),
  ];
}
/** Lock the union once, then compare every scope against that one input fence. */
async function fenceBatch(
  q: Q,
  computed: readonly Computed[],
  claimed: readonly ClaimedScope[],
  outputKeys: readonly Key[],
) {
  const keys = [
    ...new Set([
      ...computed.flatMap((item) => [...item.keys.keys()]),
      ...outputKeys,
    ]),
  ].sort();
  const revisions = await lockKeyRevs(q, keys);
  const rows = await q.execute<{
    kind: string;
    key: string;
    seq: string | number;
    live: boolean;
  }>(sql`
    SELECT d."scopeKind" AS kind, d."scopeKey" AS key, d.seq,
      (d."claimToken" = wanted.token::uuid AND d."claimDeadline" > now()) AS live
    FROM "ScopeDirty" d JOIN unnest(
      ${orderedTextArrayParam(claimed.map((item) => item.kind))},
      ${orderedTextArrayParam(claimed.map((item) => item.key))},
      ${orderedTextArrayParam(claimed.map((item) => item.token))}
    ) AS wanted(kind, key, token) ON d."scopeKind" = wanted.kind AND d."scopeKey" = wanted.key
    ORDER BY d."scopeKind", d."scopeKey" FOR UPDATE OF d`);
  const current = new Map(rows.rows.map((row) => [scopeId(row), row]));
  const active: { computed: Computed; claim: ClaimedScope }[] = [];
  const conflicted: ClaimedScope[] = [];
  const outcomes: Outcome[] = [];
  for (const [index, item] of computed.entries()) {
    const claim = claimed[index]!;
    const row = current.get(scopeId(item.scope));
    if (!row?.live) {
      outcomes.push(outcome(item.scope, "failed", [], new ClaimLapsedError()));
      continue;
    }
    if (
      Number(row.seq) !== claim.seq ||
      [...item.keys].some(([key, seen]) => (revisions.get(key) ?? 0) !== seen)
    ) {
      conflicted.push(claim);
      outcomes.push(outcome(item.scope, "conflict"));
      continue;
    }
    active.push({ computed: item, claim });
  }
  if (conflicted.length) await releaseConflicts(q, conflicted);
  return { active, outcomes };
}

/** One retry mutation for a batch; a conflict spends no attempt. */
async function releaseConflicts(q: Q, claims: readonly ClaimedScope[]) {
  if (!claims.length) return;
  await q.execute(sql`
    UPDATE "ScopeDirty" d SET "claimToken" = NULL, "claimDeadline" = NULL, conflicts = d.conflicts + 1
    FROM unnest(${orderedTextArrayParam(claims.map((item) => item.kind))}, ${orderedTextArrayParam(claims.map((item) => item.key))}, ${orderedTextArrayParam(claims.map((item) => item.token))}) AS wanted(kind, key, token)
    WHERE d."scopeKind" = wanted.kind AND d."scopeKey" = wanted.key AND d."claimToken" = wanted.token::uuid`);
}

/** Queue the union of missing envelopes and replace all scope links together. */
async function fileBatchAsks(q: Q, plans: readonly Plan[]) {
  const active = plans.filter((plan) => !plan.heldBaseline);
  if (!active.length) return;
  const wanted = active.flatMap(({ computed }) =>
    computed.missing.map((missing) => ({
      scopeKind: computed.scope.kind,
      scopeKey: computed.scope.key,
      inputHash: missing.inputHash,
      feature: missing.kind.feature,
      producer: missing.kind.producer,
      promptVersion: missing.kind.promptVersion,
      input: missing.envelope,
      maxAttempts: missing.kind.maxAttempts,
    })),
  );
  if (wanted.length)
    await q.execute(sql`
    WITH wanted AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(wanted)}::jsonb) AS w(
        "scopeKind" text, "scopeKey" text, "inputHash" text, feature text, producer text, "promptVersion" text, input jsonb, "maxAttempts" int)
    ), inserted AS (
      INSERT INTO "Ask" ("inputHash", feature, producer, "promptVersion", input, "maxAttempts")
      SELECT DISTINCT ON ("inputHash") "inputHash", feature, producer, "promptVersion", input, "maxAttempts" FROM wanted
      ON CONFLICT ("inputHash") DO NOTHING RETURNING id, "inputHash"
    )
    INSERT INTO "AskScope" ("askId", "scopeKind", "scopeKey")
    SELECT coalesce(inserted.id, existing.id), wanted."scopeKind", wanted."scopeKey" FROM wanted
    LEFT JOIN inserted USING ("inputHash") LEFT JOIN "Ask" existing USING ("inputHash")
    ON CONFLICT DO NOTHING`);
  await q.execute(sql`
    DELETE FROM "AskScope" links USING unnest(${orderedTextArrayParam(active.map((plan) => plan.computed.scope.kind))}, ${orderedTextArrayParam(active.map((plan) => plan.computed.scope.key))}) AS scopes(kind, key)
    WHERE links."scopeKind" = scopes.kind AND links."scopeKey" = scopes.key
      AND NOT EXISTS (
        SELECT 1 FROM "Ask" a JOIN jsonb_to_recordset(${JSON.stringify(wanted)}::jsonb) AS w("scopeKind" text, "scopeKey" text, "inputHash" text) ON a."inputHash" = w."inputHash"
        WHERE a.id = links."askId" AND w."scopeKind" = scopes.kind AND w."scopeKey" = scopes.key
      )`);
}

/** One state read for every pending ask of this batch. */
async function batchAsks(q: Q, plans: readonly Plan[]) {
  const result = await q.execute<
    AskCondition & { kind: string; key: string }
  >(sql`
    SELECT s."scopeKind" AS kind, s."scopeKey" AS key, a."inputHash", a.state, a.attempts, a."maxAttempts", a."cancelledAt" IS NOT NULL AS cancelled
    FROM "AskScope" s JOIN "Ask" a ON a.id = s."askId"
    JOIN unnest(${orderedTextArrayParam(plans.map((plan) => plan.computed.scope.kind))}, ${orderedTextArrayParam(plans.map((plan) => plan.computed.scope.key))}) AS wanted(kind, key)
      ON s."scopeKind" = wanted.kind AND s."scopeKey" = wanted.key`);
  const byScope = new Map<string, AskCondition[]>();
  for (const row of result.rows) {
    const id = scopeId(row);
    const list = byScope.get(id) ?? [];
    list.push(row);
    byScope.set(id, list);
  }
  return byScope;
}

/**
 * An input-triggered run keeps accepted baselines. A scope it holds is
 * proposed from the computation approval applies: baseline hidden, then
 * released. Computed before the apply transaction opens.
 */
async function heldProposals(
  db: Database,
  registry: KernelRegistry,
  reconciler: Reconciler,
  computed: readonly Computed[],
  options: ApplyOptions,
): Promise<Proposals> {
  if (options.releaseBaseline) return new Map();
  const held = computed.filter((item) => {
    if (item.error !== null || !item.desired) return false;
    if (item.desired.disagreements.length) return false;
    try {
      return holdsBaseline(item, difference(item, options), options);
    } catch {
      // SILENT: the apply reports this scope's contract error itself.
      return false;
    }
  });
  if (!held.length) return new Map();
  const hidden = await computeBatch(
    repositoryQueries(db),
    registry,
    reconciler,
    held.map((item) => item.scope),
    { db, locked: false, hideBaseline: true },
  );
  return new Map(hidden.map((item) => [scopeId(item.scope), item]));
}

/** One coherent batch publishes against the same locked input snapshot. */
async function applyBatch(
  tx: Database,
  registry: KernelRegistry,
  computed: readonly Computed[],
  claims: readonly ClaimedScope[],
  options: ApplyOptions,
  proposals: Proposals,
): Promise<Outcome[]> {
  const q = repositoryQueries(tx);
  const membershipsBefore = await relatedMemberships(
    tx,
    registry,
    indexChanges(computed, options),
  );
  const fenced = await fenceBatch(q, computed, claims, [
    ...plannedKeys(computed, options, registry),
    ...membershipKeys(membershipsBefore, false),
    ...(await mergeOutputKeys(q, computed, options)),
  ]);
  const plans: Plan[] = [];
  const drifts: { computed: Computed; diff: Difference }[] = [];
  const outcomes = [...fenced.outcomes];
  for (const item of fenced.active) {
    if (isConflict(item.computed.error)) {
      await releaseConflicts(q, [item.claim]);
      outcomes.push(outcome(item.computed.scope, "conflict"));
      continue;
    }
    if (item.computed.error !== null || !item.computed.desired) {
      await recordScopeFailure(
        q,
        item.computed.reconciler,
        item.claim,
        item.computed.error,
      );
      outcomes.push(
        outcome(item.computed.scope, "failed", [], item.computed.error),
      );
      continue;
    }
    const proposed = difference(item.computed, options);
    const heldBaseline = holdsBaseline(item.computed, proposed, options);
    const diff = heldBaseline
      ? decisionUpdates(item.computed, proposed)
      : proposed;
    plans.push({
      ...item,
      diff,
      heldBaseline,
      gaps: heldBaseline
        ? [heldBaselineGap()]
        : [...item.computed.desired.gaps],
    });
    // A disagreement is shown as computed and cannot be approved. Otherwise
    // approval releases the baseline itself, and an input-triggered hold
    // shows the baseline-released computation approval applies, without the
    // decision changes this apply makes, or nothing it cannot apply.
    const disagrees = item.computed.desired.disagreements.length > 0;
    const shown =
      options.releaseBaseline || disagrees
        ? item.computed
        : proposals.get(scopeId(item.computed.scope));
    if (heldBaseline && shown?.desired && shown.error === null)
      drifts.push({
        computed: shown,
        diff: disagrees
          ? proposed
          : withoutApplied(difference(shown, { releaseBaseline: true }), diff),
      });
  }
  if (!plans.length) return outcomes;
  await withDatabaseOperationPhase("apply", () => recordDrifts(q, drifts));
  const combined = emptyDifference();
  for (const plan of plans) {
    combined.inserts.push(...plan.diff.inserts);
    combined.updates.push(...plan.diff.updates);
    combined.removals.push(...plan.diff.removals);
    combined.rejections.push(...plan.diff.rejections);
    combined.bindingsAdd.push(...plan.diff.bindingsAdd);
    combined.bindingsRemove.push(...plan.diff.bindingsRemove);
    combined.merges.push(...plan.diff.merges);
  }
  const recordKeys = plans.flatMap((plan) =>
    [
      ...plan.diff.inserts.map((entry) => ({ ...entry, minted: true })),
      ...(plan.computed.desired!.attachments ?? []).map((entry) => ({
        ...entry,
        minted: false,
      })),
    ].map((entry) => ({
      scopeKind: plan.computed.scope.kind,
      scopeKey: plan.computed.scope.key,
      entity: recordEntity(entry.target),
      naturalKey: entry.naturalKey,
      entityId: entry.id,
      minted: entry.minted,
    })),
  );
  const uniqueInserts = new Map<string, Difference["inserts"][number]>();
  for (const entry of combined.inserts) {
    const slot = `${entry.target.name}:${entry.id}`;
    const previous = uniqueInserts.get(slot);
    if (
      previous &&
      (!entry.target.coalesceCreation ||
        canonicalJson(previous.values) !== canonicalJson(entry.values))
    )
      throw new KernelContractError(
        "Two scopes declare conflicting values for one new record",
      );
    uniqueInserts.set(slot, entry);
  }
  combined.inserts = [...uniqueInserts.values()];
  const provenance = new Map<string, KernelAuditProvenance>();
  for (const { computed } of plans) {
    const source = {
      scope: computed.scope,
      version: computed.reconciler.version,
      inputs: usedInputs(computed),
    };
    for (const target of [
      ...computed.owned.map((row) => ({
        target: row.target,
        id: row.entityId,
      })),
      ...computed.desired!.records,
      ...computed.desired!.patches,
    ])
      if (!provenance.has(`${recordEntity(target.target)}:${target.id}`))
        provenance.set(`${recordEntity(target.target)}:${target.id}`, source);
  }
  const changed = new Set<Key>(
    plans.flatMap((plan) =>
      (plan.computed.desired!.attachments ?? []).map(
        (attachment) =>
          `record:${recordEntity(attachment.target)}:${attachment.id}`,
      ),
    ),
  );
  const discovered: ScopeRef[] = plans.flatMap((plan) => [
    ...plan.computed.desired!.emits,
  ]);
  const entities = new Set<string>();
  const touch = (target: ColumnRef, row: ColumnValues) => {
    changed.add(tableKey(target.name));
    for (const column of [...target.columns, ...(target.createOnly ?? [])])
      changed.add(columnKey(target.name, column));
    changed.add(rowKey(target.name, String(row.id)));
    changed.add(`record:${recordEntity(target)}:${String(row.id)}`);
    for (const key of target.keys?.(row) ?? []) changed.add(key);
    for (const key of rowIndexKeys(registry, target.name, row))
      changed.add(key);
    discovered.push(...(target.discovers?.(row) ?? []));
    if (target.entity) entities.add(target.entity);
  };
  await withKernelApply(
    null,
    () =>
      withDatabaseOperationPhase("apply", async () => {
        const now = new Date();
        const identities = combined.inserts.flatMap((entry) =>
          entry.target.entity && isShortcodeEntity(entry.target.entity)
            ? [
                {
                  id: entry.id,
                  kind: entry.target.entity,
                  shortcode: entry.values.shortcode,
                  createdAt: now,
                  deletedAt: null,
                },
              ]
            : [],
        );
        await insertRows(q, entityIdentity, identities);
        for (const group of orderedInserts(combined.inserts)) {
          const rows = group.map((entry) => ({
            ...entry.values,
            id: entry.id,
            ...(entry.target.entity ? { createdAt: now, deletedAt: null } : {}),
          }));
          await insertRows(q, group[0]!.target.table, rows);
          for (const row of rows) touch(group[0]!.target, row);
        }
        await insertRows(q, recordKey, recordKeys);
        await insertFactKeys(
          q,
          combined.inserts.flatMap((entry) =>
            indexFacts(registry, entry.target.name, [
              { ...entry.values, id: entry.id },
            ]),
          ),
        );
        await updateRecords(q, combined.updates);
        for (const entry of combined.updates) {
          touch(entry.target, { ...entry.row, ...entry.seen });
          touch(entry.target, entry.row);
        }
        await auditApply(tx, combined);
        const removals = new Map<string, Difference["removals"]>();
        for (const entry of combined.removals)
          removals.set(entry.target.name, [
            ...(removals.get(entry.target.name) ?? []),
            entry,
          ]);
        for (const group of removals.values()) {
          await removeRecords(
            tx,
            group[0]!.target,
            group.map((entry) => entry.id),
          );
          for (const entry of group)
            touch(entry.target, entry.row ?? { id: entry.id });
        }
        if (combined.removals.length)
          await q.execute(sql`
      DELETE FROM "RecordKey" k USING jsonb_to_recordset(${JSON.stringify(plans.flatMap((plan) => plan.diff.removals.map((entry) => ({ kind: plan.computed.scope.kind, key: plan.computed.scope.key, entity: recordEntity(entry.target), id: entry.id }))))}::jsonb) AS r(kind text, key text, entity text, id uuid)
      WHERE k."scopeKind" = r.kind AND k."scopeKey" = r.key AND k.entity = r.entity AND k."entityId" = r.id`);
        if (combined.rejections.length)
          await q.execute(sql`
      UPDATE "RecordKey" k SET "rejectedAt" = coalesce(k."rejectedAt", now())
      FROM jsonb_to_recordset(${JSON.stringify(combined.rejections.map((entry) => ({ entity: recordEntity(entry.target), id: entry.id })))}::jsonb) AS r(entity text, id uuid)
      WHERE k.entity = r.entity AND k."entityId" = r.id`);
        for (const plan of plans)
          for (const merge of plan.diff.merges) {
            const verdict = await mergeRecords(tx, registry, {
              target: merge.target,
              a: merge.survivorId,
              b: merge.absorbedId,
              basis: merge.basis,
            });
            if (verdict.merged) {
              for (const key of verdict.keys) changed.add(key);
              discovered.push(...verdict.scopes);
              if (merge.target.entity) entities.add(merge.target.entity);
            } else {
              const [first, second] = [
                recordSubject(recordEntity(merge.target), merge.survivorId),
                recordSubject(recordEntity(merge.target), merge.absorbedId),
              ].sort();
              plan.gaps.push({
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
          }
        if (combined.bindingsRemove.length)
          await q.execute(sql`
      DELETE FROM "EvidenceBinding" b USING jsonb_to_recordset(${JSON.stringify(combined.bindingsRemove.map((entry) => ({ kind: entry.fact.kind, id: entry.fact.id, basis: entry.basis })))}::jsonb) AS r(kind text, id text, basis text)
      WHERE b."factKind" = r.kind AND b."factId" = r.id AND b.basis = r.basis`);
        await insertRows(
          q,
          evidenceBinding,
          plans.flatMap((plan) =>
            plan.diff.bindingsAdd.map((entry) => ({
              factKind: entry.fact.kind,
              factId: entry.fact.id,
              basis: entry.basis,
              eventKey: entry.eventKey,
              scopeKind: plan.computed.scope.kind,
              scopeKey: plan.computed.scope.key,
            })),
          ),
          sql`
      ON CONFLICT ("factKind", "factId", basis) DO UPDATE SET "eventKey" = excluded."eventKey", "scopeKind" = excluded."scopeKind", "scopeKey" = excluded."scopeKey"`,
        );
        for (const binding of [
          ...combined.bindingsAdd,
          ...combined.bindingsRemove,
        ]) {
          changed.add(bindingEventKey(binding.eventKey));
          changed.add(bindingFactKey(binding.fact));
        }
      }),
    provenance,
  );

  const membershipsAfter = await relatedMemberships(
    tx,
    registry,
    plans.flatMap((plan) => changesOf(plan.diff)),
  );
  const lockedMembershipKeys = new Set(
    membershipKeys(membershipsBefore, false),
  );
  const previousChangedMemberships = new Map(
    [...membershipsBefore].map(([index, rows]) => {
      const affected = new Set(
        (membershipsAfter.get(index) ?? []).map((row) => row.id),
      );
      return [index, rows.filter((row) => affected.has(row.id))] as const;
    }),
  );
  const relatedKeys = [
    ...membershipKeys(previousChangedMemberships, true),
    ...membershipKeys(membershipsAfter, true),
  ];
  if (relatedKeys.some((key) => !lockedMembershipKeys.has(key)))
    throw new KernelConflict(
      "Joined predicate membership moved after its fence",
    );
  for (const key of relatedKeys) changed.add(key);
  await withDatabaseOperationPhase("dependencies", async () => {
    await fileBatchAsks(q, plans);
    const asks = await batchAsks(q, plans);
    const states = plans.map((plan) => {
      const { computed, claim, gaps } = plan;
      const pending = asks.get(scopeId(computed.scope)) ?? [];
      for (const [index, gap] of gaps.entries()) {
        const ask = gap.inputHash
          ? pending.find((entry) => entry.inputHash === gap.inputHash)
          : undefined;
        const member = ask ? askMemberGap(ask, gap.input, gap.since) : null;
        if (member) gaps[index] = member;
        else if (ask) gaps[index] = { ...gap, askState: askGapState(ask) };
      }
      return {
        scopeKind: computed.scope.kind,
        scopeKey: computed.scope.key,
        version: computed.reconciler.version,
        rules: computed.reconciler.rules,
        gaps,
        inputs: usedInputs(computed),
        stage: resolveStage({
          ended: false,
          stuck: pending.some(askIsStuck),
          working: false,
          gaps,
        }),
        nextActor: nextActor(gaps),
        firstGap: gaps[0]?.input ?? null,
        inputsHash: computed.inputsHash,
        durationMs: Math.round(computed.durationMs),
        errorClass: null,
        error: null,
        reconciledAt: new Date(),
        inputsChangedAt: claim.dirtiedAt,
      };
    });
    const downstream = await markDirty(q, registry, {
      keys: [...changed],
      discovers: discovered,
      excludes: plans.map((plan) => plan.computed.scope),
      reason: `output:${plans[0]!.computed.scope.kind}`,
    });
    if (downstream) await wakeAfterCommit(tx);
    const dependencies = plans.map((plan) => ({
      kind: plan.computed.scope.kind,
      key: plan.computed.scope.key,
      keys: [...plan.computed.keys.keys()],
    }));
    await q.execute(sql`
      DELETE FROM "ScopeDep" d USING unnest(${orderedTextArrayParam(states.map((state) => state.scopeKind))}, ${orderedTextArrayParam(states.map((state) => state.scopeKey))}) AS wanted(kind,key)
      WHERE d."scopeKind"=wanted.kind AND d."scopeKey"=wanted.key`);
    await q.execute(sql`
      INSERT INTO "ScopeDep" ("scopeKind", "scopeKey", key)
      SELECT wanted.kind,wanted.key,dependency.value
      FROM jsonb_to_recordset(${JSON.stringify(dependencies)}::jsonb) AS wanted(kind text,key text,keys jsonb)
      CROSS JOIN LATERAL jsonb_array_elements_text(wanted.keys) dependency(value)
      ON CONFLICT DO NOTHING`);
    await insertRows(
      q,
      scopeState,
      states,
      sql`ON CONFLICT ("scopeKind", "scopeKey") DO UPDATE SET
      version = excluded.version, rules = excluded.rules, gaps = excluded.gaps, inputs = excluded.inputs, stage = excluded.stage,
      "nextActor" = excluded."nextActor", "firstGap" = excluded."firstGap", "inputsHash" = excluded."inputsHash", "durationMs" = excluded."durationMs",
      "errorClass" = NULL, error = NULL, "reconciledAt" = excluded."reconciledAt", "inputsChangedAt" = excluded."inputsChangedAt"`,
    );
    const advanced = plans.filter((plan) => !plan.heldBaseline);
    if (advanced.length)
      await q.execute(sql`
      DELETE FROM "Drift" d USING unnest(${orderedTextArrayParam(advanced.map((plan) => plan.computed.scope.kind))}, ${orderedTextArrayParam(advanced.map((plan) => plan.computed.scope.key))}) AS wanted(kind, key)
      WHERE d."scopeKind" = wanted.kind AND d."scopeKey" = wanted.key`);
    await q.execute(sql`
      DELETE FROM "ScopeDirty" d USING jsonb_to_recordset(${JSON.stringify(plans.map((plan) => ({ kind: plan.computed.scope.kind, key: plan.computed.scope.key, seq: plan.claim.seq, token: plan.claim.token })))}::jsonb) AS wanted(kind text, key text, seq bigint, token uuid)
      WHERE d."scopeKind" = wanted.kind AND d."scopeKey" = wanted.key AND d.seq = wanted.seq AND d."claimToken" = wanted.token::uuid`);
    if (entities.size)
      await recordChange(tx, { kind: "source", categories: [...entities] });
  });
  return [
    ...outcomes,
    ...plans.map((plan) =>
      outcome(
        plan.computed.scope,
        plan.gaps.length ? "waiting" : "applied",
        plan.gaps,
      ),
    ),
  ];
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

/** A locked fallback uses the same set-based writer with one scope. */
async function applyOne(
  tx: Database,
  registry: KernelRegistry,
  computed: Computed,
  claimed: ClaimedScope,
  options: ApplyOptions,
  proposals: Proposals,
): Promise<Outcome> {
  return (
    await applyBatch(tx, registry, [computed], [claimed], options, proposals)
  )[0]!;
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
    const absorbed = rows.rows.map((row) =>
      claimed.find((entry) => entry.key === row.key)!,
    );
    await q.execute(sql`
      DELETE FROM "ScopeDirty" d USING unnest(${orderedTextArrayParam(absorbed.map((scope) => scope.kind))}, ${orderedTextArrayParam(absorbed.map((scope) => scope.key))}, ${orderedTextArrayParam(absorbed.map((scope) => scope.token))}) AS wanted(kind, key, token)
      WHERE d."scopeKind" = wanted.kind AND d."scopeKey" = wanted.key AND d."claimToken" = wanted.token::uuid`);
    for (const row of rows.rows)
      ended.set(
        row.key,
        outcome({ kind: reconciler.scope, key: row.key }, "clean"),
      );
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
  let renewal = Promise.resolve();
  const heartbeat = setInterval(() => {
    renewal = renewal
      .then(() => renewScopeClaims(repositoryQueries(db), claimedScopes))
      .catch(() => {
        // SILENT: a lost renewal is fenced by the live claim deadline at publication.
      });
  }, 20_000);
  try {
    return await runHeldScopes(
      db,
      registry,
      reconciler,
      claimedScopes,
      options,
    );
  } finally {
    clearInterval(heartbeat);
    await renewal;
  }
}

async function runHeldScopes(
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
 * Apply one coherent, bounded batch under one write gate and revision fence.
 * `claimed[i]` is `computed[i]`'s claim.
 */
export async function applyComputed(
  db: Database,
  registry: KernelRegistry,
  reconciler: Reconciler,
  computed: readonly Computed[],
  claimed: readonly ClaimedScope[],
  options: ApplyOptions & { mode: WriteMode; proposals?: Proposals },
): Promise<Outcome[]> {
  if (!computed.length) return [];
  const proposals =
    options.proposals ??
    (await heldProposals(db, registry, reconciler, computed, options));
  try {
    return await repositoryTransactionDatabase(db, async (tx) => {
      await enterWriteTransaction(repositoryQueries(tx), {
        lane: reconciler.lane,
        mode: options.mode,
      });
      try {
        return await repositoryTransactionDatabase(tx, (nested) =>
          applyBatch(nested, registry, computed, claimed, options, proposals),
        );
      } catch (error) {
        if (!isConflict(error)) throw error;
        await releaseConflicts(repositoryQueries(tx), claimed);
        return computed.map((item) => outcome(item.scope, "conflict"));
      }
    });
  } catch (error) {
    if (isConflict(error)) {
      await releaseConflicts(repositoryQueries(db), claimed);
      return computed.map((item) => outcome(item.scope, "conflict"));
    }
    if (computed.length > 1) {
      const isolated: Outcome[] = [];
      for (let i = 0; i < computed.length; i++)
        isolated.push(
          ...(await applyComputed(
            db,
            registry,
            reconciler,
            [computed[i]!],
            [claimed[i]!],
            { ...options, proposals },
          )),
        );
      return isolated;
    }
    const failure = classifyWorkFailure(error, { publication: true });
    const surfaced =
      failure.kind === "failed" || failure.kind === "isolated"
        ? new WorkTargetError(rawError(error), { cause: error })
        : error;
    return settleBatchFailure(db, reconciler, claimed, surfaced, options.mode);
  }
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
  const [prepared] = await computeBatch(
    repositoryQueries(db),
    registry,
    reconciler,
    [scope],
    { db, locked: false, hideBaseline: options.hideBaseline ?? false },
  );
  const proposals = await heldProposals(
    db,
    registry,
    reconciler,
    [prepared!],
    options,
  );
  try {
    return await repositoryTransactionDatabase(db, async (tx) => {
      const q = repositoryQueries(tx);
      await enterWriteTransaction(q, {
        lane: reconciler.lane,
        mode: options.mode,
      });
      const memberships = await relatedMemberships(
        tx,
        registry,
        indexChanges([prepared!], options),
      );
      const lockedRevisions = await lockKeyRevs(
        q,
        [
          ...new Set([
            ...prepared!.keys.keys(),
            ...plannedKeys([prepared!], options, registry),
            ...membershipKeys(memberships, false),
            ...(await mergeOutputKeys(q, [prepared!], options)),
          ]),
        ].sort(),
      );
      const [computed] = await computeBatch(q, registry, reconciler, [scope], {
        db: tx,
        locked: true,
        lockedRevisions,
        hideBaseline: options.hideBaseline ?? false,
      });
      if (isConflict(computed!.error)) throw computed!.error;
      const currentMemberships = await relatedMemberships(
        tx,
        registry,
        indexChanges([computed!], options),
      );
      if (
        [
          ...plannedKeys([computed!], options, registry),
          ...membershipKeys(currentMemberships, false),
        ].some((key) => !lockedRevisions.has(key))
      )
        throw new LockedReadChangedError();
      const current = await q.execute<{ seq: string }>(
        sql`SELECT seq FROM "ScopeDirty" WHERE "scopeKind"=${scope.kind} AND "scopeKey"=${scope.key}`,
      );
      return applyOne(
        tx,
        registry,
        computed!,
        { ...claimed, seq: Number(current.rows[0]?.seq ?? claimed.seq) },
        options,
        proposals,
      );
    });
  } catch (error) {
    if (isConflict(error)) {
      await releaseConflicts(repositoryQueries(db), [claimed]);
      return outcome(scope, "conflict");
    }
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
