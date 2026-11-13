/**
 * The kernel's one entry module (ADR 0029 section 3). Domain modules import
 * the declarations; repositories, commands, imports and MCP tools call the
 * runtime functions, which run against the production module list.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { MachineryCapability } from "@cubby/schemas/kernel/capability";
import type { Machinery } from "@cubby/schemas/kernel/machinery";
import type { NeedsYouPage, RunWork } from "@cubby/schemas/kernel/work";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

import type { AskWaiters } from "./ask";
import { cancelClaimable } from "./claim";
import type { DecisionWriters } from "./decide";
import type {
  AskKind,
  ColumnRef,
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
import type { MergeVerdict } from "./identity";
import { productionKernel } from "./kernel";
import type { MachineryListRow } from "./projection";
import type { OwnedReferenceRepoint } from "./repoint";

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
  type ClaimLimit,
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
  type PassResult,
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
export {
  AskAbandonedError,
  AskExhaustedError,
  AskUnknownError,
  type AskWaiters,
} from "./ask";
export { householdWrite, HouseholdWriteBusyError } from "./gate";
export { OwnedColumnWriteError } from "~/server/db/owned-columns";
export {
  entityMerge,
  entityRemoval,
  resolveForRead,
  resolveForWrite,
  type MergeVerdict,
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
  options?: { waitMs?: number; runId?: string },
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
  options?: AskWaiters,
): Promise<O> {
  return (await productionKernel()).withAsk(db, kind, input, options);
}

/**
 * Emit keys for authored or catalog columns a reconciler reads, inside the
 * writer's transaction. The shared entity writers call this themselves.
 */
export async function emitWrites(
  db: Database,
  write: {
    table: PgTable | string;
    ids: readonly string[];
    columns: readonly string[];
    discovers?: readonly ScopeRef[];
    entity?: string;
    created?: boolean;
  },
): Promise<number> {
  return (await productionKernel()).emitWrites(db, write);
}

/** Merge two records under the write gate, settling which scope owns the survivor. */
export async function merge(
  db: Database,
  request: {
    target: ColumnRef;
    a: string;
    b: string;
    basis: "proof" | "decision";
    actor?: ActorContext;
  },
): Promise<MergeVerdict> {
  return (await productionKernel()).merge(db, request);
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
  pass: Pass | string,
  options?: {
    key?: string;
    cursor?: Json | null;
    runId?: string | null;
    availableAt?: Date;
  },
): Promise<void> {
  const kernel = await productionKernel();
  const registered =
    typeof pass === "string" ? kernel.registry.passes.get(pass) : pass;
  if (!registered) throw new Error(`Unknown pass ${pass}`);
  return kernel.startPass(db, registered, options);
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

/** Repoint a reconciler-owned foreign key inside a merge/removal policy transaction. */
export async function repointOwnedReference(
  tx: Database,
  request: OwnedReferenceRepoint,
): Promise<number> {
  return (await productionKernel()).repointOwnedReference(tx, request);
}
export type { OwnedReferenceRepoint } from "./repoint";

/** A registered entity's machinery capability, or null when it has none. */
export async function machineryCapability(
  entity: string,
): Promise<MachineryCapability | null> {
  return (await productionKernel()).machineryCapability(entity);
}

/** Public records awaiting a member's input, oldest first. */
export async function needsYou(
  db: Database,
  options?: { limit?: number; offset?: number },
): Promise<NeedsYouPage> {
  return (await productionKernel()).needsYou(db, options);
}

/** The scopes, asks and Pass instances carrying a Run, from one snapshot. */
export async function runWork(db: Database, runId: string): Promise<RunWork> {
  return (await productionKernel()).runWork(db, runId);
}

export {
  queueAsk,
  claimExternalAsk,
  renewExternalAsk,
  releaseExternalAsk,
  cancelExternalAsk,
  settleExternalAsk,
  type ExternalAskClaim,
} from "./ask";
export { cancelRunAsks, retryRunAsks } from "./requesters";
