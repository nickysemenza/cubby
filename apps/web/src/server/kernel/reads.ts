/**
 * Keyed reads for a reconciler's `load` (ADR 0029 section 3). Each read
 * records its keys against the scope that asked, including a read that finds
 * no rows, together with the `KeyRev` revision read before the data. Reads
 * issued in the same tick through different scopes coalesce into one
 * statement per source, so a batch load issues a fixed number of statements
 * when it requests each phase with `Promise.all`.
 */
import type { BindingBasis } from "@cubby/schemas/kernel/machinery";
import {
  and,
  eq,
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
  Binding,
  ColumnValues,
  EvidenceKind,
  FactRef,
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

export class LockedReadChangedError extends Error {}

export class KernelContractError extends Error {
  override name = "KernelContractError";
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
}

/**
 * The batch's reads. Its own methods record keys for every scope of the
 * batch (a shared hub record); `for(scopeKey)` records for that scope only.
 */
export interface Reads extends ScopeReads {
  for(scopeKey: string): ScopeReads;
}

type Q = Pick<RepositoryQueryClient, "select" | "execute">;

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
  let revisionQueue: {
    keys: readonly Key[];
    resolve(revs: Map<Key, number>): void;
    reject(error: unknown): void;
  }[] = [];
  const readRevisions = (keys: readonly Key[]): Promise<Map<Key, number>> => {
    if (keys.every((key) => observedRevisions.has(key)))
      return Promise.resolve(
        new Map(keys.map((key) => [key, observedRevisions.get(key)!])),
      );
    return new Promise((resolve, reject) => {
      revisionQueue.push({ keys, resolve, reject });
      if (revisionQueue.length > 1) return;
      queueMicrotask(() => {
        const pending = revisionQueue;
        revisionQueue = [];
        void (async () => {
          const revs = await readKeyRevs(q, [
            ...new Set(pending.flatMap((entry) => entry.keys)),
          ]);
          for (const [key, rev] of revs)
            if (!observedRevisions.has(key)) observedRevisions.set(key, rev);
          for (const entry of pending)
            entry.resolve(
              new Map(
                entry.keys.map((key) => [key, observedRevisions.get(key)!]),
              ),
            );
        })().catch((error) => {
          for (const entry of pending) entry.reject(error);
        });
      });
    });
  };
  const revisions = async (keys: readonly Key[]) => {
    if (!mode.lockedRevisions) return readRevisions(keys);
    if (keys.some((key) => !mode.lockedRevisions!.has(key)))
      throw new LockedReadChangedError();
    return new Map(keys.map((key) => [key, mode.lockedRevisions!.get(key)!]));
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
    run: (keys: readonly Key[]) => Promise<(keys: readonly Key[]) => R>,
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
            const revs = await revisions(all);
            const pick = await run(all);
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

  const rowReaders = new Map<
    string,
    ReturnType<typeof coalesced<Map<string, unknown>>>
  >();
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
    const rows = await q
      .select()
      .from(evidenceBinding)
      .where(
        and(
          sql`(${events.length ? sql`${evidenceBinding.eventKey} = ANY(${textArrayParam(events)})` : sql`false`}
            OR (${evidenceBinding.factKind} || ':' || ${evidenceBinding.factId}) = ANY(${textArrayParam(facts)}))`,
          mode.hideBaseline
            ? sql`${evidenceBinding.basis} <> ${"baseline" satisfies BindingBasis}`
            : undefined,
        ),
      );
    const bindings: Binding[] = rows.map((row) => ({
      fact: { kind: row.factKind, id: row.factId },
      eventKey: row.eventKey,
      basis: row.basis,
      scope: { kind: row.scopeKind, key: row.scopeKey },
    }));
    return (requested) => {
      const wanted = new Set(requested);
      return bindings.filter(
        (binding) =>
          wanted.has(bindingEventKey(binding.eventKey)) ||
          wanted.has(bindingFactKey(binding.fact)),
      );
    };
  });

  const indexReaders = new Map<
    string,
    ReturnType<typeof coalesced<ColumnValues[]>>
  >();

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
      let reader = indexReaders.get(index.name);
      if (!reader) {
        reader = coalesced(async (keys) => {
          const prefix = `index:${index.name}:`;
          const rows: ColumnValues[] = keys.length
            ? await q
                .select()
                .from(table)
                .where(index.where(keys.map((key) => key.slice(prefix.length))))
            : [];
          return (requested) => {
            const wanted = new Set(requested);
            return rows.filter((row) =>
              index
                .values(row)
                .some((value) => wanted.has(indexKey(index.name, value))),
            );
          };
        });
        indexReaders.set(index.name, reader);
      }
      // SAFETY: the index selects and partitions rows of this exact table.
      return (await reader(
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
      let reader = rowReaders.get(name);
      if (!reader) {
        reader = coalesced(async (keys) => {
          const wanted = keys.map((key) => key.slice(`row:${name}:`.length));
          const rows: ColumnValues[] = wanted.length
            ? await q
                .select()
                .from(table)
                .where(
                  sql`${idColumn(table)} = ANY(${columnArrayParam(wanted)})`,
                )
            : [];
          const byId = new Map(rows.map((row) => [String(row.id), row]));
          return (requested) =>
            new Map(
              requested.flatMap((key) => {
                const id = key.slice(`row:${name}:`.length);
                const row = byId.get(id);
                return row ? [[id, row] as const] : [];
              }),
            );
        });
        rowReaders.set(name, reader);
      }
      // SAFETY: rows come from `select().from(table)` of this same table.
      return (await reader(
        scopes,
        ids.map((id) => rowKey(name, id)),
      )) as Map<string, InferSelectModel<T>>;
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
          const joined = all.length
            ? await q
                .select({ key: factKey.key, row: table })
                .from(factKey)
                .innerJoin(
                  table,
                  eq(sql`${idColumn(table)}::text`, factKey.factId),
                )
                .where(
                  and(
                    eq(factKey.factKind, evidence.kind),
                    sql`${factKey.key} = ANY(${textArrayParam(all)})`,
                  ),
                )
            : [];
          const byKey = new Map<Key, unknown[]>();
          for (const entry of joined) {
            const list = byKey.get(entry.key) ?? [];
            list.push(entry.row);
            byKey.set(entry.key, list);
          }
          return (requested) =>
            new Map(requested.map((key) => [key, byKey.get(key) ?? []]));
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
      const revs = await revisions(predicateKeys);
      const rows = await q.select().from(table).where(where);
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
  });

  return { ...scopeReads(batch), for: (scopeKey) => scopeReads([scopeKey]) };
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
