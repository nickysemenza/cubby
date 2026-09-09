import { instance } from "@viz-js/viz";
import { describe, expect, it } from "vitest";

import {
  graphToDot,
  layoutGraph,
  prepareGraph,
  type GraphData,
} from "./dependency-graph-model";

const graph = (overrides: Partial<GraphData> = {}): GraphData => ({
  nodes: [
    { id: "project", name: "Project", metadata: [], href: "/projects/project" },
    { id: "a", name: "A", metadata: [], parentId: "project", href: "/todos/a" },
    { id: "b", name: "B", metadata: [], parentId: "project", href: "/todos/b" },
    { id: "c", name: "C", metadata: [], href: "/todos/c" },
  ],
  edges: [
    { source: "a", target: "b", kind: "dependency" },
    { source: "project", target: "a", kind: "hierarchy" },
    { source: "project", target: "b", kind: "hierarchy" },
  ],
  ...overrides,
});

const defaults = {
  direction: "all" as const,
  hideCompleted: false,
  hideUnconnected: false,
  reduceEdges: false,
  grouped: true,
};

describe("prepareGraph", () => {
  it("follows only dependency edges while retaining hierarchy context", () => {
    const prepared = prepareGraph(graph(), {
      ...defaults,
      focus: "b",
      direction: "upstream",
    });
    expect(prepared.nodes.map((node) => node.id)).toEqual([
      "project",
      "a",
      "b",
    ]);
    expect(prepared.edges).toHaveLength(3);
  });

  it("treats both directions as two traversals instead of zig-zagging through the focus", () => {
    const data = graph({
      edges: [
        { source: "a", target: "b", kind: "dependency" },
        { source: "b", target: "c", kind: "dependency" },
        { source: "a", target: "project", kind: "dependency" },
      ],
    });
    const prepared = prepareGraph(data, {
      ...defaults,
      focus: "b",
      direction: "all",
    });
    expect(prepared.nodes.map((node) => node.id)).toEqual([
      "project",
      "a",
      "b",
      "c",
    ]);
  });

  it("hides completed leaves but keeps completed ancestors as context", () => {
    const data = graph({
      nodes: [
        {
          id: "project",
          name: "Project",
          metadata: [],
          completed: true,
          href: "/projects/project",
        },
        {
          id: "a",
          name: "A",
          metadata: [],
          parentId: "project",
          href: "/todos/a",
        },
        {
          id: "done",
          name: "Done",
          metadata: [],
          completed: true,
          href: "/todos/done",
        },
      ],
      edges: [{ source: "project", target: "a", kind: "hierarchy" }],
    });
    expect(
      prepareGraph(data, { ...defaults, hideCompleted: true }).nodes.map(
        (node) => node.id,
      ),
    ).toEqual(["project", "a"]);
  });

  it("removes a completed-only hierarchy subtree", () => {
    const data = graph({
      nodes: [
        {
          id: "project",
          name: "Project",
          metadata: [],
          completed: true,
          href: "/projects/project",
        },
        {
          id: "done",
          name: "Done",
          metadata: [],
          parentId: "project",
          completed: true,
          href: "/todos/done",
        },
        { id: "open", name: "Open", metadata: [], href: "/todos/open" },
      ],
      edges: [{ source: "project", target: "done", kind: "hierarchy" }],
    });
    expect(
      prepareGraph(data, { ...defaults, hideCompleted: true }).nodes.map(
        (node) => node.id,
      ),
    ).toEqual(["open"]);
  });

  it("removes only transitive dependency edges outside cycles", () => {
    const data = graph({
      edges: [
        { source: "a", target: "b", kind: "dependency" },
        { source: "b", target: "c", kind: "dependency" },
        { source: "a", target: "c", kind: "dependency" },
        { source: "project", target: "a", kind: "hierarchy" },
      ],
    });
    const prepared = prepareGraph(data, { ...defaults, reduceEdges: true });
    expect(prepared.removedEdgeCount).toBe(1);
    expect(prepared.edges).not.toContainEqual({
      source: "a",
      target: "c",
      kind: "dependency",
    });
  });

  it("assigns a shared level to cycles without dropping them", () => {
    const data = graph({
      edges: [
        { source: "a", target: "b", kind: "dependency" },
        { source: "b", target: "a", kind: "dependency" },
        { source: "b", target: "c", kind: "dependency" },
      ],
    });
    const prepared = prepareGraph(data, defaults);
    expect(prepared.cycleIds).toEqual(["a", "b"]);
    expect(prepared.levels.a).toBe(prepared.levels.b);
    expect(prepared.levels.c).toBeGreaterThan(prepared.levels.b ?? -1);
  });
});

describe("graphToDot", () => {
  it("escapes labels and URLs and gives relationship kinds distinct classes", () => {
    const prepared = prepareGraph(
      graph({
        nodes: [
          {
            id: '"id"',
            name: 'A "quote"\\nline',
            metadata: ["Due soon"],
            href: '/todos/"id"',
          },
          { id: "b", name: "B", metadata: [], href: "/todos/b" },
        ],
        edges: [
          { source: '"id"', target: "b", kind: "dependency", label: "uses" },
        ],
      }),
      defaults,
    );
    const dot = graphToDot(prepared, true);
    expect(dot).toContain('"\\"id\\""');
    expect(dot).toContain("dependency-graph-node");
    expect(dot).toContain("dependency-graph-edge--dependency");
    expect(dot).toContain('label="uses"');
    expect(dot).not.toContain("undefined");
  });

  it("renders multiline labels as distinct Graphviz text lines", async () => {
    const prepared = prepareGraph(
      graph({
        nodes: [
          { id: "a", name: "First\nSecond", metadata: [], href: "/todos/a" },
        ],
        edges: [],
      }),
      defaults,
    );
    const viz = await instance();
    const svg = viz.renderString(graphToDot(prepared, false), {
      engine: "dot",
      format: "svg",
    });
    expect(svg).toContain(">First</text>");
    expect(svg).toContain(">Second</text>");
    expect(svg).toContain(">a</text>");
  });

  it("lets Graphviz lay out hierarchy-only parent and child at different depths", async () => {
    const prepared = prepareGraph(
      graph({
        nodes: [
          {
            id: "parent",
            name: "Parent",
            metadata: [],
            href: "/projects/parent",
          },
          {
            id: "child",
            name: "Child",
            metadata: [],
            parentId: "parent",
            href: "/todos/child",
          },
        ],
        edges: [{ source: "parent", target: "child", kind: "hierarchy" }],
      }),
      defaults,
    );
    const dot = graphToDot(prepared, true);
    expect(dot).not.toContain("rank=same");
    const viz = await instance();
    const plain = viz.renderString(dot, { engine: "dot", format: "plain" });
    const position = (id: string) =>
      Number(plain.match(new RegExp(`^node ${id} ([\\d.]+)`, "m"))?.[1]);
    expect(position("parent")).not.toBe(position("child"));
  });
});

it("keeps task siblings together when the project is filtered out", () => {
  const nodes: GraphData["nodes"] = Array.from({ length: 40 }, (_, i) => ({
    id: `task${i}`,
    name: `Task ${i}`,
    kind: "task",
    metadata: [],
    parentId: "project",
    parentName: "Example project",
    href: `/tasks/task${i}`,
  }));
  const dot = graphToDot(
    prepareGraph(
      {
        nodes: [
          {
            id: "project",
            name: "Example project",
            kind: "project",
            metadata: [],
            href: "/projects/project",
          },
          ...nodes,
        ],
        edges: [],
      },
      { ...defaults, workKind: "task" },
    ),
    true,
  );
  expect(dot.match(/label="Example project"/g)).toHaveLength(1);
});

it("packs a large recipe overview into a usable aspect ratio", async () => {
  const nodes = Array.from({ length: 240 }, (_, i) => ({
    id: `recipe${i}`,
    name: `Example recipe ${i}`,
    metadata: ["Example cookbook"],
    parentId: "cookbook",
    href: `/recipes/recipe${i}`,
  }));
  const edges = Array.from({ length: 120 }, (_, i) => ({
    source: `recipe${i * 2}`,
    target: `recipe${i * 2 + 1}`,
    kind: "dependency" as const,
    label: "uses",
  }));
  const viz = await instance();
  const plain = viz.renderString(
    graphToDot(prepareGraph({ nodes, edges }, defaults), true),
    { format: "plain" },
  );
  const [, , width, height] = plain.split("\n")[0]!.split(" ").map(Number);
  expect(height! / width!).toBeLessThan(3);
  expect(width! / height!).toBeLessThan(3);
});

it("shows only the requested work kind without opposite-kind ancestors or dangling edges", () => {
  const data: GraphData = {
    nodes: [
      {
        id: "p",
        name: "Project",
        kind: "project",
        metadata: [],
        href: "/projects/p",
      },
      {
        id: "t",
        name: "Task",
        kind: "task",
        parentId: "p",
        metadata: [],
        href: "/todos/t",
      },
    ],
    edges: [{ source: "p", target: "t", kind: "hierarchy" }],
  };
  for (const workKind of ["project", "task"] as const) {
    const prepared = prepareGraph(data, { ...defaults, workKind });
    expect(prepared.nodes.map((node) => node.kind)).toEqual([workKind]);
    expect(prepared.edges).toEqual([]);
    expect(prepared.hiddenNodeCount).toBe(1);
    expect(graphToDot(prepared, true)).toContain(`record-${workKind}`);
  }
});

describe("location grouping", () => {
  it("groups disconnected records together without duplicating multi-location work or losing edges", async () => {
    const data = graph();
    data.nodes[0]!.locations = ["Garage"];
    data.nodes[1]!.locations = ["Kitchen", "Garage"];
    data.nodes[2]!.locations = ["Garage", "Kitchen"];
    data.nodes[3]!.locations = ["Garage"];
    data.nodes.push({
      id: "unassigned",
      name: "Unassigned",
      metadata: [],
      href: "/tasks/unassigned",
    });
    const dot = graphToDot(prepareGraph(data, defaults), false, true);
    const viz = await instance();
    const svg = viz.renderString(dot, { format: "svg" });
    expect(dot.match(/class="dependency-graph-group"/g)).toHaveLength(3);
    expect(svg).toContain("Garage / Kitchen");
    expect(svg).toContain("No location");
    for (const node of data.nodes)
      expect(
        dot.split("\n").filter((line) => line.startsWith(`"${node.id}" [`)),
      ).toHaveLength(1);
    expect(dot).toContain('"a" -> "b"');
    expect(dot).toContain('"project" -> "a"');
  });
});

it("nests hierarchy clusters within locations even when siblings span locations", async () => {
  const data = graph();
  for (const node of data.nodes)
    node.locations = [node.id === "b" ? "Garden" : "Workshop"];
  const dot = graphToDot(prepareGraph(data, defaults), true, true);
  const viz = await instance();
  const result = viz.render(dot, { format: "json" });
  expect(result.status).toBe("success");
  expect(result.errors.filter((error) => error.level === "error")).toEqual([]);
  expect(dot.match(/class="dependency-graph-group"/g)).toHaveLength(4);
  for (const node of data.nodes) {
    expect(
      dot.split("\n").filter((line) => line.startsWith(`"${node.id}" [`)),
    ).toHaveLength(1);
  }
  expect(dot).toContain('"a" -> "b"');
  expect(dot).toContain('"project" -> "b"');
});

it("packs unconnected location records into a compact overview", async () => {
  const nodes = Array.from({ length: 74 }, (_, i) => ({
    id: `p${i}`,
    name: `Project ${i}`,
    metadata: [],
    locations: ["Workshop"],
    href: `/projects/p${i}`,
  }));
  const viz = await instance();
  const plain = viz.renderString(
    graphToDot(prepareGraph({ nodes, edges: [] }, defaults), true, true),
    { format: "plain" },
  );
  const [, , width, height] = plain.split("\n")[0]!.split(" ").map(Number);
  expect(height! / width!).toBeLessThan(3);
  expect(width! / height!).toBeLessThan(3);
});

it("scopes by location without dangling edges and counts omitted records", () => {
  const data = graph();
  data.nodes[1]!.locations = ["Workshop", "Garden"];
  data.nodes[2]!.locations = ["Workshop"];
  const scoped = prepareGraph(data, { ...defaults, location: "Workshop" });
  expect(scoped.nodes.map((node) => node.id)).toEqual(["a", "b"]);
  expect(scoped.edges).toEqual([
    { source: "a", target: "b", kind: "dependency" },
  ]);
  expect(scoped.hiddenNodeCount).toBe(2);
  expect(
    prepareGraph(data, { ...defaults, location: "" }).nodes.map(
      (node) => node.id,
    ),
  ).toEqual(["project", "c"]);
});

it("keeps a thousand sibling tasks from becoming a hundred-thousand-pixel column", async () => {
  const root = {
    id: "root",
    name: "Annual project",
    metadata: [],
    href: "/projects/root",
  };
  const nodes = [
    root,
    ...Array.from({ length: 1200 }, (_, i) => ({
      id: `task${i}`,
      name: `Maintenance task ${i}`,
      parentId: "root",
      metadata: [],
      href: `/tasks/task${i}`,
    })),
  ];
  const edges = nodes.slice(1).map((node) => ({
    source: "root",
    target: node.id,
    kind: "hierarchy" as const,
  }));
  const viz = await instance();
  const prepared = prepareGraph({ nodes, edges }, defaults);
  for (const grouped of [false, true]) {
    const layout = layoutGraph(prepared, grouped);
    expect(layout.hierarchyEdges.length).toBeGreaterThan(1000);
    expect(
      layout.hierarchyEdges.length +
        (layout.dot.match(/style=dotted/g)?.length ?? 0),
    ).toBe(1200);
    const plain = viz.renderString(layout.dot, {
      format: "plain",
    });
    const [, , width, height] = plain.split("\n")[0]!.split(" ").map(Number);
    expect(height! / width!).toBeLessThan(3);
    expect(width! / height!).toBeLessThan(3);
    expect(height! * 72).toBeLessThan(15000);
  }
}, 20000);
