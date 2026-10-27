import {
  storedFieldDecision,
  type StoredFieldDecision,
} from "@cubby/schemas/derived-value";

/**
 * The compute seam for stored derived values. An adapter receives a batch of
 * record ids and returns each live record's value; an id absent from the
 * result has no value (deleted, or not applicable) and its stored row is
 * removed. Adapters read authoritative inputs only, never another stored
 * derived value unless the declaration lists it in `dependsOn`.
 */
import type { Database, DrizzleTransaction } from "~/server/db";

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

export type DerivedCompute = (
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) => Promise<ReadonlyMap<string, DerivedComputed>>;

/**
 * An adapter whose output lives in its own table (search documents, recipe
 * totals, conversion coverage) rather than `DerivedValue`. `prepare` runs
 * outside the publication transaction; `publish` writes only the ids whose
 * marks are still current and returns those whose output changed.
 */
export interface DerivedSink<Prepared = unknown> {
  readonly kind: "sink";
  prepare(db: Database, ids: readonly string[]): Promise<Prepared>;
  /** `tx` is the publication transaction's repository handle. */
  publish(
    tx: Database,
    ids: readonly string[],
    prepared: Prepared,
  ): Promise<readonly string[]>;
}

export type DerivedAdapter = DerivedCompute | DerivedSink;

/** A sink adapter with its prepared type erased for the registry. */
export const derivedSink = <Prepared>(
  sink: Omit<DerivedSink<Prepared>, "kind">,
): DerivedSink => ({
  kind: "sink",
  prepare: sink.prepare,
  // SAFETY: the drain hands `publish` exactly the value this sink's own
  // `prepare` returned for the same page.
  publish: (tx, ids, prepared) => sink.publish(tx, ids, prepared as Prepared),
});

export const isDerivedSink = (
  adapter: DerivedAdapter,
): adapter is DerivedSink =>
  typeof adapter === "object" && adapter.kind === "sink";

export type DerivedComputes = Readonly<Record<string, DerivedAdapter>>;
