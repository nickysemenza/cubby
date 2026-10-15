import type { DetailSlotId } from "@cubby/schemas/entity-manifest";
import type { FunctionComponent, LazyExoticComponent } from "react";

import { featureRegistry } from "~/entity/feature-registry";
import type { PresentationCoverage } from "~/entity/presentation-coverage";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";

/** A slot renders one declared section body against the loaded record. */
export type DetailSlotComponent<E extends GenericDetailEntity> =
  FunctionComponent<{ record: DetailRecordOf<E> }>;

export interface DetailSlot<E extends GenericDetailEntity> {
  component: LazyExoticComponent<DetailSlotComponent<E>>;
  /**
   * Whether the section renders for this record at all — a garden section
   * on a product that grows nothing has no header to show. Synchronous on
   * purpose: it decides the section ledger before anything loads.
   */
  applies?(record: DetailRecordOf<E>): boolean;
}

/**
 * The web fills for every `kind: "slot"` section the declarations name.
 * Keyed by `DetailSlotId<E>`, so a slot id the declaration drops (or
 * misspells) fails to compile where `features/registry.tsx` builds it. Each
 * fill is lazy: a detail route's chunk carries only the slots its own entity
 * declares.
 */
export type DetailSlotTable = {
  [
    E in GenericDetailEntity as DetailSlotId<E> extends never ? never : E
  ]: Record<DetailSlotId<E>, PresentationCoverage<DetailSlot<E>>>;
};

/** The slots for one entity, read through the erased map the page walks. */
export const detailSlotsFor = (
  entity: GenericDetailEntity,
): Readonly<Record<string, DetailSlot<never>>> | undefined => {
  const detailSlots = featureRegistry().detailSlots;
  if (!Object.hasOwn(detailSlots, entity)) return undefined;
  // SAFETY: `hasOwn` proves `entity` is one of the registry's own keys. The
  // public erased map is consumed only with this same entity's record.
  const coverage = detailSlots[entity as keyof typeof detailSlots] as Readonly<
    Record<string, PresentationCoverage<DetailSlot<never>>>
  >;
  return Object.fromEntries(
    Object.entries(coverage).map(([id, disposition]) => {
      if (disposition.kind !== "implemented") {
        throw new Error(`Web detail slot ${entity}.${id} is not implemented`);
      }
      return [id, disposition.implementation];
    }),
  );
};
