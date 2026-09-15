import type { Query } from "@tanstack/react-query";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, it } from "vitest";

import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import { matchesTags } from "~/integrations/tanstack-query/operation-cache";

import { recommendations } from "./recommendations.functions";

it("refreshes placement eligibility and labels when locations change", () => {
  const query = fromPartial<Query>({
    meta: { cacheTags: recommendations.forEntity.definition.tags },
  });
  expect(matchesTags(entityRipple("location"))(query)).toBe(true);
});
