import type { EntityGraphOutput } from "@cubby/schemas/entity-graph";
import { describe, expect, it } from "vitest";

import {
  graphBranchKey,
  graphRefKey,
  mergeGraphPages,
} from "./entity-graph-state";
import { placeGraphMap } from "./graph-map-layout";
import { graphBranchCount, projectGraphMap } from "./graph-map-state";

const root = { entityType: "vendor", entityId: "VEN-2345" } as const;
const child = { entityType: "purchase", entityId: "PUR-2345" } as const;
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
  it("projects the first loaded page of a large branch by default", () => {
    expect(graphBranchCount(branch, new Map())).toBe(1);
    expect(projectGraphMap(page, root, new Map()).nodes).toHaveLength(2);
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
    expect(graphBranchCount(data.branches[0]!, new Map())).toBe(12);
    expect(projectGraphMap(data, root, new Map()).nodes).toHaveLength(13);
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
      new Map([[graphBranchKey(root, "purchases"), 0]]),
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
