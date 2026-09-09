import type { EntityGraphOutput } from "@cubby/schemas/entity-graph";
import { describe, expect, it } from "vitest";

import {
  GRAPH_VISIT_LIMIT,
  graphBranchKey,
  graphRefKey,
  graphExpansionFrontier,
  mergeGraphPages,
  moveGraphVisit,
  nextGraphFrontier,
  visibleNeighborhoodKeys,
  visitGraphRecord,
} from "./entity-graph-state";

const product = { entityType: "product", entityId: "PRD-4K7M" } as const;
const purchase = { entityType: "purchase", entityId: "PUR-4K7M" } as const;
const expense = { entityType: "expense", entityId: "EXP-4K7M" } as const;
const node = (ref: typeof product | typeof purchase | typeof expense) => ({
  ...ref,
  label: ref.entityId,
  metadata: {},
});

const page: EntityGraphOutput = {
  nodes: [node(product), node(purchase)],
  edges: [
    {
      id: "test-edge",
      source: product,
      target: purchase,
      relationshipKey: "purchases",
      sourceKey: "expense",
      label: "Purchases",
      provenance: ["expense"],
    },
  ],
  branches: [
    {
      root: product,
      relationshipKey: "purchases",
      target: "purchase",
      label: "Purchases",
      items: [purchase],
      totalCount: 2,
      edgeIds: ["test-edge"],
      nextOffset: 1,
    },
  ],
  truncated: false,
};

describe("entity graph exploration", () => {
  it("merges converging paths and pages without losing source evidence or list items", () => {
    const second: EntityGraphOutput = {
      nodes: [node(purchase), node(expense)],
      edges: [
        {
          ...page.edges[0]!,
          id: "explicit-edge",
          sourceKey: "explicit",
          provenance: ["explicit"],
        },
      ],
      branches: [
        {
          ...page.branches[0]!,
          items: [expense],
          edgeIds: ["explicit-edge"],
          nextOffset: null,
        },
      ],
      truncated: false,
    };
    const merged = mergeGraphPages([page, second, second]);
    expect(merged.nodes).toHaveLength(3);
    expect(merged.edges.map((edge) => edge.sourceKey)).toEqual([
      "expense",
      "explicit",
    ]);
    expect(merged.branches[0]?.items).toEqual([purchase, expense]);
    expect(merged.branches[0]?.nextOffset).toBeNull();
    expect(merged.branches[0]?.edgeIds).toEqual(["test-edge", "explicit-edge"]);
  });

  it("does not revisit a cycle or a shared record when forming a multi-hop frontier", () => {
    expect(
      graphExpansionFrontier(page, product, new Set([graphRefKey(product)])),
    ).toEqual([purchase]);
    expect(nextGraphFrontier(page, new Set([graphRefKey(product)]))).toEqual([
      purchase,
    ]);
    expect(
      nextGraphFrontier(
        page,
        new Set([graphRefKey(product), graphRefKey(purchase)]),
      ),
    ).toEqual([]);
  });

  it("continues from the root through loaded nodes to the next frontier", () => {
    const graph = mergeGraphPages([
      page,
      {
        nodes: [node(expense)],
        edges: [],
        truncated: false,
        branches: [
          {
            root: purchase,
            relationshipKey: "expenses",
            label: "Expenses",
            target: "expense",
            items: [product, expense],
            edgeIds: [],
            totalCount: 2,
            nextOffset: null,
          },
        ],
      },
    ]);
    expect(
      graphExpansionFrontier(
        graph,
        product,
        new Set([graphRefKey(product), graphRefKey(purchase)]),
      ),
    ).toEqual([expense]);
  });

  it("bounds the visible graph and drops dangling edges with an explicit truncation signal", () => {
    const large: EntityGraphOutput = {
      ...page,
      nodes: Array.from({ length: 600 }, (_, index) => ({
        ...product,
        entityId: `PRD-${index}`,
        label: String(index),
        metadata: {},
      })),
    };
    const merged = mergeGraphPages([large]);
    expect(merged.nodes).toHaveLength(500);
    expect(merged.edges).toEqual([]);
    expect(merged.truncated).toBe(true);
  });

  it("bounds accumulated edges even when repeated expansion adds no new records", () => {
    const dense = {
      ...page,
      edges: Array.from({ length: 1_001 }, (_, index) => ({
        ...page.edges[0]!,
        id: `evidence-${index}`,
      })),
    };
    const merged = mergeGraphPages([dense]);
    expect(merged.nodes).toHaveLength(2);
    expect(merged.edges).toHaveLength(1_000);
    expect(merged.truncated).toBe(true);
  });

  it("keeps repeated visits, truncates forward history, and bounds the trail", () => {
    let history = { trail: ["a", "b", "a"], cursor: 2 };
    history = moveGraphVisit(history, -1);
    history = visitGraphRecord(history, "c");
    expect(history).toEqual({ trail: ["a", "b", "c"], cursor: 2 });
    for (let index = 0; index < 40; index++)
      history = visitGraphRecord(history, String(index));
    expect(history.trail).toHaveLength(GRAPH_VISIT_LIMIT);
    expect(history.cursor).toBe(GRAPH_VISIT_LIMIT - 1);
  });

  it("distributes a capped neighborhood across branches and deduplicates shared records", () => {
    const shared = { ...purchase };
    const branches: EntityGraphOutput["branches"] = [
      {
        ...page.branches[0]!,
        items: [shared, expense],
      },
      {
        ...page.branches[0]!,
        relationshipKey: "expenses",
        items: [shared, product],
      },
    ];
    const visible = new Map(
      branches.map((branch) => [
        graphBranchKey(branch.root, branch.relationshipKey),
        2,
      ]),
    );
    expect([...visibleNeighborhoodKeys(branches, visible, 3)]).toEqual([
      graphRefKey(shared),
      graphRefKey(expense),
      graphRefKey(product),
    ]);
  });

  it("caps a large neighborhood at sixty while giving each manifest branch space", () => {
    const branches = Array.from({ length: 4 }, (_, branchIndex) => ({
      ...page.branches[0]!,
      relationshipKey: `branch-${branchIndex}`,
      items: Array.from({ length: 25 }, (_, itemIndex) => ({
        entityType: "product" as const,
        entityId: `PRD-${branchIndex}-${itemIndex}`,
      })),
    }));
    const visible = new Map(
      branches.map((branch) => [
        graphBranchKey(branch.root, branch.relationshipKey),
        25,
      ]),
    );
    const keys = visibleNeighborhoodKeys(branches, visible);
    expect(keys).toHaveLength(60);
    for (let branchIndex = 0; branchIndex < 4; branchIndex++)
      expect(
        [...keys].filter((key) =>
          key.startsWith(`product:PRD-${branchIndex}-`),
        ),
      ).toHaveLength(15);
  });
});
