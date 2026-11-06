import type { EntityGraphOutput } from "@cubby/schemas/entity-graph";
import { describe, expect, it } from "vitest";

import {
  graphBranchKey,
  graphRefKey,
  mergeGraphPages,
} from "./entity-graph-state";
import { placeGraphMap } from "./graph-map-layout";
import { graphBranchCount, projectGraphMap } from "./graph-map-state";

const root = { entityKind: "vendor", entityId: "VEN-2345" } as const;
const child = { entityKind: "purchase", entityId: "PUR-2345" } as const;
const edge = {
  id: "purchase-vendor",
  source: child,
  target: root,
  label: "Vendor",
  relationshipKey: "vendor",
  sourceKey: "purchase.vendor",
  provenance: ["purchase.vendorId"],
};
const branch = {
  root,
  relationshipKey: "purchases",
  target: "purchase" as const,
  label: "Purchases",
  totalCount: 250,
  nextOffset: 12,
  items: [child],
  edgeIds: [edge.id],
};
const page: EntityGraphOutput = {
  nodes: [
    { ...root, label: "Fixture vendor", metadata: {} },
    { ...child, label: "Fixture order", metadata: {} },
  ],
  edges: [edge],
  branches: [branch],
  truncated: true,
};

describe("persistent graph map", () => {
  it("keeps a high-degree relationship collapsed until requested", () => {
    expect(projectGraphMap(page, root, new Map()).nodes).toEqual([
      page.nodes[0],
    ]);
  });
  it("does not open a visible record's sibling branches automatically", () => {
    const sibling = { entityKind: "expense", entityId: "EXP-2345" } as const;
    const siblingEdge = {
      ...edge,
      id: "other-expense",
      source: sibling,
      target: child,
    };
    const data = {
      ...page,
      nodes: [
        ...page.nodes,
        { ...sibling, label: "Another expense", metadata: {} },
      ],
      edges: [...page.edges, siblingEdge],
      branches: [
        ...page.branches,
        {
          ...branch,
          root: child,
          target: "expense" as const,
          relationshipKey: "expenses",
          totalCount: 1,
          items: [sibling],
          edgeIds: [siblingEdge.id],
          nextOffset: null,
        },
      ],
    };
    const shown = projectGraphMap(
      data,
      root,
      new Map([[graphBranchKey(root, "purchases"), 1]]),
    );
    expect(shown.nodes.map(graphRefKey)).toEqual([
      graphRefKey(root),
      graphRefKey(child),
    ]);
    expect(
      projectGraphMap(data, root, new Map(), new Set(), true).nodes,
    ).toHaveLength(3);
  });
  it("reveals the first loaded page only after explicit expansion", () => {
    expect(graphBranchCount(branch, new Map(), root)).toBe(0);
    expect(projectGraphMap(page, root, new Map()).nodes).toHaveLength(1);
    const shown = projectGraphMap(
      page,
      root,
      new Map([[graphBranchKey(root, "purchases"), 12]]),
    );
    expect(shown.nodes).toHaveLength(2);
    expect(shown.edges).toEqual([edge]);
  });
  it("shows twelve of thirteen loaded members until the branch is explicitly expanded", () => {
    const members = Array.from({ length: 13 }, (_, index) => ({
      ...child,
      entityId: `PUR-${index}`,
    }));
    const data: EntityGraphOutput = {
      ...page,
      nodes: [
        page.nodes[0]!,
        ...members.map((member) => ({
          ...member,
          label: member.entityId,
          metadata: {},
        })),
      ],
      edges: members.map((member) => ({
        ...edge,
        id: `purchase-vendor-${member.entityId}`,
        source: member,
      })),
      branches: [
        {
          ...branch,
          totalCount: 13,
          nextOffset: 12,
          items: members,
          edgeIds: members.map(
            (member) => `purchase-vendor-${member.entityId}`,
          ),
        },
      ],
    };
    const key = graphBranchKey(root, "purchases");
    expect(graphBranchCount(data.branches[0]!, new Map(), root)).toBe(0);
    expect(
      projectGraphMap(data, root, new Map([[key, 12]])).nodes,
    ).toHaveLength(13);
    expect(graphBranchCount(data.branches[0]!, new Map([[key, 0]]))).toBe(0);
    expect(graphBranchCount(data.branches[0]!, new Map([[key, 13]]))).toBe(13);
  });
  it("keeps shared evidence visible through another expanded branch", () => {
    const other = {
      ...branch,
      relationshipKey: "other",
      totalCount: 1,
      nextOffset: null,
    };
    const data = { ...page, branches: [branch, other] };
    const result = projectGraphMap(
      data,
      root,
      new Map([
        [graphBranchKey(root, "purchases"), 0],
        [graphBranchKey(root, "other"), 1],
      ]),
    );
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
  });
  it("retains parallel edge identities and applies one budget across pages", () => {
    const parallel = { ...edge, id: "parallel-evidence" };
    const merged = mergeGraphPages([
      page,
      {
        ...page,
        edges: [parallel],
        branches: [{ ...branch, edgeIds: [parallel.id] }],
      },
    ]);
    expect(merged.nodes).toHaveLength(2);
    expect(merged.edges.map((value) => value.id)).toEqual([
      edge.id,
      parallel.id,
    ]);
    const more = Array.from({ length: 510 }, (_, index) => ({
      ...child,
      entityId: `PUR-${index}`,
      label: `Order ${index}`,
      metadata: {},
    }));
    expect(
      mergeGraphPages([
        page,
        { nodes: more, edges: [], branches: [], truncated: false },
      ]).nodes,
    ).toHaveLength(500);
  });
  it("connects a discovered path without making it a fabricated relationship branch", () => {
    const result = projectGraphMap(
      { ...page, branches: [] },
      root,
      new Map(),
      new Set([edge.id]),
    );
    expect(result.nodes).toHaveLength(2);
  });
  it("places a dense fan compactly without moving earlier records", () => {
    const rootID = graphRefKey(root);
    const nodes = [
      { id: rootID },
      ...Array.from({ length: 149 }, (_, index) => ({
        id: `node-${index}`,
        anchor: rootID,
      })),
    ];
    const first = placeGraphMap({
      revision: 1,
      nodes: nodes.slice(0, 25),
      previous: {},
    });
    const full = placeGraphMap({
      revision: 2,
      nodes,
      previous: first.positions,
    });
    expect(Object.keys(full.positions)).toHaveLength(150);
    for (const [key, position] of Object.entries(first.positions))
      expect(full.positions[key]).toEqual(position);
    const frames = Object.values(full.positions);
    const focus = full.positions[rootID]!;
    expect(Math.min(...frames.map((frame) => frame.x))).toBeLessThan(focus.x);
    expect(Math.max(...frames.map((frame) => frame.x))).toBeGreaterThan(
      focus.x,
    );
    const overlapping = frames.flatMap((a, i) =>
      frames
        .slice(i + 1)
        .filter(
          (b) =>
            a.x < b.x + b.width &&
            a.x + a.width > b.x &&
            a.y < b.y + b.height &&
            a.y + a.height > b.y,
        ),
    );
    expect(overlapping).toEqual([]);
    const width =
      Math.max(...frames.map((frame) => frame.x + frame.width)) -
      Math.min(...frames.map((frame) => frame.x));
    const height =
      Math.max(...frames.map((frame) => frame.y + frame.height)) -
      Math.min(...frames.map((frame) => frame.y));
    expect(Math.max(width / height, height / width)).toBeLessThan(4);
  });
});
