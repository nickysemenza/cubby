/**
 * The kernel's declarations (ADR 0029 section 3). Everything here is pure:
 * a domain module calls these at import time, and the runtime reads the
 * resulting values. Nothing registers itself; `workflows/kernel-modules.ts`
 * lists every module explicitly.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { EdgeDefinition } from "@cubby/schemas/entity-definitions/edges";
import type { MachineryCapability } from "@cubby/schemas/kernel/capability";
import type {
  AskProducer,
  BindingBasis,
  KernelJson,
  KernelLane,
  KernelWaitCause,
} from "@cubby/schemas/kernel/machinery";
import type {
  DecisionChannel,
  DecisionKind,
  KernelActor,
  KernelGap,
  KernelGapAction,
} from "@cubby/schemas/kernel/stage";
import type { ShortcodeType } from "@cubby/shared";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { z } from "zod";

import type { Database } from "~/server/db/database";

import type { Reads } from "./reads";
import type { ColumnValues } from "./row";

export type { ColumnValues } from "./row";

export type Key = string;
export type ScopeRef = { readonly kind: string; readonly key: string };
export type FactRef = { readonly kind: string; readonly id: string };
export type Json = KernelJson;

/** A table whose rows carry a uuid `id`: evidence, reconciled records. */
export type KeyedTable = PgTable & { id: PgTable["_"]["columns"][string] };

export type EvidenceKind<T extends KeyedTable = KeyedTable> = {
  readonly type: "evidence";
  readonly kind: string;
  readonly table: T;
  /** Reserve this entity's identity and shortcode atomically with the observation. */
  readonly entity?: ShortcodeType;
  keys(row: InferSelectModel<T>): Key[];
  discovers(row: InferSelectModel<T>): ScopeRef[];
  /** User id, or an indirect owner key when `resolveOwners` is declared. */
  owner?(row: InferSelectModel<T>): string | null;
  /** Resolve indirect owners once per batch; an unresolved owner stays private. */
  resolveOwners?(
    db: Database,
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>>;
};

type EvidenceSpec<T extends KeyedTable> = {
  kind: string;
  table: T;
  entity?: ShortcodeType;
  keys(row: InferSelectModel<T>): Key[];
  discovers(row: InferSelectModel<T>): ScopeRef[];
  owner?(row: InferSelectModel<T>): string | null;
  resolveOwners?(
    db: Database,
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>>;
};

export function defineEvidence<T extends KeyedTable>(
  spec: EvidenceSpec<T> & { entity: ShortcodeType },
): EvidenceKind<T> & { entity: ShortcodeType };
export function defineEvidence<T extends KeyedTable>(
  spec: EvidenceSpec<T>,
): EvidenceKind<T>;
export function defineEvidence<T extends KeyedTable>(
  spec: EvidenceSpec<T>,
): EvidenceKind<T> {
  return { type: "evidence", ...spec };
}

/** One evidence row to append: an insert-only observation. */
export type EvidenceRow = {
  readonly evidence: EvidenceKind;
  readonly values: ColumnValues;
};

/** A typed {@link EvidenceRow}. */
export function evidenceRow<T extends KeyedTable>(
  evidence: EvidenceKind<T> & { entity: ShortcodeType },
  values: Omit<InferInsertModel<T>, "shortcode"> & { shortcode?: string },
): EvidenceRow;
export function evidenceRow<T extends KeyedTable>(
  evidence: EvidenceKind<T>,
  values: InferInsertModel<T>,
): EvidenceRow;
export function evidenceRow(
  evidence: EvidenceKind,
  values: ColumnValues,
): EvidenceRow {
  return { evidence, values };
}

/** What a producer returned; the kernel commits it as an `Answer`. */
export type Produced<O> = {
  output: O;
  model?: string | null;
  tier?: string | null;
  costMicros?: number | null;
  /** The provider's raw response, capped at 256 KB when stored. */
  raw?: string | null;
};

export type ProduceContext = {
  db: Database;
  signal: AbortSignal;
  ask: { id: string; inputHash: string; promptVersion?: string };
  runId: string | null;
};

/**
 * The requested policy the input envelope covers: a deliberate tier change
 * re-asks, a funding-route substitution does not (section 1).
 */
export type AskPolicy = {
  tier?: string;
  model?: string;
  parameters?: Json;
  /** Names the output schema when it has no JSON Schema form; bump it on change. */
  outputRevision?: string;
};

/** Household-wide admission shared by Ask and Pass claims. */
export type ClaimLimit = { readonly partition: string; readonly slots: number };

export type AskKind<I = unknown, O = unknown> = {
  readonly type: "ask";
  readonly feature: string;
  readonly producer: AskProducer;
  readonly promptVersion: string;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly policy: AskPolicy;
  readonly maxAttempts: number;
  readonly claimLimit?: ClaimLimit;
  /** Member-facing name of what this ask supplies, for its gap. */
  readonly label: string;
  // Methods, so an AskKind<I, O> is an AskKind of the registry's shared shape.
  /** Funding admission before the ask is marked sent; throws a wait to refuse. */
  admit?(
    db: Database,
    context: { runId: string | null; askId: string; background: boolean },
  ): Promise<void>;
  /** Places the call; reads only its declared input. */
  produce?(input: I, context: ProduceContext): Promise<Produced<O>>;
  /** Estimated cost of one call, for drift proposals. */
  estimateCostMicros?(input: I): number;
};

export function defineAsk<I, O>(spec: {
  feature: string;
  producer: AskProducer;
  promptVersion: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  policy?: AskPolicy;
  maxAttempts?: number;
  claimLimit?: ClaimLimit;
  label?: string;
  admit?(
    db: Database,
    context: { runId: string | null; askId: string; background: boolean },
  ): Promise<void>;
  produce?(input: I, context: ProduceContext): Promise<Produced<O>>;
  estimateCostMicros?(input: I): number;
}): AskKind<I, O> {
  return {
    type: "ask",
    ...spec,
    policy: spec.policy ?? {},
    maxAttempts: spec.maxAttempts ?? 3,
    label: spec.label ?? spec.feature,
  };
}

/** A declared read: a table's columns, an evidence kind, or the kernel's bindings. */
export type SourceRef =
  | {
      readonly type: "table";
      readonly table: PgTable;
      readonly name: string;
      readonly columns: readonly string[];
    }
  | { readonly type: "evidence"; readonly evidence: EvidenceKind }
  | { readonly type: "bindings" };

export const source = {
  table: <T extends PgTable>(
    table: T,
    columns: readonly (keyof T["_"]["columns"] & string)[],
  ): SourceRef => ({
    type: "table",
    table,
    name: getTableName(table),
    columns,
  }),
  evidence: <T extends KeyedTable>(evidence: EvidenceKind<T>): SourceRef => ({
    type: "evidence",
    evidence,
  }),
  bindings: { type: "bindings" } as const satisfies SourceRef,
};

/**
 * A merge policy port the owning domain supplies: it runs the entity's
 * declared merge (generic/merge `applyMergePolicy` and `finalizeMerge`)
 * inside the apply transaction.
 */
export type MergePort = (
  tx: Database,
  merge: { keepId: string; loserIds: readonly string[]; actor: ActorContext },
) => Promise<void>;

/** Removes records inside the apply transaction (generic/removal for entities). */
export type RemovePort = (
  tx: Database,
  ids: readonly string[],
) => Promise<void>;

/** What a record that should no longer exist becomes. */
export type Disposition = "remove" | "keep";

/** A declared write: columns of one reconciled table. */
export type ColumnRef = {
  /** A record table (with `id`), or the kernel's own binding table. */
  readonly table: PgTable;
  readonly name: string;
  readonly columns: readonly string[];
  /** Authored catalog values supplied on creation; never owned or re-derived. */
  readonly createOnly?: readonly string[];
  /** Equal Catalog natural keys may share one creation in a coherent batch. */
  readonly coalesceCreation?: (values: readonly ColumnValues[]) => ColumnValues;
  /** The manifest entity, when the table is an entity's; drives change records and removal. */
  readonly entity: string | null;
  /** Fact keys of a written row, so downstream readers find it. */
  readonly keys?: (row: ColumnValues) => Key[];
  /** Scopes a written row starts, other than the writer's own. */
  readonly discovers?: (row: ColumnValues) => ScopeRef[];
  readonly merge?: MergePort;
  /**
   * The entity's transactional delete policy (`entityRemoval` for an entity
   * table); without one a record is soft deleted, or deleted when the table
   * has no `deletedAt`.
   */
  readonly remove?: RemovePort;
};

export function writes<T extends KeyedTable>(
  table: T,
  columns: readonly (keyof T["_"]["columns"] & string)[],
  options: {
    createOnly?: readonly (keyof T["_"]["columns"] & string)[];
    coalesceCreation?: (values: readonly ColumnValues[]) => ColumnValues;
    entity?: string;
    keys?: (row: InferSelectModel<T>) => Key[];
    discovers?: (row: InferSelectModel<T>) => ScopeRef[];
    merge?: MergePort;
    remove?: RemovePort;
  } = {},
): ColumnRef {
  if (
    options.coalesceCreation &&
    (columns.length > 0 || !options.createOnly?.length)
  )
    throw new Error("Only authored Catalog creations may coalesce");
  return {
    table,
    name: getTableName(table),
    columns,
    entity: options.entity ?? null,
    createOnly: options.createOnly ?? [],
    coalesceCreation: options.coalesceCreation,
    // SAFETY: the kernel passes rows read from or written to this table.
    keys: options.keys as ColumnRef["keys"],
    // SAFETY: as above.
    discovers: options.discovers as ColumnRef["discovers"],
    merge: options.merge,
    remove: options.remove,
  };
}

export type Binding = {
  fact: FactRef;
  eventKey: string;
  basis: BindingBasis;
  scope: ScopeRef;
};

export type AnsweredValue<O> = {
  readonly status: "answered";
  readonly output: O;
  readonly inputHash: string;
};
export type Missing = { readonly status: "missing"; readonly inputHash: null };

export type DecisionInForce = {
  readonly id: string;
  readonly kind: DecisionKind;
  readonly value: Json | null;
  /** A veto channel's vetoed values in force. */
  readonly values: readonly Json[];
  readonly at: Date;
};

export type GapOptions = {
  since?: Date | null;
  actions?: readonly KernelGapAction[];
};

/** The reconciler's pure context: no database, clock or network. */
export interface Pure {
  /** Identity only; declaring it does not insert a record or reserve storage. */
  identity(
    target: ColumnRef,
    naturalKey: string,
  ): { id: string; shortcode: string | null };
  /** Every assignment in force for a subject, keyed by field. */
  assignments(subject: string): ReadonlyMap<string, DecisionInForce>;
  /** Resolve a retained id or shortcode through identity redirects on reads. */
  reference(entity: ShortcodeType, ref: string): string | null;
  /** `request: false` reads an existing answer without owing a producer call. */
  answer<I, O>(
    kind: AskKind<I, O>,
    input: I,
    options?: { request?: boolean },
  ): AnsweredValue<O> | Missing;
  /**
   * The decision in force: by field (assignment, veto), by the other subject
   * (identity), or for the subject alone (rejection).
   */
  decision(
    channel: DecisionChannel,
    subject: string,
    slot?: string | null,
  ): DecisionInForce | null;
  /** The natural keys this scope owns now, for each declared write table. */
  existing(target: ColumnRef): readonly string[];
  /** The id of a record this scope owns, for decisions about it; null before it exists. */
  recordId(target: ColumnRef, naturalKey: string): string | null;
  record(
    target: ColumnRef,
    naturalKey: string,
    values: ColumnValues,
    options?: { provenance?: Record<string, string> },
  ): string;
  /**
   * Set declared columns of an existing record another scope owns (a
   * `fields` scope's `apply: "auto"` columns). Never creates or removes it.
   */
  patch(target: ColumnRef, id: string, values: ColumnValues): void;
  /** The explicit disposition of a record that should no longer exist. */
  retire(target: ColumnRef, naturalKey: string, disposition: Disposition): void;
  bind(fact: FactRef, eventKey: string, basis?: "proven" | "decision"): void;
  /** Merge two owned records; `proof` merges only in the one automatic case. */
  merge(
    target: ColumnRef,
    survivor: string,
    absorbed: string,
    basis: "proof" | "decision",
  ): void;
  emit(scope: ScopeRef): void;
  /** Accepted inputs disagree without a safe automatic replacement. Applies no records. */
  disagree(input: string): void;
  gap: {
    evidence(input: string, actor: KernelActor, options?: GapOptions): void;
    answer(input: string, actor: KernelActor, options?: GapOptions): void;
    decision(input: string, options?: GapOptions): void;
    time(input: string, until: Date, options?: GapOptions): void;
    unsupported(input: string, options?: GapOptions): void;
  };
  done(): Desired;
}

/** What a reconcile returns: built only through {@link Pure}. */
export type Desired = {
  readonly disagreements: readonly string[];
  readonly records: readonly DesiredRecord[];
  readonly patches: readonly {
    target: ColumnRef;
    id: string;
    values: Readonly<ColumnValues>;
  }[];
  readonly retired: readonly {
    target: ColumnRef;
    naturalKey: string;
    disposition: Disposition;
  }[];
  readonly bindings: readonly {
    fact: FactRef;
    eventKey: string;
    basis: "proven" | "decision";
  }[];
  readonly merges: readonly {
    target: ColumnRef;
    survivor: string;
    absorbed: string;
    basis: "proof" | "decision";
  }[];
  readonly emits: readonly ScopeRef[];
  readonly gaps: readonly KernelGap[];
  readonly asks: readonly { kind: AskKind; input: unknown }[];
};

export type DesiredRecord = {
  readonly id: string;
  readonly shortcode: string | null;
  readonly target: ColumnRef;
  readonly naturalKey: string;
  readonly values: Readonly<ColumnValues>;
  readonly provenance: Readonly<Record<string, string>>;
};

export type Reconciler<In = unknown> = {
  readonly type: "reconciler";
  readonly scope: string;
  readonly lane: KernelLane;
  readonly version: number;
  readonly after: readonly string[];
  readonly reads: readonly SourceRef[];
  readonly writes: readonly ColumnRef[];
  /** The asks `reconcile` may read; their prompt versions are part of its rules. */
  readonly asks: readonly AskKind[];
  /** The version and ask prompt versions a `ScopeState` was derived under. */
  readonly rules: string;
  load(reads: Reads, keys: readonly string[]): Promise<Map<string, In>>;
  reconcile(input: In, c: Pure): Desired;
};

export function defineReconciler<In>(spec: {
  scope: string;
  lane: KernelLane;
  version: number;
  after?: string[];
  reads: SourceRef[];
  writes: ColumnRef[];
  asks?: readonly AskKind[];
  load(reads: Reads, keys: readonly string[]): Promise<Map<string, In>>;
  reconcile(input: In, c: Pure): Desired;
}): Reconciler<In> {
  const asks = spec.asks ?? [];
  return {
    type: "reconciler",
    ...spec,
    after: spec.after ?? [],
    asks,
    rules: [
      `v${spec.version}`,
      ...asks.map((ask) => `${ask.feature}@${ask.promptVersion}`).sort(),
    ].join("|"),
  };
}

/** A claim lent to a pass run; its writes publish only while it is live. */
export type Claim = {
  readonly token: string;
  readonly deadline: Date;
  readonly signal: AbortSignal;
  /** Extends the deadline; false once the claim lapsed or was cancelled. */
  renew(): Promise<boolean>;
  /** Verify ownership inside the caller's publishing transaction. */
  fence(tx: Database): Promise<void>;
  /** A transaction that commits only while this claim is live. */
  fenced<T>(work: (tx: Database) => Promise<T>): Promise<T>;
};

export type PassResult = {
  cursor: Json | null;
  done: boolean;
  availableAt?: Date;
  waitCause?: KernelWaitCause;
};

export type Pass = {
  readonly type: "pass";
  readonly claimLimit?: ClaimLimit;
  readonly name: string;
  readonly key?: (input: Json) => string;
  run(db: Database, cursor: Json | null, claim: Claim): Promise<PassResult>;
};

export function definePass(spec: {
  name: string;
  claimLimit?: ClaimLimit;
  key?(input: Json): string;
  run(db: Database, cursor: Json | null, claim: Claim): Promise<PassResult>;
}): Pass {
  return { type: "pass", ...spec };
}

export type DomainModule = {
  readonly type: "module";
  readonly name: string;
  readonly entities: readonly string[];
  readonly edges: readonly EdgeDefinition[];
  readonly evidence: readonly EvidenceKind[];
  readonly asks: readonly AskKind[];
  readonly reconcilers: readonly Reconciler[];
  readonly passes: readonly Pass[];
  readonly machinery: readonly MachineryCapability[];
};

export function defineModule(spec: {
  name: string;
  entities?: readonly string[];
  edges?: readonly EdgeDefinition[];
  evidence?: readonly EvidenceKind[];
  asks?: readonly AskKind[];
  reconcilers?: readonly Reconciler[];
  passes?: readonly Pass[];
  machinery?: readonly MachineryCapability[];
}): DomainModule {
  return {
    type: "module",
    name: spec.name,
    entities: spec.entities ?? [],
    edges: spec.edges ?? [],
    evidence: spec.evidence ?? [],
    asks: spec.asks ?? [],
    reconcilers: spec.reconcilers ?? [],
    passes: spec.passes ?? [],
    machinery: spec.machinery ?? [],
  };
}

/** A decision to record. `slot` is the field, the vetoed value's field, or the other subject. */
export type DecisionInput = {
  channel: DecisionChannel;
  kind: DecisionKind;
  subject: string;
  /** assignment and veto: the field; identity: the other subject. */
  field?: string | null;
  value?: Json | null;
  proposalHash?: string | null;
  /** Scopes this decision starts beyond those that read its subject. */
  scopes?: readonly ScopeRef[];
};
export type DecisionRef = { id: string; subject: string };

export type Outcome = {
  scope: ScopeRef;
  status: "applied" | "conflict" | "failed" | "waiting" | "clean";
  gaps: readonly KernelGap[];
  error?: string;
  /** Original failure for transactional writers; persisted diagnostics use error. */
  cause?: unknown;
};
