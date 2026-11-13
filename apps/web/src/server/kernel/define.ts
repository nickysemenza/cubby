/**
 * The kernel's declarations (ADR 0029 section 3). Everything here is pure:
 * a domain module calls these at import time, and the runtime reads the
 * resulting values. Nothing registers itself; `workflows/kernel-modules.ts`
 * lists every module explicitly.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { MachineryCapability } from "@cubby/schemas/kernel/capability";
import type {
  AskProducer,
  BindingBasis,
  KernelJson,
  KernelLane,
} from "@cubby/schemas/kernel/machinery";
import type {
  DecisionChannel,
  DecisionKind,
  KernelActor,
  KernelGap,
  KernelGapAction,
} from "@cubby/schemas/kernel/stage";
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
  keys(row: InferSelectModel<T>): Key[];
  discovers(row: InferSelectModel<T>): ScopeRef[];
  /** The member a viewer-owned row belongs to (an Email); others never see its details. */
  owner?(row: InferSelectModel<T>): string | null;
};

export function defineEvidence<T extends KeyedTable>(spec: {
  kind: string;
  table: T;
  keys(row: InferSelectModel<T>): Key[];
  discovers(row: InferSelectModel<T>): ScopeRef[];
  owner?(row: InferSelectModel<T>): string | null;
}): EvidenceKind<T> {
  return { type: "evidence", ...spec };
}

/** One evidence row to append: an insert-only observation. */
export type EvidenceRow = {
  readonly evidence: EvidenceKind;
  readonly values: ColumnValues;
};

/** A typed {@link EvidenceRow}. */
export const evidenceRow = <T extends KeyedTable>(
  evidence: EvidenceKind<T>,
  values: InferInsertModel<T>,
): EvidenceRow => ({ evidence, values });

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
  ask: { id: string; inputHash: string };
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

export type AskKind<I = unknown, O = unknown> = {
  readonly type: "ask";
  readonly feature: string;
  readonly producer: AskProducer;
  readonly promptVersion: string;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly policy: AskPolicy;
  readonly maxAttempts: number;
  /** Member-facing name of what this ask supplies, for its gap. */
  readonly label: string;
  // Methods, so an AskKind<I, O> is an AskKind of the registry's shared shape.
  /** Funding admission before the ask is marked sent; throws a wait to refuse. */
  admit?(db: Database): Promise<void>;
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
  label?: string;
  admit?(db: Database): Promise<void>;
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
    entity?: string;
    keys?: (row: InferSelectModel<T>) => Key[];
    discovers?: (row: InferSelectModel<T>) => ScopeRef[];
    merge?: MergePort;
    remove?: RemovePort;
  } = {},
): ColumnRef {
  return {
    table,
    name: getTableName(table),
    columns,
    entity: options.entity ?? null,
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
  ): void;
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
  /** A transaction that commits only while this claim is live. */
  fenced<T>(work: (tx: Database) => Promise<T>): Promise<T>;
};

export type PassResult = {
  cursor: Json | null;
  done: boolean;
  availableAt?: Date;
};

export type Pass = {
  readonly type: "pass";
  readonly name: string;
  readonly key?: (input: Json) => string;
  run(db: Database, cursor: Json | null, claim: Claim): Promise<PassResult>;
};

export function definePass(spec: {
  name: string;
  key?(input: Json): string;
  run(db: Database, cursor: Json | null, claim: Claim): Promise<PassResult>;
}): Pass {
  return { type: "pass", ...spec };
}

export type DomainModule = {
  readonly type: "module";
  readonly name: string;
  readonly entities: readonly string[];
  readonly evidence: readonly EvidenceKind[];
  readonly asks: readonly AskKind[];
  readonly reconcilers: readonly Reconciler[];
  readonly passes: readonly Pass[];
  readonly machinery: readonly MachineryCapability[];
};

export function defineModule(spec: {
  name: string;
  entities?: readonly string[];
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
};
