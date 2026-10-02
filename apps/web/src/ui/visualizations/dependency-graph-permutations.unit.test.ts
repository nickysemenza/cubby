import { instance } from "@viz-js/viz";
import { expect, it } from "vitest";

import {
  layoutGraph,
  prepareGraph,
  type GraphData,
  type GraphFilters,
} from "./dependency-graph-model";

const data: GraphData = {
  nodes: [
    {
      id: "p",
      kind: "project",
      name: "Main project",
      metadata: [],
      locations: ["Workshop"],
      href: "/projects/p",
    },
    {
      id: "q",
      kind: "project",
      name: "Nested project",
      metadata: [],
      parentId: "p",
      locations: ["Garden"],
      href: "/projects/q",
    },
    {
      id: "r",
      kind: "project",
      name: "Completed project",
      metadata: [],
      completed: true,
      href: "/projects/r",
    },
    {
      id: "a",
      kind: "task",
      name: 'A < B & "quoted"',
      metadata: ["Overdue"],
      parentId: "p",
      locations: ["Workshop"],
      overdue: true,
      href: "/tasks/a",
    },
    {
      id: "b",
      kind: "task",
      name: "Subtask",
      metadata: [],
      parentId: "a",
      locations: ["Workshop"],
      href: "/tasks/b",
    },
    {
      id: "c",
      kind: "task",
      name: "Completed task",
      metadata: [],
      completed: true,
      parentId: "q",
      locations: ["Garden"],
      href: "/tasks/c",
    },
    {
      id: "d",
      kind: "task",
      name: "Unassigned task",
      metadata: [],
      href: "/tasks/d",
    },
  ],
  edges: [
    { source: "p", target: "q", kind: "hierarchy" },
    { source: "p", target: "a", kind: "hierarchy" },
    { source: "a", target: "b", kind: "hierarchy" },
    { source: "q", target: "c", kind: "hierarchy" },
    { source: "a", target: "b", kind: "dependency" },
    { source: "b", target: "c", kind: "dependency" },
    { source: "a", target: "c", kind: "dependency" },
  ],
};

for (let index = 0; index < 12; index++) {
  const id = `leaf${index}`;
  data.nodes.push({
    id,
    kind: "task",
    name: `Independent task ${index}`,
    metadata: [],
    parentId: "p",
    locations: ["Workshop"],
    href: `/tasks/${id}`,
  });
  data.edges.push({ source: "p", target: id, kind: "hierarchy" });
}

it("renders every work and recipe filter combination with complete, nonoverlapping records", async () => {
  const viz = await instance();
  const verify = (source: GraphData, filters: GraphFilters) => {
    const graph = prepareGraph(source, filters);
    const { dot, hierarchyEdges } = layoutGraph(
      graph,
      filters.grouped,
      filters.groupByLocation,
    );
    const result = viz.render(dot, { format: "plain" });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const nodes = result.output
      .split("\n")
      .filter((line) => line.startsWith("node "))
      .map((line) => {
        const [_, id, x, y, width, height] = line.split(" ");
        return {
          id,
          x: Number(x),
          y: Number(y),
          width: Number(width),
          height: Number(height),
        };
      });
    expect(nodes.map((node) => node.id).sort()).toEqual(
      graph.nodes.map((node) => node.id).sort(),
    );
    for (const [index, node] of nodes.entries()) {
      expect(node.width).toBeGreaterThan(0);
      expect(node.height).toBeGreaterThan(0);
      for (const other of nodes.slice(index + 1)) {
        const overlaps =
          Math.abs(node.x - other.x) < (node.width + other.width) / 2 - 0.01 &&
          Math.abs(node.y - other.y) < (node.height + other.height) / 2 - 0.01;
        expect(overlaps).toBe(false);
      }
    }
    for (const edge of graph.edges.filter(
      (candidate) => !hierarchyEdges.includes(candidate),
    )) {
      expect(dot).toContain(`"${edge.source}" -> "${edge.target}"`);
    }
  };
  let count = 0;
  for (const workKind of ["all", "project", "task"] as const)
    for (const grouped of [false, true])
      for (const groupByLocation of [false, true])
        for (const direction of ["all", "upstream", "downstream"] as const)
          for (const hideCompleted of [false, true])
            for (const reduceEdges of [false, true])
              for (const location of [undefined, "", "Workshop", "Garden"])
                for (const focus of [undefined, "p", "b"]) {
                  verify(data, {
                    workKind,
                    grouped,
                    groupByLocation,
                    direction,
                    hideCompleted,
                    reduceEdges,
                    location,
                    focus,
                    hideUnconnected: false,
                  });
                  count++;
                }
  const recipes: GraphData = {
    nodes: data.nodes.map((node) => ({
      ...node,
      kind: "recipe",
      parentId: node.id < "c" ? "book-a" : "book-b",
      metadata: ["Cookbook"],
      completed: false,
      overdue: false,
    })),
    edges: data.edges
      .filter((edge) => edge.kind === "dependency")
      .map((edge) => ({ ...edge, label: "uses" })),
  };
  for (const grouped of [false, true])
    for (const direction of ["all", "upstream", "downstream"] as const)
      for (const hideUnconnected of [false, true])
        for (const reduceEdges of [false, true])
          for (const focus of [undefined, "a", "b", "d"]) {
            verify(recipes, {
              grouped,
              direction,
              hideUnconnected,
              reduceEdges,
              focus,
              hideCompleted: false,
            });
            count++;
          }
  expect(count).toBe(1824);
}, 30000);
