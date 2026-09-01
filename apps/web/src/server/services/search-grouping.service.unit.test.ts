import type {
  SearchMatchField,
  SearchMatchKind,
  SearchableEntity,
} from "@cubby/schemas/search";
import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { groupSearchCandidates } from "./search-grouping.service";
import type { InternalSearchCandidate } from "./search.service";

const candidate = (
  entityType: SearchableEntity,
  seed: string,
  options: {
    matchField?: SearchMatchField;
    matchKind?: SearchMatchKind;
  } = {},
): InternalSearchCandidate => ({
  id: testShortcode(entityType, seed),
  entityId: testEntityId(entityType, seed),
  entityType,
  title: `${entityType} ${seed}`,
  subtitle: null,
  typeHint: null,
  matchKind: options.matchKind ?? "text",
  matchField: options.matchField ?? "title",
  matchReason: "unit fixture",
  matchTerms: [seed],
});

const candidateKey = (value: InternalSearchCandidate) =>
  `${value.entityType}:${value.entityId}`;

const relations = (
  entries: ReadonlyArray<
    readonly [InternalSearchCandidate, InternalSearchCandidate | null]
  >,
) =>
  new Map(
    entries.map(([value, product]) => [
      candidateKey(value),
      product?.entityId ?? null,
    ]),
  );

describe("groupSearchCandidates", () => {
  it("collapses placements and linked activity under a Product", () => {
    const product = candidate("product", "driver");
    const placement = candidate("inventory", "placement", {
      matchKind: "prefix",
    });
    const expense = candidate("expense", "linked-expense");
    const task = candidate("task", "linked-task");
    const unlinkedExpense = candidate("expense", "unlinked-expense");
    const candidates = [product, placement, expense, task, unlinkedExpense];

    const groups = groupSearchCandidates(
      candidates,
      relations([
        [product, product],
        [placement, product],
        [expense, product],
        [task, product],
        [unlinkedExpense, null],
      ]),
      true,
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      kind: "product",
      productId: product.entityId,
      activityCandidates: [expense, task],
    });
    expect(groups[1]).toMatchObject({
      kind: "entity",
      candidate: unlinkedExpense,
      linkedProductId: null,
    });
  });

  it("fills distinct result slots after duplicate placement candidates", () => {
    const products = Array.from({ length: 8 }, (_, index) =>
      candidate("product", `product-${index}`),
    );
    const placements = Array.from({ length: 40 }, (_, index) =>
      candidate("inventory", `placement-${index}`),
    );
    const candidates = [...placements, ...products];
    const relationMap = relations([
      ...placements.map((placement) => [placement, products[0]!] as const),
      ...products.map((product) => [product, product] as const),
    ]);

    const groups = groupSearchCandidates(candidates, relationMap, true);

    expect(groups).toHaveLength(8);
    expect(groups.every((group) => group.kind === "product")).toBe(true);
    expect(new Set(groups.map((group) => group.key)).size).toBe(8);
  });

  it("keeps explicit scopes direct", () => {
    const product = candidate("product", "scoped-product");
    const placement = candidate("inventory", "scoped-placement");

    expect(
      groupSearchCandidates(
        [placement],
        relations([[placement, product]]),
        false,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "entity",
        candidate: placement,
      }),
    ]);
  });

  it("prioritizes an exact or prefix Location for place intent", () => {
    const product = candidate("product", "garage-product", {
      matchKind: "exact",
    });
    const location = candidate("location", "garage-location", {
      matchKind: "exact",
      matchField: "alias",
    });

    const groups = groupSearchCandidates(
      [product, location],
      relations([
        [product, product],
        [location, null],
      ]),
      true,
    );

    expect(groups[0]).toMatchObject({
      kind: "entity",
      candidate: location,
    });
    expect(groups[1]).toMatchObject({ kind: "product" });
  });
});
