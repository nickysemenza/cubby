/**
 * One kernel bound to one registry. Production binds the explicit module
 * list in `modules.ts`, loaded on first use so domain modules can import the
 * kernel's declarations without a cycle; tests bind their own modules.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { MachineryCapability } from "@cubby/schemas/kernel/capability";
import type { Machinery } from "@cubby/schemas/kernel/machinery";
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

import { append } from "./append";
import { withAsk } from "./ask";
import { decide, type DecisionWriters } from "./decide";
import {
  defineModule,
  type AskKind,
  type DecisionInput,
  type DecisionRef,
  type DomainModule,
  type EvidenceRow,
  type FactRef,
  type Json,
  type Outcome,
  type Pass,
  type ScopeRef,
} from "./define";
import { markDirty } from "./dirty";
import {
  approveDrift,
  approveDriftClass,
  versionSweepPass,
  type ApprovalOutcome,
} from "./drift";
import { rowKey } from "./keys";
import { machinery } from "./machinery";
import { startPass } from "./pass";
import { loadMachineryRows, type MachineryListRow } from "./projection";
import { buildRegistry, type KernelRegistry } from "./registry";
import { reconcileNow, runKernel } from "./runner";
import { wakeAfterCommit } from "./wake";

export type Kernel = {
  readonly registry: KernelRegistry;
  append(
    db: Database,
    rows: readonly EvidenceRow[],
    options?: { runId?: string | null },
  ): Promise<FactRef[]>;
  decide(
    db: Database,
    actor: ActorContext,
    decisions: readonly DecisionInput[],
    writers?: DecisionWriters,
  ): Promise<DecisionRef[]>;
  reconcileNow(
    db: Database,
    scopes: readonly ScopeRef[],
    options?: { waitMs?: number },
  ): Promise<Outcome[]>;
  machinery(
    db: Database,
    viewer: ActorContext,
    ref: { entity: string; id: string },
    options?: { field?: string },
  ): Promise<Machinery>;
  withAsk<I, O>(
    db: Database,
    kind: AskKind<I, O>,
    input: I,
    options?: { scopes?: readonly ScopeRef[]; runId?: string | null },
  ): Promise<O>;
  /**
   * Emit keys for an entity writer's authored or catalog columns that some
   * reconciler reads; call it inside the writer's transaction.
   */
  emitWrites(
    db: Database,
    write: {
      table: PgTable;
      ids: readonly string[];
      columns: readonly string[];
      discovers?: readonly ScopeRef[];
    },
  ): Promise<number>;
  approveDrift(
    db: Database,
    actor: ActorContext,
    scope: ScopeRef,
    proposalHash: string,
  ): Promise<ApprovalOutcome>;
  approveDriftClass(
    db: Database,
    actor: ActorContext,
    kind: string,
  ): Promise<Record<ApprovalOutcome, number>>;
  startPass(
    db: Database,
    pass: Pass,
    options?: {
      key?: string;
      cursor?: Json | null;
      runId?: string | null;
      availableAt?: Date;
    },
  ): Promise<void>;
  /** The batched list binding: stage, actor, first gap and ETA for a page. */
  listRows(
    db: Database,
    capability: MachineryCapability,
    ids: readonly string[],
  ): Promise<Map<string, MachineryListRow>>;
  /** Run due kernel work within a time budget; returns units run. */
  run(db: Database, options: { budgetMs: number }): Promise<number>;
};

export function createKernel(modules: readonly DomainModule[]): Kernel {
  let registry: KernelRegistry | null = null;
  const kernelModule = defineModule({
    name: "kernel",
    passes: [versionSweepPass(() => registry!)],
  });
  registry = buildRegistry([kernelModule, ...modules]);
  const bound = registry;
  return {
    registry: bound,
    async append(db, rows, options) {
      const facts = await append(db, bound, rows, options);
      if (facts.length) await wakeAfterCommit(db);
      return facts;
    },
    async decide(db, actor, decisions, writers) {
      const refs = await decide(db, bound, actor, decisions, writers);
      if (refs.length) await wakeAfterCommit(db);
      return refs;
    },
    reconcileNow: (db, scopes, options) =>
      reconcileNow(db, bound, scopes, options),
    machinery: (db, viewer, ref, options) =>
      machinery(db, bound, viewer, ref, options),
    withAsk: (db, kind, input, options) =>
      withAsk(db, bound, kind, input, options),
    async emitWrites(db, write) {
      const name = getTableName(write.table);
      const read = bound
        .readers(name)
        .some((reader) =>
          reader.columns.some((column) => write.columns.includes(column)),
        );
      if (!read && !write.discovers?.length) return 0;
      const dirtied = await markDirty(repositoryQueries(db), bound, {
        keys: read ? write.ids.map((id) => rowKey(name, id)) : [],
        discovers: write.discovers,
        reason: `write:${name}`,
      });
      if (dirtied) await wakeAfterCommit(db);
      return dirtied;
    },
    approveDrift: (db, actor, scope, proposalHash) =>
      approveDrift(db, bound, actor, scope, proposalHash),
    approveDriftClass: (db, actor, kind) =>
      approveDriftClass(db, bound, actor, kind),
    startPass,
    listRows: (db, capability, ids) =>
      loadMachineryRows(db, bound, capability, ids),
    run: (db, options) => runKernel(db, bound, options),
  };
}

let production: Promise<Kernel> | null = null;

/** The production kernel over every module in `modules.ts`. */
export function productionKernel(): Promise<Kernel> {
  production ??= import("./modules").then(({ KERNEL_MODULES }) =>
    createKernel(KERNEL_MODULES),
  );
  return production;
}
