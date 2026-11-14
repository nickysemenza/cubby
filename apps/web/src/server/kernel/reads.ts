/**
 * Keyed reads for a reconciler's `load` (ADR 0029 section 3). Each read
 * records its keys against the scope that asked, including a read that finds
 * no rows, together with the `KeyRev` revision the same statement read, so the
 * revision and the rows share one snapshot. Reads
 * issued in the same tick through different scopes coalesce into one
 * statement per source, so a batch load issues a fixed number of statements
 * when it requests each phase with `Promise.all`.
 */
import type { BindingBasis } from "@cubby/schemas/kernel/machinery";
import {
  and,
  eq,
  or,
  getTableColumns,
  getTableName,
  sql,
  type InferSelectModel,
  type SQL,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import {
  textArrayParam,
  columnArrayParam,
} from "~/server/db/helpers/array-param";
import { evidenceBinding, factKey } from "~/server/db/kernel-schema";
import type { RepositoryQueryClient } from "~/server/db/repository-access.boundary";

import type {
  AskKind,
  Binding,
  ColumnValues,
  EvidenceKind,
  FactRef,
  Json,
  Key,
  KeyedTable,
  Reconciler,
  ReadIndex,
} from "./define";
import { readKeyRevs } from "./dirty";
import {
  bindingEventKey,
  bindingFactKey,
  rowKey,
  indexKey,
  columnKey,
} from "./keys";

type Q = Pick<RepositoryQueryClient, "select" | "execute">;

export class LockedReadChangedError extends Error {}

export class KernelContractError extends Error {
  override name = "KernelContractError";
}

/** One row holding the stored `KeyRev` revisions of `keys` as jsonb. */
export const revisionsSource = (keys: readonly Key[]) =>
  sql`(SELECT coalesce(jsonb_object_agg(key, rev), '{}'::jsonb) AS revs FROM "KeyRev" WHERE key = ANY(${textArrayParam(keys)})) revisions`;

/** Every key's revision from a `revisionsSource` value; an unstored key is 0. */
export const parseRevisions = (
  keys: readonly Key[],
  value: Record<string, number | string> | null | undefined,
) => new Map(keys.map((key) => [key, Number(value?.[key] ?? 0)]));

/**
 * The rows of `table` matching `where` and the revisions of `keys`, from one
 * statement: a write between a separate revision read and the data read would
 * otherwise pair old rows with a revision that already covers the write.
 */
async function selectWithRevisions(
  q: Q,
  table: PgTable,
  where: SQL,
  keys: readonly Key[],
): Promise<{ rows: ColumnValues[]; revs: Map<Key, number> }> {
  if (!keys.length)
    return { rows: await q.select().from(table).where(where), revs: new Map() };
  const result = await q
    .select({
      revs: sql<Record<string, number | string>>`revisions.revs`,
      row: table,
    })
    .from(revisionsSource(keys))
    .leftJoin(table, where);
  const rows: ColumnValues[] = [];
  for (const entry of result) if (entry.row) rows.push(entry.row);
  return { rows, revs: parseRevisions(keys, result[0]?.revs) };
}

/** A reconciled or evidence table's `id` column. */
export function idColumn(table: PgTable): PgColumn {
  const column = getTableColumns(table).id;
  if (!column)
    throw new KernelContractError(
      `Kernel table ${getTableName(table)} has no id column`,
    );
  return column;
}

/** Keys read per scope, with the revision each first saw, and the facts it read. */
export class KeyLedger {
  private readonly scopes = new Map<string, Map<Key, number>>();
  private readonly facts = new Map<string, Map<string, FactRef>>();

  recordFacts(scopeKeys: readonly string[], facts: readonly FactRef[]) {
    for (const scopeKey of scopeKeys) {
      const known = this.facts.get(scopeKey) ?? new Map<string, FactRef>();
      for (const fact of facts) known.set(`${fact.kind}:${fact.id}`, fact);
      this.facts.set(scopeKey, known);
    }
  }

  factsOf(scopeKey: string): FactRef[] {
    return [...(this.facts.get(scopeKey)?.values() ?? [])];
  }

  record(
    scopeKey: string,
    revs: ReadonlyMap<Key, number>,
    keys: readonly Key[],
  ) {
    const ledger = this.scopes.get(scopeKey) ?? new Map<Key, number>();
    for (const key of keys)
      if (!ledger.has(key)) ledger.set(key, revs.get(key) ?? 0);
    this.scopes.set(scopeKey, ledger);
  }

  of(scopeKey: string): ReadonlyMap<Key, number> {
    return this.scopes.get(scopeKey) ?? new Map();
  }
}

/** The reads one scope makes; every read records its keys for that scope. */
export interface ScopeReads {
  lookup<T extends KeyedTable>(
    table: T,
    index: ReadIndex,
    values: readonly string[],
  ): Promise<InferSelectModel<T>[]>;
  /** Prepare a source-derived question under tracked roster revisions. The callback is read-only and makes no producer call. */
  prepare<T>(
    tables: readonly PgTable[],
    load: (db: Database) => Promise<T>,
  ): Promise<T>;
  rows<T extends KeyedTable>(
    table: T,
    ids: readonly string[],
  ): Promise<Map<string, InferSelectModel<T>>>;
  facts<T extends KeyedTable>(
    evidence: EvidenceKind<T>,
    keys: readonly Key[],
  ): Promise<Map<Key, InferSelectModel<T>[]>>;
  select<T extends PgTable>(
    table: T,
    keys: readonly Key[],
    where: SQL,
  ): Promise<InferSelectModel<T>[]>;
  bindings(by: {
    events?: readonly string[];
    facts?: readonly FactRef[];
  }): Promise<Binding[]>;
  /**
   * Stored outputs of declared asks a later read depends on, null when none
   * is stored. `c.answer` reuses them, so an answer-dependent scope reconciles
   * in the same round as its batchmates.
   */
  answers(asks: readonly AnswerRequest[]): Promise<(Json | null)[]>;
}

type AnswerRequest = { kind: AskKind; input: unknown };
/** The computation's answer loader; it records each answer for `scopes`. */
export type AnswerLoader = (
  scopes: readonly string[],
  asks: readonly AnswerRequest[],
) => Promise<(Json | null)[]>;

/**
 * The batch's reads. Its own methods record keys for every scope of the
 * batch (a shared hub record); `for(scopeKey)` records for that scope only.
 */
export interface Reads extends ScopeReads {
  for(scopeKey: string): ScopeReads;
  /**
   * One predicate statement for the batch; each scope records only its own
   * keys, so a batchmate's input never wakes it.
   */
  selectEach<T extends PgTable>(
    table: T,
    keys: ReadonlyMap<string, readonly Key[]>,
    where: SQL,
  ): Promise<InferSelectModel<T>[]>;
}

type Pending<T> = {
  scopes: readonly string[];
  keys: readonly Key[];
  resolve(value: T): void;
  reject(error: unknown): void;
};

export type ReadMode = {
  db?: Database;
  /** Locked runs hold each key's revision row from its read to commit. */
  locked: boolean;
  lockedRevisions?: ReadonlyMap<Key, number>;
  /** The version sweep derives without baseline bindings. */
  hideBaseline: boolean;
};

export function createReads(
  q: Q,
  reconciler: Reconciler,
  batch: readonly string[],
  ledger: KeyLedger,
  mode: ReadMode,
  loadAnswers?: AnswerLoader,
): Reads {
  const declaredTables = new Set<string>();
  const declaredEvidence = new Set<string>();
  let bindingsDeclared = false;
  for (const ref of reconciler.reads) {
    if (ref.type === "table") declaredTables.add(ref.name);
    else if (ref.type === "evidence") declaredEvidence.add(ref.evidence.kind);
    else bindingsDeclared = true;
  }
  const requireTable = (table: PgTable) => {
    const name = getTableName(table);
    if (!declaredTables.has(name))
      throw new KernelContractError(
        `Reconciler ${reconciler.scope} reads undeclared table ${name}`,
      );
    return name;
  };
  const observedRevisions = new Map<Key, number>();
  /** A key keeps the revision it was first read at for the whole batch. */
  const observe = (keys: readonly Key[], revs: ReadonlyMap<Key, number>) => {
    for (const [key, rev] of revs)
      if (!observedRevisions.has(key)) observedRevisions.set(key, rev);
    return new Map(
      keys.map((key) => {
        const rev = observedRevisions.get(key);
        if (rev === undefined)
          throw new KernelContractError(`Read ${key} without its revision`);
        return [key, rev];
      }),
    );
  };
  const lockedRevisionsOf = (keys: readonly Key[]) => {
    if (keys.some((key) => !mode.lockedRevisions!.has(key)))
      throw new LockedReadChangedError();
    return new Map(keys.map((key) => [key, mode.lockedRevisions!.get(key)!]));
  };
  const revisions = async (keys: readonly Key[]) =>
    mode.lockedRevisions
      ? lockedRevisionsOf(keys)
      : observe(
          keys,
          await readKeyRevs(
            q,
            keys.filter((key) => !observedRevisions.has(key)),
          ),
        );
  /** Rows and the revisions of `keys`, from the same statement. */
  const revised = async (table: PgTable, where: SQL, keys: readonly Key[]) => {
    if (mode.lockedRevisions) {
      const revs = lockedRevisionsOf(keys);
      return { rows: await q.select().from(table).where(where), revs };
    }
    const read = await selectWithRevisions(
      q,
      table,
      where,
      keys.filter((key) => !observedRevisions.has(key)),
    );
    return { rows: read.rows, revs: observe(keys, read.revs) };
  };
  const recordAll = (
    scopes: readonly string[],
    revs: ReadonlyMap<Key, number>,
    keys: readonly Key[],
  ) => {
    for (const scope of scopes) ledger.record(scope, revs, keys);
  };

  /** Coalesce same-tick requests of one source into one statement. */
  const coalesced = <R>(
    run: (keys: readonly Key[]) => Promise<{
      revs: ReadonlyMap<Key, number>;
      pick: (keys: readonly Key[]) => R;
    }>,
  ) => {
    let queue: Pending<R>[] = [];
    return (scopes: readonly string[], keys: readonly Key[]) =>
      new Promise<R>((resolve, reject) => {
        queue.push({ scopes, keys, resolve, reject });
        if (queue.length > 1) return;
        queueMicrotask(() => {
          const flushed = queue;
          queue = [];
          const all = [...new Set(flushed.flatMap((entry) => entry.keys))];
          void (async () => {
            const { revs, pick } = await run(all);
            for (const entry of flushed) {
              recordAll(entry.scopes, revs, entry.keys);
              entry.resolve(pick(entry.keys));
            }
          })().catch((error: unknown) => {
            for (const entry of flushed) entry.reject(error);
          });
        });
      });
  };

  /**
   * One reader per table: the row reads and index lookups of one tick share a
   * statement, and a row read once by its key serves the rest of the batch at
   * the revision it was read at.
   */
  const tableReaders = new Map<
    string,
    ReturnType<typeof coalesced<ColumnValues[]>>
  >();
  const tableReader = (table: PgTable) => {
    const name = getTableName(table);
    const existing = tableReaders.get(name);
    if (existing) return existing;
    const indexes = reconciler.reads.flatMap((ref) =>
      ref.type === "table" && ref.name === name ? (ref.indexes ?? []) : [],
    );
    const rowPrefix = `row:${name}:`;
    const indexOf = (key: Key) =>
      indexes.find((index) => key.startsWith(`index:${index.name}:`));
    const byId = new Map<string, ColumnValues | null>();
    const reader = coalesced<ColumnValues[]>(async (keys) => {
      const ids = keys.flatMap((key) =>
        key.startsWith(rowPrefix) && !byId.has(key.slice(rowPrefix.length))
          ? [key.slice(rowPrefix.length)]
          : [],
      );
      const lookups = new Map<ReadIndex, string[]>();
      for (const key of keys) {
        const index = indexOf(key);
        if (!index) continue;
        const values = lookups.get(index) ?? [];
        values.push(key.slice(`index:${index.name}:`.length));
        lookups.set(index, values);
      }
      const predicates = [
        ...(ids.length
          ? [sql`${idColumn(table)} = ANY(${columnArrayParam(ids)})`]
          : []),
        ...[...lookups].map(([index, values]) => index.where(values)),
      ];
      const read = predicates.length
        ? await revised(table, or(...predicates)!, [
            ...ids.map((id) => rowKey(name, id)),
            ...[...lookups].flatMap(([index, values]) =>
              values.map((value) => indexKey(index.name, value)),
            ),
          ])
        : { rows: [], revs: new Map<Key, number>() };
      // Only a row read by its own key is cached: an index lookup observes the
      // index key, not the row's revision.
      const direct = new Set(ids);
      for (const id of ids) byId.set(id, null);
      for (const row of read.rows)
        if (direct.has(String(row.id))) byId.set(String(row.id), row);
      return {
        revs: mode.lockedRevisions
          ? lockedRevisionsOf(keys)
          : observe(keys, read.revs),
        pick: (requested) => {
          const wanted = new Set(requested);
          const index = requested[0] ? indexOf(requested[0]) : undefined;
          return index
            ? read.rows.filter((row) =>
                index
                  .values(row)
                  .some((value) => wanted.has(indexKey(index.name, value))),
              )
            : requested.flatMap((key) => {
                const row = byId.get(key.slice(rowPrefix.length));
                return row ? [row] : [];
              });
        },
      };
    });
    tableReaders.set(name, reader);
    return reader;
  };
  const factReaders = new Map<
    string,
    ReturnType<typeof coalesced<Map<Key, unknown[]>>>
  >();
  const bindingReader = coalesced<Binding[]>(async (keys) => {
    const events = keys.flatMap((key) =>
      key.startsWith("binding:event:")
        ? [key.slice("binding:event:".length)]
        : [],
    );
    const facts = keys.flatMap((key) =>
      key.startsWith("binding:fact:")
        ? [key.slice("binding:fact:".length)]
        : [],
    );
    const { rows, revs } = await revised(
      evidenceBinding,
      and(
        sql`(${events.length ? sql`${evidenceBinding.eventKey} = ANY(${textArrayParam(events)})` : sql`false`}
            OR (${evidenceBinding.factKind} || ':' || ${evidenceBinding.factId}) = ANY(${textArrayParam(facts)}))`,
        mode.hideBaseline
          ? sql`${evidenceBinding.basis} <> ${"baseline" satisfies BindingBasis}`
          : undefined,
      )!,
      keys,
    );
    // SAFETY: rows come from `select().from(evidenceBinding)`.
    const bindings: Binding[] = (
      rows as (typeof evidenceBinding.$inferSelect)[]
    ).map((row) => ({
      fact: { kind: row.factKind, id: row.factId },
      eventKey: row.eventKey,
      basis: row.basis,
      scope: { kind: row.scopeKind, key: row.scopeKey },
    }));
    return {
      revs,
      pick: (requested) => {
        const wanted = new Set(requested);
        return bindings.filter(
          (binding) =>
            wanted.has(bindingEventKey(binding.eventKey)) ||
            wanted.has(bindingFactKey(binding.fact)),
        );
      },
    };
  });

  const scopeReads = (scopes: readonly string[]): ScopeReads => ({
    async lookup<T extends KeyedTable>(
      table: T,
      index: ReadIndex,
      values: readonly string[],
    ) {
      const name = requireTable(table);
      if (
        !reconciler.reads.some(
          (ref) =>
            ref.type === "table" &&
            ref.name === name &&
            ref.indexes?.includes(index),
        )
      )
        throw new KernelContractError(`Undeclared index ${index.name}`);
      // SAFETY: the index selects and partitions rows of this exact table.
      return (await tableReader(table)(
        scopes,
        values.map((value) => indexKey(index.name, value)),
      )) as InferSelectModel<T>[];
    },
    async prepare(tables, load) {
      if (!mode.db)
        throw new KernelContractError(
          "Prepared sources require the computation database",
        );
      const keys = tables.flatMap((table) => {
        const name = requireTable(table);
        return reconciler.reads.flatMap((ref) =>
          ref.type === "table" && ref.name === name
            ? ref.columns.map((column) => columnKey(name, column))
            : [],
        );
      });
      const revs = await revisions(keys);
      const value = await load(mode.db);
      recordAll(scopes, revs, keys);
      return value;
    },
    async rows<T extends KeyedTable>(table: T, ids: readonly string[]) {
      const name = requireTable(table);
      const rows = await tableReader(table)(
        scopes,
        ids.map((id) => rowKey(name, id)),
      );
      // SAFETY: rows come from `select().from(table)` of this same table.
      return new Map(rows.map((row) => [String(row.id), row])) as Map<
        string,
        InferSelectModel<T>
      >;
    },

    async facts<T extends KeyedTable>(
      evidence: EvidenceKind<T>,
      keys: readonly Key[],
    ) {
      if (!declaredEvidence.has(evidence.kind))
        throw new KernelContractError(
          `Reconciler ${reconciler.scope} reads undeclared evidence ${evidence.kind}`,
        );
      let reader = factReaders.get(evidence.kind);
      if (!reader) {
        reader = coalesced(async (all) => {
          const table: PgTable = evidence.table;
          const where = and(
            eq(factKey.factKind, evidence.kind),
            sql`${factKey.key} = ANY(${textArrayParam(all)})`,
          )!;
          const join = eq(sql`${idColumn(table)}::text`, factKey.factId);
          const unseen = all.filter((key) => !observedRevisions.has(key));
          let joined: { key: string; row: unknown }[] = [];
          let revs: ReadonlyMap<Key, number> = new Map();
          if (all.length && (mode.lockedRevisions || !unseen.length)) {
            revs = mode.lockedRevisions
              ? lockedRevisionsOf(all)
              : observe(all, new Map());
            joined = await q
              .select({ key: factKey.key, row: table })
              .from(factKey)
              .innerJoin(table, join)
              .where(where);
          } else if (all.length) {
            // One statement for the revisions and the facts; see `selectWithRevisions`.
            const result = await q
              .select({
                revs: sql<Record<string, number | string>>`revisions.revs`,
                key: factKey.key,
                row: table,
              })
              .from(revisionsSource(unseen))
              .leftJoin(factKey, where)
              .leftJoin(table, join);
            revs = observe(all, parseRevisions(unseen, result[0]?.revs));
            for (const entry of result)
              if (entry.key && entry.row)
                joined.push({ key: entry.key, row: entry.row });
          }
          const byKey = new Map<Key, unknown[]>();
          for (const entry of joined) {
            const list = byKey.get(entry.key) ?? [];
            list.push(entry.row);
            byKey.set(entry.key, list);
          }
          return {
            revs,
            pick: (requested) =>
              new Map(requested.map((key) => [key, byKey.get(key) ?? []])),
          };
        });
        factReaders.set(evidence.kind, reader);
      }
      // SAFETY: rows come from `select().from(evidence.table)`.
      const rows = (await reader(scopes, keys)) as Map<Key, ColumnValues[]>;
      ledger.recordFacts(
        scopes,
        [...rows.values()].flat().map((row) => ({
          kind: evidence.kind,
          id: String(row.id),
        })),
      );
      // SAFETY: as above; the same rows, typed as this table's select model.
      return rows as Map<Key, InferSelectModel<T>[]>;
    },

    async select<T extends PgTable>(
      table: T,
      keys: readonly Key[],
      where: SQL,
    ) {
      const name = requireTable(table);
      const predicateKeys = [
        ...new Set(
          keys.length
            ? keys
            : reconciler.reads.flatMap((ref) =>
                ref.type === "table" && ref.name === name
                  ? ref.columns.map((column) => columnKey(name, column))
                  : [],
              ),
        ),
      ];
      const { rows, revs } = await revised(table, where, predicateKeys);
      recordAll(scopes, revs, predicateKeys);
      // SAFETY: rows come from `select().from(table)` of this same table.
      return rows as InferSelectModel<T>[];
    },

    async bindings(by) {
      if (!bindingsDeclared)
        throw new KernelContractError(
          `Reconciler ${reconciler.scope} reads undeclared evidence bindings`,
        );
      return bindingReader(scopes, [
        ...(by.events ?? []).map(bindingEventKey),
        ...(by.facts ?? []).map(bindingFactKey),
      ]);
    },

    async answers(asks) {
      for (const { kind } of asks)
        if (
          !reconciler.asks.some((declared) => declared.feature === kind.feature)
        )
          throw new KernelContractError(
            `Reconciler ${reconciler.scope} reads undeclared ask ${kind.feature}`,
          );
      if (!loadAnswers)
        throw new KernelContractError("Answer reads require the computation");
      return asks.length ? loadAnswers(scopes, asks) : [];
    },
  });

  return {
    ...scopeReads(batch),
    for: (scopeKey) => scopeReads([scopeKey]),
    async selectEach<T extends PgTable>(
      table: T,
      keys: ReadonlyMap<string, readonly Key[]>,
      where: SQL,
    ) {
      requireTable(table);
      const all = [...new Set([...keys.values()].flat())];
      if (!all.length) return [];
      const { rows, revs } = await revised(table, where, all);
      for (const [scope, own] of keys) ledger.record(scope, revs, own);
      // SAFETY: rows come from `select().from(table)` of this same table.
      return rows as InferSelectModel<T>[];
    },
  };
}

/** The strongest binding per fact: decision, then baseline, then proven. */
export function effectiveBindings(bindings: readonly Binding[]): Binding[] {
  const order = {
    decision: 0,
    baseline: 1,
    proven: 2,
  } satisfies Record<BindingBasis, number>;
  const best = new Map<string, Binding>();
  for (const binding of bindings) {
    const id = `${binding.fact.kind}:${binding.fact.id}`;
    const current = best.get(id);
    if (!current || order[binding.basis] < order[current.basis])
      best.set(id, binding);
  }
  return [...best.values()];
}
