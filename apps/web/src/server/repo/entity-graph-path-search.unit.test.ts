import type { EntityRef } from "@cubby/schemas/entity";
import type { EntityGraphEdge } from "@cubby/schemas/entity-graph";
import { describe, expect, it } from "vitest";

import {
  type GraphFrontierReader,
  searchEntityGraphPaths,
} from "./entity-graph-path-search";

const ref = (id: string): EntityRef => ({
  entityType: "task",
  entityId: `TSK-${id}`,
});

const at = (refs: readonly EntityRef[], index: number): EntityRef => {
  const value = refs[index];
  if (!value) throw new Error(`Missing fixture ref at index ${index}`);
  return value;
};

const edge = (
  id: string,
  source: EntityRef,
  target: EntityRef,
): EntityGraphEdge => ({
  id,
  source,
  target,
  relationshipKey: "dependencies",
  label: "Depends on",
  sourceKey: "direct",
  provenance: ["outgoing:TaskDependency.blockerTaskId"],
});

const graphReader =
  (
    edges: readonly EntityGraphEdge[],
    onRead?: (roots: readonly EntityRef[], offset: number) => void,
  ): GraphFrontierReader =>
  async (roots, offset, limit) => {
    onRead?.(roots, offset);
    const byRoot = roots.map((root) =>
      edges.filter(
        (candidate) =>
          candidate.source.entityId === root.entityId ||
          candidate.target.entityId === root.entityId,
      ),
    );
    const pageEdges = byRoot.flatMap((adjacent) =>
      adjacent.slice(offset, offset + limit),
    );
    const nodes = [
      ...roots,
      ...pageEdges.flatMap((candidate) => [candidate.source, candidate.target]),
    ];
    return {
      nodes: [...new Map(nodes.map((node) => [node.entityId, node])).values()],
      edges: [
        ...new Map(
          pageEdges.map((candidate) => [candidate.id, candidate]),
        ).values(),
      ],
      nextOffset: byRoot.some((adjacent) => adjacent.length > offset + limit)
        ? offset + limit
        : null,
    };
  };

describe("entity graph path search", () => {
  it("deduplicates record paths while preserving parallel canonical evidence", async () => {
    const [start, middle, destination] = [
      ref("START"),
      ref("MIDDLE"),
      ref("END"),
    ];
    const result = await searchEntityGraphPaths(
      start,
      destination,
      graphReader([
        edge("parallel-b", middle, start),
        edge("parallel-a", start, middle),
        edge("finish", destination, middle),
      ]),
    );

    expect(result).toMatchObject({
      completion: "exhausted",
      shortestPathCertain: true,
    });
    expect(result.paths).toEqual([
      {
        nodeRefs: [start, middle, destination],
        edgeIds: ["parallel-a", "finish"],
      },
    ]);
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "parallel-b",
          source: middle,
          target: start,
        }),
        expect.objectContaining({
          id: "finish",
          source: destination,
          target: middle,
        }),
      ]),
    );
  });

  it("paginates batched frontier reads", async () => {
    const start = ref("START");
    const destination = ref("END");
    const reads: number[] = [];
    const result = await searchEntityGraphPaths(
      start,
      destination,
      graphReader(
        [edge("dead-end", start, ref("A")), edge("direct", start, destination)],
        (_roots, offset) => reads.push(offset),
      ),
      { limits: { pageSize: 1 } },
    );

    expect(reads).toEqual([0, 1]);
    expect(result.paths[0]?.edgeIds).toEqual(["direct"]);
    expect(result.shortestPathCertain).toBe(true);
  });

  it("returns at most three distinct shortest record sequences", async () => {
    const start = ref("START");
    const destination = ref("END");
    const middles = [ref("A"), ref("B"), ref("C"), ref("D")];
    const result = await searchEntityGraphPaths(
      start,
      destination,
      graphReader(
        middles.flatMap((middle, index) => [
          edge(`start-${index}`, start, middle),
          edge(`end-${index}`, middle, destination),
        ]),
      ),
    );

    expect(result.paths).toHaveLength(3);
    expect(
      new Set(result.paths.map((path) => path.nodeRefs[1]?.entityId)).size,
    ).toBe(3);
    expect(result.paths.every((path) => path.edgeIds.length === 2)).toBe(true);
  });

  it("reports depth and read budgets without claiming shortest-path certainty", async () => {
    const start = ref("START");
    const middle = ref("MIDDLE");
    const destination = ref("END");
    const reader = graphReader([
      edge("first", start, middle),
      edge("second", middle, destination),
    ]);

    await expect(
      searchEntityGraphPaths(start, destination, reader, {
        limits: { maxDepth: 1 },
      }),
    ).resolves.toMatchObject({
      paths: [],
      completion: "depth-limit",
      shortestPathCertain: false,
    });
    await expect(
      searchEntityGraphPaths(start, destination, reader, {
        limits: { maxReads: 1 },
      }),
    ).resolves.toMatchObject({
      paths: [],
      completion: "budget-limit",
      shortestPathCertain: false,
    });
  });

  it("accepts eight hops and rejects a nine-hop route at the depth limit", async () => {
    const nodes = Array.from({ length: 10 }, (_, index) => ref(String(index)));
    const chain = nodes
      .slice(1)
      .map((node, index) => edge(`edge-${index}`, at(nodes, index), node));

    const eightHops = await searchEntityGraphPaths(
      at(nodes, 0),
      at(nodes, 8),
      graphReader(chain),
    );
    expect(eightHops).toMatchObject({
      completion: "exhausted",
      shortestPathCertain: true,
    });
    expect(eightHops.paths[0]?.edgeIds).toHaveLength(8);

    await expect(
      searchEntityGraphPaths(at(nodes, 0), at(nodes, 9), graphReader(chain)),
    ).resolves.toMatchObject({
      paths: [],
      completion: "depth-limit",
      shortestPathCertain: false,
    });
  });

  it.each([
    ["node", { maxNodes: 2 }],
    ["edge", { maxEdges: 0 }],
  ])("reports the %s budget", async (_name, limits) => {
    const start = ref("START");
    const destination = ref("END");
    const result = await searchEntityGraphPaths(
      start,
      destination,
      graphReader([edge("edge", start, ref("OTHER"))]),
      { limits },
    );
    expect(result).toMatchObject({
      completion: "budget-limit",
      shortestPathCertain: false,
    });
  });

  it("reports the deadline budget before starting another frontier read", async () => {
    let time = 0;
    const result = await searchEntityGraphPaths(
      ref("START"),
      ref("END"),
      graphReader([]),
      {
        limits: { deadlineMs: 10 },
        now: () => {
          time += 11;
          return time;
        },
      },
    );
    expect(result).toMatchObject({
      completion: "budget-limit",
      shortestPathCertain: false,
    });
  });
});
