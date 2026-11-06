import { productShortcode } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import {
  prepareTagSuggestionPublication,
  tagSourceRevision,
} from "~/server/generic/assessment/repo/tag-suggestions";
import { getProductTagPropagation } from "~/server/generic/relatedness/service/relatedness.service";

/** A Sweep publishes candidates; passive review reads never discover them. */
export async function prepareTagSuggestions(db: Database, sourceId: string) {
  const revision = await tagSourceRevision(db, sourceId);
  if (!revision) return [];
  const result = await getProductTagPropagation(
    db,
    productShortcode.parse(sourceId),
  );
  if (result.status !== "ready") return [];
  const publishers = await Promise.all(
    result.proposals.map((proposal) =>
      prepareTagSuggestionPublication(db, sourceId, proposal, revision),
    ),
  );
  return publishers.filter((publisher) => publisher !== null);
}
