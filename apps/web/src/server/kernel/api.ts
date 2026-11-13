/**
 * The kernel's one entry module (ADR 0029 section 3). Domain modules import
 * the declarations; repositories, commands, imports and MCP tools call the
 * runtime functions, which run against the production module list.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { MachineryCapability } from "@cubby/schemas/kernel/capability";
import type { Machinery } from "@cubby/schemas/kernel/machinery";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

import { cancelClaimable } from "./claim";
import type { DecisionWriters } from "./decide";
import type {
  AskKind,
  DecisionInput,
  DecisionRef,
  EvidenceRow,
  FactRef,
  Json,
  Outcome,
  Pass,
  ScopeRef,
} from "./define";
import type { ApprovalOutcome } from "./drift";
import { productionKernel } from "./kernel";
import type { MachineryListRow } from "./projection";

export {
  defineAsk,
  defineEvidence,
  defineModule,
  definePass,
  defineReconciler,
  evidenceRow,
  source,
  writes,
  type AskKind,
  type Binding,
  type Claim,
  type ColumnRef,
  type AnsweredValue,
  type DecisionInForce,
  type DecisionInput,
  type DecisionRef,
  type Desired,
  type Disposition,
  type DomainModule,
  type EvidenceKind,
  type EvidenceRow,
  type FactRef,
  type GapOptions,
  type Key,
  type MergePort,
  type Missing,
  type Outcome,
  type Pass,
  type Produced,
  type ProduceContext,
  type Pure,
  type Reconciler,
  type RemovePort,
  type ScopeRef,
  type SourceRef,
} from "./define";
export type { DecisionWriters, StoredDecision } from "./decide";
export type { Reads, ScopeReads } from "./reads";
export { effectiveBindings } from "./reads";
export { bindingWrites } from "./registry";
export { AskExhaustedError, AskUnknownError } from "./ask";
export { householdWrite, HouseholdWriteBusyError } from "./gate";
export {
  entityRemoval,
  mergeRecords,
  resolveForRead,
  resolveForWrite,
} from "./identity";
export {
  decisionKey,
  driftSubject,
  legacyKey,
  recordSubject,
  rowKey,
} from "./keys";
export {
  MACHINERY_DONE,
  machineryActorSql,
  machineryListFields,
  machineryStageSql,
  type MachineryListRow,
} from "./projection";
export { createKernel, type Kernel } from "./kernel";

/** Append evidence rows; returns the facts inserted (a duplicate inserts nothing). */
export async function append(
  db: Database,
  rows: readonly EvidenceRow[],
  options?: { runId?: string | null },
): Promise<FactRef[]> {
  return (await productionKernel()).append(db, rows, options);
}

/** Record decisions; a field decision on an authored entity runs `writers.field` in the same transaction. */
export async function decide(
  db: Database,
  actor: ActorContext,
  decisions: readonly DecisionInput[],
  writers?: DecisionWriters,
): Promise<DecisionRef[]> {
  return (await productionKernel()).decide(db, actor, decisions, writers);
}

/** Run scopes now for a waiting member, with the 2 s member lock timeout. */
export async function reconcileNow(
  db: Database,
  scopes: readonly ScopeRef[],
  options?: { waitMs?: number },
): Promise<Outcome[]> {
  return (await productionKernel()).reconcileNow(db, scopes, options);
}

/** A record's machinery from one snapshot, checked against the viewer. */
export async function machinery(
  db: Database,
  viewer: ActorContext,
  ref: { entity: string; id: string },
  options?: { field?: string },
): Promise<Machinery> {
  return (await productionKernel()).machinery(db, viewer, ref, options);
}

/** A producer call through its Ask: the committed Answer, or one call under the kernel's claims. */
export async function withAsk<I, O>(
  db: Database,
  kind: AskKind<I, O>,
  input: I,
  options?: { scopes?: readonly ScopeRef[]; runId?: string | null },
): Promise<O> {
  return (await productionKernel()).withAsk(db, kind, input, options);
}

/** Emit keys for authored or catalog columns a reconciler reads; call inside the writer's transaction. */
export async function emitWrites(
  db: Database,
  write: {
    table: PgTable;
    ids: readonly string[];
    columns: readonly string[];
    discovers?: readonly ScopeRef[];
  },
): Promise<number> {
  return (await productionKernel()).emitWrites(db, write);
}

/** Approve one Drift proposal by its hash. */
export async function approveDrift(
  db: Database,
  actor: ActorContext,
  scope: ScopeRef,
  proposalHash: string,
): Promise<ApprovalOutcome> {
  return (await productionKernel()).approveDrift(
    db,
    actor,
    scope,
    proposalHash,
  );
}

/** Approve every current proposal of one scope kind. */
export async function approveDriftClass(
  db: Database,
  actor: ActorContext,
  kind: string,
): Promise<Record<ApprovalOutcome, number>> {
  return (await productionKernel()).approveDriftClass(db, actor, kind);
}

/** Start a pass instance (a Run's work, retention, a one-off rebuild). */
export async function startPass(
  db: Database,
  pass: Pass,
  options?: {
    key?: string;
    cursor?: Json | null;
    runId?: string | null;
    availableAt?: Date;
  },
): Promise<void> {
  return (await productionKernel()).startPass(db, pass, options);
}

/** The batched list binding for one entity's page of records. */
export async function loadMachineryRows(
  db: Database,
  capability: MachineryCapability,
  ids: readonly string[],
): Promise<Map<string, MachineryListRow>> {
  return (await productionKernel()).listRows(db, capability, ids);
}

/** Request cancellation of an ask or a pass; a live holder stops at its next renewal or fence. */
export async function cancelWork(
  db: Database,
  target:
    | { table: "Ask"; id: string }
    | { table: "Pass"; name: string; key: string },
): Promise<void> {
  await cancelClaimable(repositoryQueries(db), target);
}

/** Run due kernel work within a time budget; the background drain's page. */
export async function runProductionKernel(
  db: Database,
  options: { budgetMs: number },
): Promise<number> {
  return (await productionKernel()).run(db, options);
}
