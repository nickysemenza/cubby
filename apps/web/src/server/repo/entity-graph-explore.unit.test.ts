import type { EntityRef } from "@cubby/schemas/entity";
import type {
  EntityGraphEdge,
  EntityGraphNode,
  EntityGraphOutput,
} from "@cubby/schemas/entity-graph";
import { describe, expect, it } from "vitest";

import { exploreEntityGraph } from "./entity-graph-explore";

const ref = (id: string): EntityRef => ({
  entityType: "task",
  entityId: `TSK-${id}`,
});

const node = (value: EntityRef): EntityGraphNode => ({
  ...value,
  label: value.entityId,
  metadata: {},
});

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
    allEdges: readonly EntityGraphEdge[],
    onRead?: (roots: readonly EntityRef[], pageSize: number) => void,
  ) =>
  async (
    roots: readonly EntityRef[],
    pageSize: number,
  ): Promise<EntityGraphOutput> => {
    onRead?.(roots, pageSize);
    const pages = roots.map((root) => {
      const adjacent = allEdges
        .filter(
          (candidate) =>
            candidate.source.entityId === root.entityId ||
            candidate.target.entityId === root.entityId,
        )
        .sort((left, right) => left.id.localeCompare(right.id));
      return { root, adjacent, page: adjacent.slice(0, pageSize) };
    });
    const pageEdges = [
      ...new Map(
        pages.flatMap(({ page }) => page).map((item) => [item.id, item]),
      ).values(),
    ];
    const refs = [
      ...roots,
      ...pageEdges.flatMap((item) => [item.source, item.target]),
    ];
    return {
      nodes: [
        ...new Map(refs.map((item) => [item.entityId, node(item)])).values(),
      ],
      edges: pageEdges,
      branches: pages.map(({ root, adjacent, page }) => ({
        root,
        relationshipKey: "dependencies",
        label: "Dependencies",
        target: "task",
        totalCount: adjacent.length,
        nextOffset: adjacent.length > page.length ? page.length : null,
        items: page.map((item) =>
          item.source.entityId === root.entityId ? item.target : item.source,
        ),
        edgeIds: page.map((item) => item.id),
      })),
      truncated: false,
    };
  };

describe("entity graph exploration", () => {
  it("preserves cycles and distinct shortest explanatory routes", async () => {
    const root = ref("ROOT");
    const left = ref("LEFT");
    const right = ref("RIGHT");
    const destination = ref("DESTINATION");
    const cycle = ref("CYCLE");
    const result = await exploreEntityGraph(
      root,
      3,
      graphReader([
        edge("root-left", root, left),
        edge("root-right", root, right),
        edge("left-destination", left, destination),
        edge("right-destination", right, destination),
        edge("destination-cycle", destination, cycle),
        edge("cycle-left", cycle, left),
      ]),
    );

    expect(result.completion).toEqual({
      status: "exhausted",
      requestedDepth: 3,
      reachedDepth: 2,
    });
    expect(result.edges.map((item) => item.id)).toContain("cycle-left");
    expect(
      result.paths.filter(
        (path) => path.nodeRefs.at(-1)?.entityId === destination.entityId,
      ),
    ).toEqual([
      {
        nodeRefs: [root, left, destination],
        edgeIds: ["root-left", "left-destination"],
      },
      {
        nodeRefs: [root, right, destination],
        edgeIds: ["root-right", "right-destination"],
      },
    ]);
  });

  it("returns the first branch page without exhausting it", async () => {
    const root = ref("ROOT");
    const reads: { roots: number; pageSize: number }[] = [];
    const result = await exploreEntityGraph(
      root,
      1,
      graphReader(
        Array.from({ length: 13 }, (_, index) =>
          edge(
            `edge-${String(index).padStart(2, "0")}`,
            root,
            ref(String(index)),
          ),
        ),
        (roots, pageSize) => reads.push({ roots: roots.length, pageSize }),
      ),
    );

    expect(reads).toEqual([{ roots: 1, pageSize: 12 }]);
    expect(result.nodes).toHaveLength(13);
    expect(result.branches[0]).toMatchObject({
      totalCount: 13,
      nextOffset: 12,
    });
    expect(result.completion.status).toBe("pagination-limit");
    expect(result.truncated).toBe(true);
  });

  it("distinguishes exhausted, depth, read, and deadline completion", async () => {
    const root = ref("ROOT");
    const first = ref("FIRST");
    const second = ref("SECOND");
    const reader = graphReader([
      edge("first", root, first),
      edge("second", first, second),
    ]);

    await expect(
      exploreEntityGraph(root, 3, graphReader([])),
    ).resolves.toMatchObject({
      completion: { status: "exhausted", reachedDepth: 0 },
    });
    await expect(exploreEntityGraph(root, 1, reader)).resolves.toMatchObject({
      completion: { status: "depth-limit", reachedDepth: 1 },
    });
    await expect(
      exploreEntityGraph(root, 3, reader, { limits: { maxReads: 1 } }),
    ).resolves.toMatchObject({
      completion: { status: "budget-limit", reachedDepth: 1 },
    });

    let time = 0;
    await expect(
      exploreEntityGraph(root, 3, reader, {
        limits: { deadlineMs: 10 },
        now: () => {
          time += 11;
          return time;
        },
      }),
    ).resolves.toMatchObject({
      completion: { status: "budget-limit", reachedDepth: 0 },
    });
  });

  it("batches a wide frontier at no more than 25 roots", async () => {
    const root = ref("ROOT");
    const firstLayer = Array.from({ length: 30 }, (_, index) =>
      ref(String(index)),
    );
    const readSizes: number[] = [];
    await exploreEntityGraph(
      root,
      2,
      graphReader(
        firstLayer.map((item, index) => edge(`root-${index}`, root, item)),
        (roots) => readSizes.push(roots.length),
      ),
      { limits: { pageSize: 30 } },
    );

    expect(readSizes).toEqual([1, 25, 5]);
  });

  it("retains earlier levels when a later read reaches its budget", async () => {
    const root = ref("ROOT");
    const first = ref("FIRST");
    let reads = 0;
    const result = await exploreEntityGraph(
      root,
      3,
      async (roots, pageSize) => {
        reads += 1;
        return reads === 1
          ? graphReader([edge("first", root, first)])(roots, pageSize)
          : {
              nodes: [],
              edges: [],
              branches: [],
              truncated: true,
            };
      },
    );

    expect(result.completion).toEqual({
      status: "budget-limit",
      requestedDepth: 3,
      reachedDepth: 1,
    });
    expect(result.nodes.map((item) => item.entityId)).toEqual([
      root.entityId,
      first.entityId,
    ]);
    expect(result.edges).toEqual([expect.objectContaining({ id: "first" })]);
    expect(result.paths).toEqual([
      { nodeRefs: [root, first], edgeIds: ["first"] },
    ]);
  });

  it("keeps branch members, edge evidence, and resume offset aligned", async () => {
    const root = ref("ROOT");
    const first = ref("FIRST");
    const second = ref("SECOND");
    const result = await exploreEntityGraph(
      root,
      1,
      graphReader([
        edge("a-first", root, first),
        edge("b-second", root, second),
      ]),
      { limits: { maxEdges: 1 } },
    );

    expect(result.branches).toEqual([
      expect.objectContaining({
        items: [first],
        edgeIds: ["a-first"],
        nextOffset: 1,
      }),
    ]);
  });

  it.each([
    ["node", { maxNodes: 1 }],
    ["edge", { maxEdges: 0 }],
  ])(
    "reports a %s budget without dangling graph members",
    async (_name, limits) => {
      const root = ref("ROOT");
      const result = await exploreEntityGraph(
        root,
        1,
        graphReader([edge("edge", root, ref("OTHER"))]),
        { limits },
      );

      expect(result.completion.status).toBe("budget-limit");
      expect(
        result.edges.every((item) =>
          [item.source, item.target].every((endpoint) =>
            result.nodes.some(
              (candidate) => candidate.entityId === endpoint.entityId,
            ),
          ),
        ),
      ).toBe(true);
    },
  );
});
