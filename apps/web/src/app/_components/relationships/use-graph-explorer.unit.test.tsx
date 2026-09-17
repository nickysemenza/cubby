import type { EntityRef } from "@cubby/schemas/entity";
import type { EntityGraphExploreOutput } from "@cubby/schemas/entity-graph";
import { testShortcode } from "@cubby/schemas/testing";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityGraph } from "~/entities/entity-graph.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { graphBranchKey, graphRefKey } from "./entity-graph-state";
import { useGraphExplorer } from "./use-graph-explorer";

const root: EntityRef = { entityType: "vendor", entityId: "VEN-2345" };
const member = (index: number): EntityRef => ({
  entityType: "purchase",
  entityId: testShortcode("purchase", `graph-member-${index}`),
});
function fixture(
  start: EntityRef,
  members: EntityRef[],
  total = members.length,
  nextOffset: number | null = null,
): EntityGraphExploreOutput {
  const edges = members.map((ref) => ({
    id: `${graphRefKey(start)}>${graphRefKey(ref)}`,
    source: start,
    target: ref,
    label: "Connected records",
    relationshipKey: "members",
    sourceKey: "fixture.members",
    provenance: [],
  }));
  return {
    nodes: [start, ...members].map((ref) => ({
      ...ref,
      label: `Fixture ${ref.entityId}`,
      metadata: {},
    })),
    edges,
    branches: [
      {
        root: start,
        relationshipKey: "members",
        label: "Connected records",
        target: "purchase",
        items: members,
        totalCount: total,
        nextOffset,
        edgeIds: edges.map((edge) => edge.id),
      },
    ],
    paths: [],
    truncated: nextOffset !== null,
    completion: { status: "depth-limit", requestedDepth: 1, reachedDepth: 1 },
  };
}
let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => harness.dispose());

describe("graph exploration session", () => {
  it("selects without reading, expands explicitly, and restores cached exploration on return", async () => {
    const reads: string[] = [];
    const operations = {
      ...entityGraph,
      explore: entityGraph.explore.withTransport(async ({ input }) => {
        reads.push(graphRefKey(input.root));
        return fixture(input.root, [
          input.root.entityType === "vendor" ? member(1) : member(2),
        ]);
      }),
    };
    const first = renderHook(() => useGraphExplorer(root, operations), {
      wrapper: harness.wrapper,
    });
    await waitFor(() => expect(first.result.current.map.nodes).toHaveLength(2));
    act(() => first.result.current.select(graphRefKey(member(1))));
    expect(reads).toEqual([graphRefKey(root)]);
    await act(() => first.result.current.expand(member(1)));
    await act(() => first.result.current.expand(member(1)));
    expect(first.result.current.map.nodes).toHaveLength(3);
    expect(reads).toEqual([graphRefKey(root), graphRefKey(member(1))]);
    first.unmount();
    const returned = renderHook(() => useGraphExplorer(root, operations), {
      wrapper: harness.wrapper,
    });
    expect(returned.result.current.selected).toBe(graphRefKey(member(1)));
    expect(returned.result.current.map.nodes).toHaveLength(3);
    act(() => returned.result.current.back(-1));
    expect(returned.result.current.selected).toBe(graphRefKey(root));
  });

  it("accumulates multiple branch pages, retries a failed page, and reopens cached members", async () => {
    const members = Array.from({ length: 30 }, (_, index) => member(index));
    const offsets: number[] = [];
    let fail = true;
    const operations = {
      ...entityGraph,
      explore: entityGraph.explore.withTransport(async () =>
        fixture(root, members.slice(0, 12), 30, 12),
      ),
      graph: entityGraph.graph.withTransport(async ({ input }) => {
        offsets.push(input.offset ?? 0);
        if (fail) throw new Error("Temporary fixture outage");
        const offset = input.offset ?? 0;
        return fixture(
          root,
          members.slice(offset, offset + 12),
          30,
          offset + 12 < 30 ? offset + 12 : null,
        );
      }),
    };
    const { result } = renderHook(() => useGraphExplorer(root, operations), {
      wrapper: harness.wrapper,
    });
    await waitFor(() => expect(result.current.data.nodes).toHaveLength(13));
    expect(result.current.map.nodes).toHaveLength(13);
    const branch = () => result.current.data.branches[0]!;
    await act(() => result.current.more(branch()));
    expect(result.current.map.nodes).toHaveLength(13);
    expect(offsets).toEqual([12]);
    expect(result.current.errors.has(graphBranchKey(root, "members"))).toBe(
      true,
    );
    fail = false;
    await act(() => result.current.more(branch()));
    await act(() => result.current.more(branch()));
    expect(result.current.map.nodes).toHaveLength(31);
    expect(offsets).toEqual([12, 12, 24]);
    act(() => result.current.collapse(branch()));
    expect(result.current.map.nodes).toHaveLength(1);
    expect(result.current.data.nodes).toHaveLength(31);
    await act(() => result.current.more(branch()));
    expect(result.current.map.nodes).toHaveLength(13);
    expect(offsets).toHaveLength(3);
  });

  it("does not save a stale expansion after leaving a map", async () => {
    let finish!: (page: EntityGraphExploreOutput) => void;
    const delayed = new Promise<EntityGraphExploreOutput>((resolve) => {
      finish = resolve;
    });
    const operations = {
      ...entityGraph,
      explore: entityGraph.explore.withTransport(async ({ input }) =>
        input.root.entityType === "vendor"
          ? fixture(root, [member(1)])
          : delayed,
      ),
    };
    const first = renderHook(() => useGraphExplorer(root, operations), {
      wrapper: harness.wrapper,
    });
    await waitFor(() =>
      expect(first.result.current.data.nodes).toHaveLength(2),
    );
    let expanding: Promise<void>;
    act(() => {
      expanding = first.result.current.expand(member(1));
    });
    first.unmount();
    await act(async () => {
      finish(fixture(member(1), [member(2)]));
      await expanding;
    });
    const returned = renderHook(() => useGraphExplorer(root, operations), {
      wrapper: harness.wrapper,
    });
    expect(returned.result.current.data.nodes).toHaveLength(2);
    expect(returned.result.current.busy.size).toBe(0);
  });
});
