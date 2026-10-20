import { productShortcode } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import { getProductTagPropagation } from "~/server/generic/relatedness/service/relatedness.service";

import { assessRecommendation } from "../repo/assessment-recommendation";

/** A Sweep publishes candidates; passive review reads never discover them. */
export async function prepareTagSuggestions(db: Database, sourceId: string) {
  const result = await getProductTagPropagation(
    db,
    productShortcode.parse(sourceId),
  );
  if (result.status !== "ready") return [];
  return result.proposals.map(
    (proposal) => (transactionDb: Database) =>
      assessRecommendation(
        transactionDb,
        sourceId,
        "product.tag-propagation",
        [proposal.tag],
        proposal,
      ),
  );
}
