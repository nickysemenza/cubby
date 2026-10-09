import type { Query } from "@tanstack/react-query";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, it } from "vitest";

import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import { recommendations } from "~/integrations/tanstack-query/generated/recommendations.gen";
import { matchesTags } from "~/integrations/tanstack-query/operation-cache";

it("refreshes placement eligibility and labels when locations change", () => {
  const query = fromPartial<Query>({
    meta: { cacheTags: recommendations.forEntity.definition.tags },
  });
  expect(matchesTags(entityRipple("location"))(query)).toBe(true);
});
