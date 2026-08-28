import type { Query } from "@tanstack/react-query";
import { fromPartial } from "@total-typescript/shoehorn";
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

const relationshipRouteQuery = fromPartial<Query>({
  meta: { cacheTags: product.relationshipRoute.definition.tags },
});

const RELATIONSHIP_ROOT_CASES = RELATIONSHIP_ROOTS.map((root) => ({ root }));

describe("product.relationshipRoute cache coverage", () => {
  it.each(RELATIONSHIP_ROOT_CASES)("is invalidated by $root", ({ root }) => {
    expect(matchesTags([root])(relationshipRouteQuery)).toBe(true);
  });

  it("is not invalidated by an unrelated root", () => {
    expect(matchesTags([["recipe"]])(relationshipRouteQuery)).toBe(false);
    expect(matchesTags([["wish"]])(relationshipRouteQuery)).toBe(false);
  });
});

describe("product.kitComponentRows input", () => {
  it("accepts the empty loaded-page kit set used by the dormant products query", () => {
    expect(
      product.kitComponentRows.queryOptions({ parentProductIds: [] }).queryKey,
    ).toEqual([
      "operation",
      "product.kitComponentRows",
      { input: { parentProductIds: [] } },
    ]);
  });
});
