import type { Entity } from "@cubby/schemas/entity";
import {
  type ListGroupBy,
  listGroupByDimensionsSchema,
} from "@cubby/schemas/pagination";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { entityMetadata } from "~/entity/metadata";

import type { ListSearch } from "./list-slot-types";
import { PIVOT_SHARES } from "./pivot/pivot-model";

const groupingSearchSchema = z.object({
  groupBy: listGroupByDimensionsSchema.optional(),
});

/** The generated route schema validates dimensions; reuse its wire shape here. */
export const listGroupBy = (search: unknown) =>
  groupingSearchSchema.safeParse(search).data?.groupBy;

/**
 * The grouping a list opens with: by phase (Needs you, Active, Recently
 * finished) where the entity declares `presentation.state`, else none.
 */
function defaultListGroupBy(
  queryClient: QueryClient,
  entity: Entity,
): readonly ListGroupBy[] {
  const metadata = entityMetadata(queryClient, entity);
  return metadata.summary.state &&
    metadata.listFields.grouping.some(
      ({ key, reason }) => key === "phase" && reason === null,
    )
    ? [{ key: "phase" }]
    : [];
}

/**
 * The list's grouping: the URL's, else the entity's default. An empty URL
 * `groupBy` is the person's explicit None and wins over the default.
 */
export const listGroupingFor = (
  queryClient: QueryClient,
  entity: Entity,
  search: ListSearch,
): readonly ListGroupBy[] =>
  listGroupBy(search) ?? defaultListGroupBy(queryClient, entity);

/** The URL value for a grouping; the entity's default stays absent. */
export function groupBySearchValue(
  queryClient: QueryClient,
  entity: Entity,
  next: readonly ListGroupBy[],
): ListGroupBy[] | undefined {
  const fallback = defaultListGroupBy(queryClient, entity);
  return JSON.stringify(next) === JSON.stringify(fallback)
    ? undefined
    : [...next];
}

/**
 * The built-in Pivot view's `?view=` id. It is not a declared view: the URL
 * generator offers it on every list with two groupable choices.
 */
export const PIVOT_VIEW_ID = "pivot";

/** Two distinct groupable choices make a cross-tab; mirrors the generator. */
export const pivotAvailable = (
  grouping: readonly { reason: string | null; listed: boolean }[],
) =>
  grouping.filter(({ reason, listed }) => listed && reason === null).length >=
  2;

const shareSearchSchema = z.object({
  share: z.enum(PIVOT_SHARES).optional().catch(undefined),
});

/** The Pivot cell share from the URL; Row % when absent. */
export const pivotShare = (search: unknown) =>
  shareSearchSchema.safeParse(search).data?.share ?? "row";
