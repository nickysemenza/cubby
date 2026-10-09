import type { CollectionActionId } from "@cubby/schemas/entity-definitions/collection-actions";
import type { DetailSlotId } from "@cubby/schemas/entity-manifest";
import type {
  ReportBlock,
  ReportRecordRow,
} from "@cubby/schemas/entity-report";
import type { SectionActionId } from "@cubby/schemas/entity-section-actions";
import {
  createContext,
  type FunctionComponent,
  type ReactNode,
  useContext,
} from "react";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";

/** A slot renders one declared section body against the loaded record. */
export type DetailSlotComponent<E extends GenericDetailEntity> =
  FunctionComponent<{ record: DetailRecordOf<E> }>;

export interface DetailSlot<E extends GenericDetailEntity> {
  component: DetailSlotComponent<E>;
  /**
   * Whether the section renders for this record at all — a garden section
   * on a product that grows nothing has no header to show. Synchronous on
   * purpose: it decides the section ledger before anything renders.
   */
  applies?(record: DetailRecordOf<E>): boolean;
}

interface SectionActionProps<E extends GenericDetailEntity> {
  record: DetailRecordOf<E>;
  /** The server's word on the verb: its label, scope and why it is unavailable. */
  action: NonNullable<
    Extract<ReportBlock, { kind: "records" }>["verbs"]
  >[number];
  /** The checked rows, for a `selection` verb. */
  selection: readonly string[];
  clearSelection: () => void;
}

/** The web run of one `summary`/`recordList` verb (`SECTION_ACTION_IDS`). */
export type SectionActionComponent<E extends GenericDetailEntity> =
  FunctionComponent<SectionActionProps<E>>;

/**
 * What a `collection` section hands an action: the loaded record, and for a `row` action the
 * row it was drawn on (`null` for a `section` action).
 */
export type CollectionActionProps<E extends GenericDetailEntity> = {
  record: DetailRecordOf<E>;
  item: ReportRecordRow | null;
};
type CollectionActionComponent<E extends GenericDetailEntity> =
  FunctionComponent<CollectionActionProps<E>>;

type SlotFills<E extends GenericDetailEntity> = [DetailSlotId<E>] extends [
  never,
]
  ? { slots?: never }
  : { slots: Record<DetailSlotId<E>, DetailSlot<E>> };

/**
 * One entity's detail-page UI, declared in its typed hook module
 * (`entity/clients/<entity>.detail.tsx`) and bound by its generated client
 * module. `slots` is keyed by the declaration's `DetailSlotId<E>`, so a slot
 * the declaration adds, drops or renames fails to compile there.
 *
 * - `headerActions`: specialist controls in the detail header.
 * - `sectionActions`: the verbs a `summary`/`recordList` section declares.
 * - `collectionActions`: the verbs a report `records` block offers
 *   (`COLLECTION_ACTIONS`); every id has exactly one owner
 *   (`./detail-hooks-coverage.ts`).
 */
export type DetailHooks<E extends GenericDetailEntity> = SlotFills<E> & {
  headerActions?: DetailSlotComponent<E>;
  sectionActions?: Partial<Record<SectionActionId, SectionActionComponent<E>>>;
  collectionActions?: Partial<
    Record<CollectionActionId, CollectionActionComponent<E>>
  >;
};

/** Hook modules declare through this so `E` fixes the slot and record types. */
export const defineDetailHooks = <
  E extends GenericDetailEntity,
  const H extends DetailHooks<E>,
>(
  _entity: E,
  hooks: H,
): H => hooks;

export interface DetailClient<E extends GenericDetailEntity> {
  entity: E;
  hooks: ErasedDetailHooks;
}

/** The detail page's hooks with the per-entity record types erased. */
export interface ErasedDetailHooks {
  slots?: Readonly<Record<string, DetailSlot<never>>>;
  headerActions?: DetailSlotComponent<never>;
  sectionActions?: Partial<
    Record<SectionActionId, SectionActionComponent<never>>
  >;
  collectionActions?: Partial<
    Record<CollectionActionId, CollectionActionComponent<never>>
  >;
}

/** Called by the generated client module (`entity/generated/clients/<entity>.detail.gen.ts`). */
export const defineDetailClient = <E extends GenericDetailEntity>(
  entity: E,
  hooks: DetailHooks<E>,
): DetailClient<E> => ({
  entity,
  // SAFETY: the page renders these components only with the record loaded for
  // this same entity, so erasing the record parameter loses nothing.
  hooks: hooks as ErasedDetailHooks,
});

const DetailHooksContext = createContext<ErasedDetailHooks>({});

/** Supplies one entity's hooks to its detail page, its slots and their verbs. */
export function DetailHooksProvider({
  hooks,
  children,
}: {
  hooks: ErasedDetailHooks;
  children: ReactNode;
}) {
  return (
    <DetailHooksContext.Provider value={hooks}>
      {children}
    </DetailHooksContext.Provider>
  );
}

/** The current detail page's hooks; empty outside one. */
export const useDetailHooks = (): ErasedDetailHooks =>
  useContext(DetailHooksContext);
