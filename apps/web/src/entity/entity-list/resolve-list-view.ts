import { listViewId } from "@cubby/schemas/entity-definitions/definition";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { type EntityListView } from "@cubby/schemas/entity-summary";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { entityMetadata } from "~/entity/metadata";

import type { ListSearch } from "./list-slot-types";

const viewParam = z.string().optional().catch(undefined);

/** The declared views, and the one `?view=` selects (the first by default). */
export function resolveListView(
  queryClient: QueryClient,
  entity: BrowserRoutedEntity,
  search: ListSearch,
) {
  const views: readonly EntityListView[] = entityMetadata(queryClient, entity)
    .summary.list.views;
  const requested = viewParam.parse(search.view);
  // Retired view ids remain valid URLs while resolving to the shared renderer.
  const aliases: Readonly<Record<string, string>> = entityMetadata(
    queryClient,
    entity,
  ).summary.list.viewAliases;
  const requestedView =
    (requested === undefined ? undefined : aliases[requested]) ?? requested;
  const view: EntityListView =
    views.find((candidate) => listViewId(candidate) === requestedView) ??
    views[0] ??
    "table";
  return { views, view };
}
