import type {
  CubbyColumnCollection,
  CubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import type {
  EntityListResultByEntity,
  ListEntity,
} from "~/entities/generated/entity-lists.gen";

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
