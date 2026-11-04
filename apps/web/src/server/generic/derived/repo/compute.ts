import {
  storedFieldDecision,
  type StoredFieldDecision,
} from "@cubby/schemas/derived-value";
import type { Entity } from "@cubby/schemas/entity";
import { storedResultSchemas } from "@cubby/schemas/entity-stored-derived";
import type { SQL } from "drizzle-orm";

/**
 * The compute seam for stored derived values. An adapter receives a batch of
 * record ids and returns each live record's value; an id absent from the
 * result has no value (deleted, or not applicable) and its stored row is
 * removed. Adapters read authoritative inputs only, never another stored
 * derived value unless the declaration lists it in `dependsOn`.
 */
import type { Database, DrizzleTransaction } from "~/server/db";
import type { WorkItem } from "~/server/generic/jobs/repo/work-items";

/** Current target IDs reached from an input's source-reference relation. */
export type DerivedFanoutSelection = (refs: SQL) => SQL;

export interface DerivedComputed {
  /** The published value; JSON. */
  readonly value: unknown;
  /** The typed projection lists sort and filter on. */
  readonly sort: number | string | null;
  /** Override the default computed mechanism when an assignment or resolver decides. */
  readonly decision?: StoredFieldDecision;
  /** Paid work only: the hash of the declared input projection. */
  readonly inputHash?: string | null;
}

/** An absent scalar is a successful empty computation; omitted records remain missing. */
export function computedDecision(
  computed: DerivedComputed,
): StoredFieldDecision {
  const hasValue = computed.value !== null && computed.value !== undefined;
  const decision = storedFieldDecision.parse(
    computed.decision ?? {
      outcome: hasValue
        ? { kind: "value" }
        : { kind: "empty", reason: "unset" },
      provenance: { kind: "computed" },
    },
  );
  if ((decision.outcome.kind === "value") !== hasValue)
    throw new Error("Derived outcome does not match its published value");
  return decision;
}

/** Both publication and live comparison validate the declaration's complete result. */
export function validateComputedResult({
  target,
  computed,
}: {
  target: string;
  computed: DerivedComputed;
}): DerivedComputed & { readonly decision: StoredFieldDecision } {
  const schema = storedResultSchemas[target];
  const selected = schema
    ? { ...computed, value: schema.parse(computed.value) }
    : computed;
  return { ...selected, decision: computedDecision(selected) };
}

export type DerivedCompute = {
  (
    db: Database | DrizzleTransaction,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, DerivedComputed>>;
  /** Maximum same-adapter records sharing a preparation page; omitted keeps the conservative default. */
  readonly preparationBatchSize?: number;
  readonly sharedPreparation?: DerivedSharedPreparation;
  readonly fanoutSelections?: Readonly<Record<string, DerivedFanoutSelection>>;
};

export interface DerivedSharedPreparation<Prepared = unknown> {
  readonly source: object;
  prepare(
    db: Database | DrizzleTransaction,
    ids: readonly string[],
  ): Promise<Prepared>;
  project(
    prepared: Prepared,
    ids: readonly string[],
  ): ReadonlyMap<string, DerivedComputed>;
}

/** One immutable authoritative input set, shared only by a preparation page. */
export const sharedDerivedPreparation =
  <Prepared>(
    prepare: (
      db: Database | DrizzleTransaction,
      ids: readonly string[],
    ) => Promise<Prepared>,
  ) =>
  (
    project: (
      prepared: Prepared,
      ids: readonly string[],
    ) => ReadonlyMap<string, DerivedComputed>,
  ): DerivedCompute =>
    Object.assign(
      async (db: Database | DrizzleTransaction, ids: readonly string[]) =>
        project(await prepare(db, ids), ids),
      {
        sharedPreparation: {
          source: prepare,
          prepare,
          // SAFETY: the source token identifies this exact preparation function.
          project: (prepared: unknown, ids: readonly string[]) =>
            project(prepared as Prepared, ids),
        },
      },
    );

/** One sink publication's reader notification, committed with its transaction. */
interface DerivedSinkPublication {
  /** Exact held tickets; staged output must belong to this invalidation generation. */
  readonly tickets: ReadonlyMap<string, number>;
  /**
   * Ring these entity records through the drain's bounded publication. An
   * internal record's refs are not entity ids, so its sink names the old and
   * new entities each change affected.
   */
  notify(entity: Entity, ids: readonly string[]): void;
}

/** Staging may commit while its original source work stays owed without an attempt. */
interface DerivedSinkContinuation {
  readonly changed: readonly string[];
  readonly retain: readonly string[];
  /** Exact peer generations whose identical effect committed with this publication. */
  readonly covered?: readonly WorkItem[];
}

/**
 * An adapter whose output lives in its own table (search documents, recipe
 * totals, conversion coverage) rather than `DerivedValue`. `prepare` runs
 * outside the publication transaction; `publish` writes only the ids whose
 * marks are still current and returns those whose output changed.
 */
export interface DerivedSink<Prepared = unknown> {
  readonly kind: "sink";
  readonly preparationBatchSize?: number;
  /**
   * An internal record's whole fanout selector: given source refs as one `id`
   * column, its query returns current and retained target ids as `id`.
   */
  readonly fanoutSelections?: Readonly<Record<string, DerivedFanoutSelection>>;
  prepare(db: Database, ids: readonly string[]): Promise<Prepared>;
  /**
   * Refs `prepare` could not prepare, with their errors. Each settles like a
   * failed target's item while its siblings publish. A ref outside the claimed
   * page fails the whole target. A missing input is an error here, never an
   * empty output.
   */
  preparationFailures?(prepared: Prepared): ReadonlyMap<string, unknown>;
  /** Reuse the sink's snapshot observations and complete source/peer relevance rule. */
  publicationBlocked?(prepared: Prepared, ids: readonly string[]): SQL;
  /** `tx` is the publication transaction's repository handle. */
  publish(
    tx: Database,
    ids: readonly string[],
    prepared: Prepared,
    publication: DerivedSinkPublication,
  ): Promise<readonly string[] | DerivedSinkContinuation>;
}

export type DerivedAdapter = DerivedCompute | DerivedSink;

/** A sink adapter with its prepared type erased for the registry. */
export const derivedSink = <Prepared>(
  sink: Omit<DerivedSink<Prepared>, "kind">,
): DerivedSink => {
  const blocked = sink.publicationBlocked;
  return {
    kind: "sink",
    preparationBatchSize: sink.preparationBatchSize,
    fanoutSelections: sink.fanoutSelections,
    prepare: sink.prepare,
    // SAFETY: the drain hands `preparationFailures` and `publish` exactly the
    // value this sink's own `prepare` returned for the same page.
    preparationFailures: (prepared) =>
      sink.preparationFailures?.(prepared as Prepared) ?? new Map(),
    publicationBlocked: blocked
      ? (prepared, ids) =>
          // SAFETY: the drain supplies this sink's own preparation result.
          blocked(prepared as Prepared, ids)
      : undefined,
    // SAFETY: publish receives this sink's own preparation result for the same page.
    publish: (tx, ids, prepared, publication) =>
      sink.publish(tx, ids, prepared as Prepared, publication),
  };
};

export const isDerivedSink = (
  adapter: DerivedAdapter,
): adapter is DerivedSink =>
  typeof adapter === "object" && adapter.kind === "sink";

export type DerivedComputes = Readonly<Record<string, DerivedAdapter>>;
