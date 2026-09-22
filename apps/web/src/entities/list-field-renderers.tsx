import type { DataQuality } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import type { ListRendererId } from "@cubby/schemas/entity-manifest";

import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  type CubbyColumnCollection,
  type CubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import {
  RecipeSourceLink,
  sourceLabel,
} from "~/app/_components/recipe/recipe-source";
import { NoneValue } from "~/components/ui/none-value";
import type {
  EntityListResultByEntity,
  ListEntity,
} from "~/entities/generated/entity-lists.gen";
import { dataQualityOptions } from "~/lib/data-quality-options";

import {
  implemented,
  type PresentationCoverage,
  unsupported,
} from "./presentation-coverage";

type ListRowOf<E extends ListEntity> =
  EntityListResultByEntity[E]["items"][number];

type ListRenderer<E extends ListEntity> = (
  helper: CubbyColumnHelper<ListRowOf<E>>,
) => CubbyColumnCollection<ListRowOf<E>>;

// Ranges over every entity, not just `ListEntity`: a scored entity with no
// generic list page (cookbook — bespoke browser, no pagination envelope, see
// cookbook.ts) still gets the manifest's `dataQuality` list-renderer id and
// must carry an explicit (if `unsupported`) disposition here.
type ListRendererEntity = {
  [E in Entity]: ListRendererId<E> extends never ? never : E;
}[Entity];

type EntityListRendererCoverage<E extends ListRendererEntity> = Readonly<
  Record<
    ListRendererId<E>,
    E extends ListEntity
      ? PresentationCoverage<ListRenderer<E>>
      : PresentationCoverage<never>
  >
>;

const recipeSourceRenderer: ListRenderer<"recipe"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor("source", {
        id: "source",
        header: "Source",
        meta: {
          className: "w-44",
          mobile: { slot: "meta", priority: 30 },
        },
        cell: (info) => {
          const source = info.row.original.source;
          if (!sourceLabel(source)) return <NoneValue />;
          return (
            <RecipeSourceLink
              source={source}
              text="host"
              onClick={(event) => event.stopPropagation()}
            />
          );
        },
      }),
    );
  });

type ScoredRow = { dataQuality: DataQuality };

/** List entities whose rows carry a `dataQuality` (manifest `capabilities.dataQuality`). */
type ScoredListEntity = {
  [E in ListEntity]: ListRowOf<E> extends ScoredRow ? E : never;
}[ListEntity];

/**
 * The one `dataQuality` column every scored entity shares: the status badge
 * with the 0–100 score beside it. Its id is also the sort field, so the
 * column header sorts by score (asc = weakest row first — the worklist).
 */
const dataQualityRenderer = <TRow extends ScoredRow>(
  helper: CubbyColumnHelper<TRow>,
): CubbyColumnCollection<TRow> =>
  createCubbyColumnCollection<TRow>((add) => {
    add(
      helper.accessor((row) => row.dataQuality.status, {
        id: "dataQuality",
        header: "Data quality",
        enableSorting: true,
        meta: {
          className: "w-32",
          mobile: { slot: "meta", priority: 75 },
        },
        cell: (info) => (
          <span className="inline-flex items-center gap-1.5">
            {renderOptionCell(info.getValue(), dataQualityOptions)}
            <span className="text-xs text-muted-foreground tabular-nums">
              {Math.round(info.row.original.dataQuality.score)}
            </span>
          </span>
        ),
      }),
    );
  });

const scoredCoverage = <E extends ScoredListEntity>() => ({
  "data-quality": implemented<ListRenderer<E>>((helper) =>
    dataQualityRenderer(helper),
  ),
});

export const listRendererCoverage = {
  recipe: {
    "recipe-source": implemented(recipeSourceRenderer),
    ...scoredCoverage<"recipe">(),
  },
  product: scoredCoverage<"product">(),
  purchase: scoredCoverage<"purchase">(),
  // pantry and garden entities
  ingredient: scoredCoverage<"ingredient">(),
  // cookbook has no generic list-page contract (bespoke browser, no
  // pagination envelope — see cookbook.ts): its `dataQuality` column has no
  // column-collection renderer to implement here.
  cookbook: {
    "data-quality": unsupported(
      "cookbook's list is a bespoke, non-paginated browser (cookbook.ts) with no generic column-collection contract to implement this renderer against",
    ),
  },
  location: scoredCoverage<"location">(),
  inventory: scoredCoverage<"inventory">(),
  meal: scoredCoverage<"meal">(),
  productCategory: scoredCoverage<"productCategory">(),
  // finance and project entities
  project: scoredCoverage<"project">(),
  task: scoredCoverage<"task">(),
  vendor: scoredCoverage<"vendor">(),
  financialAccount: scoredCoverage<"financialAccount">(),
  financialTransaction: scoredCoverage<"financialTransaction">(),
  expense: scoredCoverage<"expense">(),
  wish: scoredCoverage<"wish">(),
  planting: scoredCoverage<"planting">(),
  gardenEntry: scoredCoverage<"gardenEntry">(),
  ledgerParty: scoredCoverage<"ledgerParty">(),
  ledgerTransfer: scoredCoverage<"ledgerTransfer">(),
} satisfies {
  [E in ListRendererEntity]: EntityListRendererCoverage<E>;
};

/**
 * Resolves one named list renderer through a single audited erasure boundary.
 * The manifest binds `entity`, renderer id and field; callers pass the same
 * entity's helper and receive the same entity's column collection.
 */
export function listRendererColumns<TRecord extends object>(
  entity: Entity,
  renderer: string,
  helper: CubbyColumnHelper<TRecord>,
): CubbyColumnCollection<TRecord> {
  const entry = Object.entries(listRendererCoverage).find(
    ([key]) => key === entity,
  )?.[1];
  const disposition:
    | PresentationCoverage<ListRenderer<ListEntity>>
    | undefined =
    entry === undefined
      ? undefined
      : Object.entries(entry).find(([key]) => key === renderer)?.[1];
  if (disposition === undefined) {
    throw new Error(`No web list renderer coverage for ${entity}.${renderer}`);
  }
  if (disposition.kind !== "implemented") {
    throw new Error(`Web list renderer ${renderer} is not implemented`);
  }
  // SAFETY: the generated `ListRendererId<E>` registry proves the renderer
  // and helper share `entity`; only the public generic column compiler erases
  // that entity-specific row association.
  const rendered = disposition.implementation(helper as never);
  const erasedRendered: unknown = rendered;
  // SAFETY: the lookup above bound this renderer to the same TRecord helper
  // accepted by the generic column compiler.
  return erasedRendered as CubbyColumnCollection<TRecord>;
}
