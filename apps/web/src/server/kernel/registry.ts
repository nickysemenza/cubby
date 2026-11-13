/**
 * The registry built from the explicit module list, and the build-time
 * checks of section 2. `validateKernelGraph` runs when a registry is built,
 * and the registry unit test builds the production registry, so a module that
 * breaks a rule fails CI before it can run.
 */
import type { MachineryCapability } from "@cubby/schemas/kernel/capability";
import type { KernelLane } from "@cubby/schemas/kernel/machinery";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { evidenceBinding } from "~/server/db/kernel-schema";
import type { OwnedColumn } from "~/server/db/owned-columns";

import {
  type AskKind,
  type ColumnRef,
  type DomainModule,
  type EvidenceKind,
  type Pass,
  type Reconciler,
} from "./define";

const BINDINGS = getTableName(evidenceBinding);

/**
 * The kernel-owned binding table, declared in `writes` by the one reconciler
 * that binds. Its rows apply through the binding path, never as records.
 */
export const bindingWrites: ColumnRef = {
  table: evidenceBinding,
  name: BINDINGS,
  columns: ["eventKey"],
  entity: null,
};

export class KernelGraphError extends Error {
  override name = "KernelGraphError";
}

export type KernelRegistry = {
  readonly modules: readonly DomainModule[];
  readonly evidence: ReadonlyMap<string, EvidenceKind>;
  readonly asks: ReadonlyMap<string, AskKind>;
  readonly reconcilers: ReadonlyMap<string, Reconciler>;
  readonly passes: ReadonlyMap<string, Pass>;
  readonly machinery: ReadonlyMap<string, MachineryCapability>;
  laneOf(kind: string): KernelLane;
  /** Kinds this kind must not run ahead of, transitively, in its lane. */
  upstream(kind: string): readonly string[];
  /** Claim order within a lane: upstream kinds first. */
  rank(kind: string): number;
  /** Reconcilers that read `table`, with the columns each reads. */
  readers(
    table: string,
  ): readonly { scope: string; columns: readonly string[] }[];
};

const unique = <T>(
  items: readonly T[],
  name: (item: T) => string,
  what: string,
): Map<string, T> => {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = name(item);
    if (map.has(key)) throw new KernelGraphError(`Duplicate ${what} "${key}"`);
    map.set(key, item);
  }
  return map;
};

const column = (table: string, name: string) => `${table}.${name}`;

/** Columns each reconciler reads, as `table.column`; `*` covers a whole table. */
function readColumns(reconciler: Reconciler): Set<string> {
  const read = new Set<string>();
  for (const ref of reconciler.reads) {
    if (ref.type === "table") {
      if (!ref.history)
        for (const name of ref.columns) read.add(column(ref.name, name));
    } else if (ref.type === "evidence")
      read.add(column(getTableName(ref.evidence.table), "*"));
    else read.add(column(BINDINGS, "eventKey"));
  }
  return read;
}

/**
 * Section 2's rules: one writer per column, a `fields` scope never claims a
 * column another reconciler owns, and no read-write cycle between scope kinds.
 */
export function validateKernelGraph(reconcilers: readonly Reconciler[]): void {
  const owners = new Map<string, string>();
  for (const reconciler of reconcilers)
    for (const ref of reconciler.writes)
      for (const name of ref.columns) {
        const key = column(ref.name, name);
        const owner = owners.get(key);
        if (owner && owner !== reconciler.scope)
          throw new KernelGraphError(
            owner === "fields" || reconciler.scope === "fields"
              ? `The fields scope claims ${key}, which ${owner === "fields" ? reconciler.scope : owner} owns`
              : `Reconcilers ${owner} and ${reconciler.scope} both write ${key}`,
          );
        owners.set(key, reconciler.scope);
      }
  for (const reader of reconcilers)
    for (const ref of reader.reads) {
      if (ref.type !== "table" || !ref.history) continue;
      if (
        reader.lane !== "catalog" ||
        reconcilers.some(
          (writer) =>
            writer.lane !== "money" &&
            writer.writes.some(
              (target) =>
                target.name === ref.name &&
                target.columns.some((name) => ref.columns.includes(name)),
            ),
        )
      )
        throw new KernelGraphError(
          "Committed history sources must be Catalog reads of money columns",
        );
    }
  const edges = new Map<string, Set<string>>();
  for (const reader of reconcilers) {
    const read = readColumns(reader);
    for (const writer of reconcilers) {
      if (writer.scope === reader.scope) continue;
      const feeds = writer.writes.some((ref) =>
        ref.columns.some(
          (name) =>
            read.has(column(ref.name, name)) || read.has(column(ref.name, "*")),
        ),
      );
      if (!feeds) continue;
      const next = edges.get(writer.scope) ?? new Set<string>();
      next.add(reader.scope);
      edges.set(writer.scope, next);
    }
  }
  const state = new Map<string, "open" | "closed">();
  const path: string[] = [];
  const visit = (scope: string) => {
    if (state.get(scope) === "closed") return;
    if (state.get(scope) === "open") {
      const cycle = [...path.slice(path.indexOf(scope)), scope];
      throw new KernelGraphError(
        `Read-write cycle between scope kinds: ${cycle.join(" → ")}`,
      );
    }
    state.set(scope, "open");
    path.push(scope);
    for (const next of edges.get(scope) ?? []) visit(next);
    path.pop();
    state.set(scope, "closed");
  };
  for (const reconciler of reconcilers) visit(reconciler.scope);
}

/** Every column a registered reconciler owns, for the write boundary. */
export function ownedColumns(registry: KernelRegistry): OwnedColumn[] {
  return [...registry.reconcilers.values()].flatMap((reconciler) =>
    reconciler.writes
      .filter((ref) => ref.name !== BINDINGS)
      .flatMap((ref) => {
        const columns = getTableColumns(ref.table);
        const schema = getTableConfig(ref.table).schema ?? null;
        return ref.columns.map((name) => ({
          schema,
          table: ref.name,
          column: columns[name]?.name ?? name,
          scope: reconciler.scope,
        }));
      }),
  );
}

export function buildRegistry(
  modules: readonly DomainModule[],
): KernelRegistry {
  unique(modules, (module) => module.name, "kernel module");
  const reconcilers = unique(
    modules.flatMap((module) => module.reconcilers),
    (reconciler) => reconciler.scope,
    "scope kind",
  );
  for (const reconciler of reconcilers.values())
    for (const upstream of reconciler.after)
      if (!reconcilers.has(upstream))
        throw new KernelGraphError(
          `Scope kind ${reconciler.scope} runs after unknown kind ${upstream}`,
        );
  validateKernelGraph([...reconcilers.values()]);

  const upstreamOf = new Map<string, string[]>();
  const upstream = (kind: string, seen = new Set<string>()): string[] => {
    const cached = upstreamOf.get(kind);
    if (cached) return cached;
    if (seen.has(kind))
      throw new KernelGraphError(`Scheduling cycle through ${kind}`);
    seen.add(kind);
    const reconciler = reconcilers.get(kind);
    const direct = (reconciler?.after ?? []).filter(
      (other) => reconcilers.get(other)?.lane === reconciler?.lane,
    );
    const all = [
      ...new Set(direct.flatMap((other) => [other, ...upstream(other, seen)])),
    ];
    upstreamOf.set(kind, all);
    return all;
  };
  const rankOf = new Map<string, number>();
  const rank = (kind: string): number => {
    const cached = rankOf.get(kind);
    if (cached !== undefined) return cached;
    const after = reconcilers.get(kind)?.after ?? [];
    const value = after.length ? 1 + Math.max(...after.map(rank)) : 0;
    rankOf.set(kind, value);
    return value;
  };
  const readersByTable = new Map<
    string,
    { scope: string; columns: string[] }[]
  >();
  for (const reconciler of reconcilers.values())
    for (const ref of reconciler.reads) {
      if (ref.type !== "table") continue;
      const list = readersByTable.get(ref.name) ?? [];
      list.push({ scope: reconciler.scope, columns: [...ref.columns] });
      readersByTable.set(ref.name, list);
    }

  return {
    modules,
    evidence: unique(
      modules.flatMap((module) => module.evidence),
      (evidence) => evidence.kind,
      "evidence kind",
    ),
    asks: unique(
      modules.flatMap((module) => module.asks),
      (kind) => kind.feature,
      "ask feature",
    ),
    reconcilers,
    passes: unique(
      modules.flatMap((module) => module.passes),
      (pass) => pass.name,
      "pass",
    ),
    machinery: unique(
      modules.flatMap((module) => module.machinery),
      (capability) => capability.entity,
      "machinery capability",
    ),
    laneOf(kind) {
      const reconciler = reconcilers.get(kind);
      if (!reconciler) throw new KernelGraphError(`Unknown scope kind ${kind}`);
      return reconciler.lane;
    },
    upstream: (kind) => upstream(kind),
    rank,
    readers: (table) => readersByTable.get(table) ?? [],
  };
}
