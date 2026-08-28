import type { Query } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { matchesTags } from "~/integrations/tanstack-query/operation-cache";
import type { OperationCacheTag } from "~/integrations/tanstack-query/operation-meta";

import { product } from "./product.functions";

/**
 * The relationship route is the one query that opts INTO other entities' roots:
 * it renders a product's inventory, locations, expenses, purchases, projects,
 * tasks and vendors, so a write on any of them has to refresh it. Nothing else
 * declares those tags, so nothing else would notice if one were dropped.
 *
 * Asserted as behaviour — "invalidating this root reaches this query" under the
 * real prefix rule — rather than as the literal spelling of `definition.tags`.
 * A shape assertion also fails when a tag is legitimately reworded (a redundant
 * broad root trimmed beside a narrower sibling, say), which teaches the reader
 * to re-baseline it instead of reading it.
 */
const RELATIONSHIP_ROOTS: readonly OperationCacheTag[] = [
  ["product"],
  ["product", "relationshipRoute"],
  ["inventory"],
  ["location"],
  ["expense"],
  ["purchase"],
  ["project"],
  ["project", "resource"],
  ["task"],
  ["vendor"],
];

const relationshipRouteQuery = {
  meta: { cacheTags: product.relationshipRoute.definition.tags },
} as unknown as Query;

describe("product.relationshipRoute cache coverage", () => {
  it.each(RELATIONSHIP_ROOTS)(
    "is invalidated by %j",
    (...root: readonly string[]) => {
      expect(
        matchesTags([root as unknown as OperationCacheTag])(
          relationshipRouteQuery,
        ),
      ).toBe(true);
    },
  );

  it("is not invalidated by an unrelated root", () => {
    expect(matchesTags([["recipe"]])(relationshipRouteQuery)).toBe(false);
    expect(matchesTags([["wish"]])(relationshipRouteQuery)).toBe(false);
  });
});
