/**
 * The difference engine (ADR 0029 section 6): Desired against what the
 * scope owns now. Pure; the apply turns the result into set-based writes and
 * the version sweep turns it into a Drift proposal.
 */
import type { Computed } from "./compute";
import type { ColumnRef, ColumnValues, FactRef, Json } from "./define";
import { canonicalJson } from "./keys";
import { KernelContractError } from "./reads";

export type Difference = {
  inserts: {
    target: ColumnRef;
    naturalKey: string;
    id: string;
    values: ColumnValues;
  }[];
  /** `seen` holds each set column's stored value: the apply compares and sets. */
  updates: {
    target: ColumnRef;
    naturalKey: string;
    id: string;
    set: ColumnValues;
    seen: ColumnValues;
    row: ColumnValues;
  }[];
  removals: {
    target: ColumnRef;
    naturalKey: string;
    id: string;
    row: ColumnValues | null;
  }[];
  /** Records deleted outside the kernel: a delete is a rejection. */
  rejections: { target: ColumnRef; id: string }[];
  bindingsAdd: {
    fact: FactRef;
    eventKey: string;
    basis: "proven" | "decision";
  }[];
  bindingsRemove: { fact: FactRef; eventKey: string; basis: string }[];
  merges: {
    target: ColumnRef;
    survivorId: string;
    absorbedId: string;
    basis: "proof" | "decision";
  }[];
};

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

export function difference(
  computed: Computed,
  options: { releaseBaseline: boolean },
): Difference {
  const desired = computed.desired;
  if (!desired) throw new KernelContractError("No desired output to apply");
  const result: Difference = {
    inserts: [],
    updates: [],
    removals: [],
    rejections: [],
    bindingsAdd: [],
    bindingsRemove: [],
    merges: [],
  };
  const slot = (target: ColumnRef, naturalKey: string) =>
    `${target.name}\u0000${naturalKey}`;
  const owned = new Map(
    computed.owned.map((record) => [
      slot(record.target, record.naturalKey),
      record,
    ]),
  );
  const desiredSlots = new Set<string>();
  for (const record of desired.records) {
    const id = slot(record.target, record.naturalKey);
    if (desiredSlots.has(id))
      throw new KernelContractError(
        `${computed.reconciler.scope} declares ${record.target.name} ${record.naturalKey} twice`,
      );
    desiredSlots.add(id);
    const existing = owned.get(id);
    if (!existing) {
      result.inserts.push({
        target: record.target,
        naturalKey: record.naturalKey,
        id: record.id,
        values: { ...record.values },
      });
      continue;
    }
    if (existing.rejected) continue;
    const stored = existing.stored;
    if (
      !stored ||
      (stored.deletedAt !== undefined && stored.deletedAt !== null)
    ) {
      result.rejections.push({ target: record.target, id: existing.entityId });
      continue;
    }
    const set: ColumnValues = {};
    const seen: ColumnValues = {};
    for (const [column, value] of Object.entries(record.values))
      if (!same(value, stored[column])) {
        set[column] = value;
        seen[column] = stored[column] ?? null;
      }
    if (Object.keys(set).length)
      result.updates.push({
        target: record.target,
        naturalKey: record.naturalKey,
        id: existing.entityId,
        set,
        seen,
        row: { ...stored, ...set },
      });
  }
  for (const patch of desired.patches) {
    const stored = computed.patched.get(patch.target.name)?.get(patch.id);
    // A record removed since the load is left alone; its owner disposes of it.
    if (
      !stored ||
      (stored.deletedAt !== undefined && stored.deletedAt !== null)
    )
      continue;
    const set: ColumnValues = {};
    const seen: ColumnValues = {};
    for (const [column, value] of Object.entries(patch.values))
      if (!same(value, stored[column])) {
        set[column] = value;
        seen[column] = stored[column] ?? null;
      }
    if (Object.keys(set).length)
      result.updates.push({
        target: patch.target,
        naturalKey: "",
        id: patch.id,
        set,
        seen,
        row: { ...stored, ...set },
      });
  }
  const retired = new Map(
    desired.retired.map((entry) => [
      slot(entry.target, entry.naturalKey),
      entry,
    ]),
  );
  for (const [id, record] of owned) {
    if (desiredSlots.has(id) || record.rejected) continue;
    const disposition = retired.get(id)?.disposition;
    if (!disposition)
      throw new KernelContractError(
        `${computed.reconciler.scope} gives no disposition for ${record.target.name} ${record.naturalKey}, which it no longer declares`,
      );
    if (disposition === "remove")
      result.removals.push({
        target: record.target,
        naturalKey: record.naturalKey,
        id: record.entityId,
        row: record.stored,
      });
  }
  for (const merge of desired.merges) {
    const survivor = owned.get(slot(merge.target, merge.survivor));
    const absorbed = owned.get(slot(merge.target, merge.absorbed));
    if (!survivor || !absorbed)
      throw new KernelContractError(
        `${computed.reconciler.scope} merges a record it does not own`,
      );
    if (survivor.entityId !== absorbed.entityId)
      result.merges.push({
        target: merge.target,
        survivorId: survivor.entityId,
        absorbedId: absorbed.entityId,
        basis: merge.basis,
      });
  }

  const wanted = new Map<string, Difference["bindingsAdd"][number]>();
  for (const binding of desired.bindings) {
    const id = `${binding.fact.kind}:${binding.fact.id}:${binding.basis}`;
    const prior = wanted.get(id);
    if (prior && prior.eventKey !== binding.eventKey)
      throw new KernelContractError(
        `${computed.reconciler.scope} binds ${binding.fact.kind} ${binding.fact.id} to two events`,
      );
    wanted.set(id, binding);
  }
  const stored = new Map(
    computed.storedBindings.map((binding) => [
      `${binding.fact.kind}:${binding.fact.id}:${binding.basis}`,
      binding,
    ]),
  );
  for (const [id, binding] of wanted) {
    const current = stored.get(id);
    if (current?.eventKey === binding.eventKey) continue;
    if (current)
      result.bindingsRemove.push({
        fact: current.fact,
        eventKey: current.eventKey,
        basis: current.basis,
      });
    result.bindingsAdd.push(binding);
  }
  for (const [id, binding] of stored) {
    if (wanted.has(id)) continue;
    if (binding.basis === "baseline" && !options.releaseBaseline) continue;
    result.bindingsRemove.push({
      fact: binding.fact,
      eventKey: binding.eventKey,
      basis: binding.basis,
    });
  }
  return result;
}

export const isEmptyDifference = (diff: Difference) =>
  !diff.inserts.length &&
  !diff.updates.length &&
  !diff.removals.length &&
  !diff.rejections.length &&
  !diff.bindingsAdd.length &&
  !diff.bindingsRemove.length &&
  !diff.merges.length;

/** The exact difference as stored on a Drift proposal; inserts carry no minted ids. */
export function describeDifference(diff: Difference): Json {
  return JSON.parse(
    canonicalJson({
      inserts: diff.inserts.map((entry) => ({
        table: entry.target.name,
        naturalKey: entry.naturalKey,
        values: entry.values,
      })),
      updates: diff.updates.map((entry) => ({
        table: entry.target.name,
        naturalKey: entry.naturalKey,
        id: entry.id,
        from: entry.seen,
        to: entry.set,
      })),
      removals: diff.removals.map((entry) => ({
        table: entry.target.name,
        naturalKey: entry.naturalKey,
        id: entry.id,
      })),
      bindings: {
        add: diff.bindingsAdd,
        remove: diff.bindingsRemove,
      },
      merges: diff.merges.map((entry) => ({
        table: entry.target.name,
        survivor: entry.survivorId,
        absorbed: entry.absorbedId,
        basis: entry.basis,
      })),
    }),
  );
}
