import type { Entity } from "@cubby/schemas/entity";
import { type QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { entityMetadata } from "~/entity/metadata";

const nestSearchSchema = z.object({
  nest: z.enum(["on", "off"]).optional().catch(undefined),
});

/**
 * Whether an entity's table reads its declared `list.tree` nested: always
 * without a toggle, otherwise the URL's `nest` or the declared default.
 */
export function listNested(
  queryClient: QueryClient,
  entity: Entity,
  search: z.input<typeof nestSearchSchema>,
): boolean {
  const tree = entityMetadata(queryClient, entity).summary.list.tree;
  if (!tree) return false;
  if (!tree.toggle) return true;
  const { nest } = nestSearchSchema.parse(search);
  return nest === undefined ? tree.defaultNested : nest === "on";
}

/** The URL value for a nested choice; the declared default stays absent. */
export function nestSearchValue(
  queryClient: QueryClient,
  entity: Entity,
  nested: boolean,
): "on" | "off" | undefined {
  if (
    nested ===
    entityMetadata(queryClient, entity).summary.list.tree?.defaultNested
  )
    return undefined;
  return nested ? "on" : "off";
}
