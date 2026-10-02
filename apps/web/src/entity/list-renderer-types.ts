import type {
  EntityListResultByEntity,
  ListEntity,
} from "~/entity/generated/entity-lists.gen";
import type {
  CubbyColumnCollection,
  CubbyColumnHelper,
} from "~/ui/data-table/table-features";

/** The row a kernel list of `E` pages. */
export type ListRowOf<E extends ListEntity> =
  EntityListResultByEntity[E]["items"][number];

/**
 * A named list renderer (`display.renderer.list`): builds the one column for
 * its declared field. The declaration owns the id, label, provenance, sort
 * and explanation; the renderer owns the cell and its table metadata.
 */
export type ListRenderer<E extends ListEntity> = (
  helper: CubbyColumnHelper<ListRowOf<E>>,
) => CubbyColumnCollection<ListRowOf<E>>;
