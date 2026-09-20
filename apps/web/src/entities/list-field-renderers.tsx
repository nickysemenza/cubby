import type { Entity } from "@cubby/schemas/entity";
import type { ListRendererId } from "@cubby/schemas/entity-manifest";

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

import {
  implemented,
  type PresentationCoverage,
} from "./presentation-coverage";

type ListRowOf<E extends ListEntity> =
  EntityListResultByEntity[E]["items"][number];

type ListRenderer<E extends ListEntity> = (
  helper: CubbyColumnHelper<ListRowOf<E>>,
) => CubbyColumnCollection<ListRowOf<E>>;

type ListRendererEntity = {
  [E in ListEntity]: ListRendererId<E> extends never ? never : E;
}[ListEntity];

type EntityListRendererCoverage<E extends ListRendererEntity> = Readonly<
  Record<ListRendererId<E>, PresentationCoverage<ListRenderer<E>>>
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

export const listRendererCoverage = {
  recipe: {
    "recipe-source": implemented(recipeSourceRenderer),
  },
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
  if (entity !== "recipe" || renderer !== "recipe-source") {
    throw new Error(`No web list renderer coverage for ${renderer}`);
  }
  const disposition = listRendererCoverage.recipe["recipe-source"];
  if (disposition.kind !== "implemented") {
    throw new Error(`Web list renderer ${renderer} is not implemented`);
  }
  // SAFETY: the generated `ListRendererId<E>` registry proves the renderer
  // and helper share `entity`; only the public generic column compiler erases
  // that entity-specific row association.
  const rendered = disposition.implementation(helper as never);
  const erasedRendered: unknown = rendered;
  // SAFETY: the entity check above binds this recipe renderer to the same
  // TRecord helper accepted by the generic column compiler.
  return erasedRendered as CubbyColumnCollection<TRecord>;
}
