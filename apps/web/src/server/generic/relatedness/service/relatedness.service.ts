import type { TagPropagationRecommendationOut } from "@cubby/schemas/recommendations";

import type { Database } from "~/server/db";

/** L2's Sweep roster still calls discovery until its tag-suggestion cutover. */
export async function getProductTagPropagation(
  _db: Database,
  _sourceId: string,
): Promise<TagPropagationRecommendationOut> {
  return { status: "ready", currentTags: [], proposals: [] };
}
