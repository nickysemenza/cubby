import type { EntityGraphOutput } from "@cubby/schemas/entity-graph";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityGraph } from "~/entities/entity-graph.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { EntityRelations, type EntityRelationsState } from "./entity-relations";

const root = { entityType: "cookbook", entityId: "CKB-4K7M" } as const;
const recipe = { entityType: "recipe", entityId: "RCP-4K7M" } as const;
const ingredient = { entityType: "ingredient", entityId: "ING-4K7M" } as const;
const initial: EntityGraphOutput = {
  nodes: [
    { ...root, label: "Weeknight cookbook", metadata: {} },
    { ...recipe, label: "Roast vegetables", metadata: {} },
  ],
  edges: [
    {
      id: "test-edge",
      source: recipe,
      target: root,
      relationshipKey: "cookbook",
      sourceKey: "direct",
      label: "Cookbook",
      provenance: [],
    },
  ],
  branches: [
    {
      root,
      relationshipKey: "recipes",
      label: "Recipes",
      target: "recipe",
      items: [recipe],
      totalCount: 1,
      edgeIds: ["test-edge"],
      nextOffset: null,
    },
    {
      root,
      relationshipKey: "product",
      label: "Product",
      target: "product",
      items: [],
      totalCount: 0,
      edgeIds: [],
      nextOffset: null,
    },
  ],
  truncated: false,
};
let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

describe("shared entity Relations", () => {
  it("loads each selected neighborhood and keeps visit history", async () => {
    const product = { entityType: "product", entityId: "PRD-4K7M" } as const;
    const inventory = {
      entityType: "inventory",
      entityId: "INV-4K7M",
    } as const;
    const chain = [root, recipe, ingredient, product, inventory];
    const requests: string[][] = [];
    const operations = {
      ...entityGraph,
      graph: entityGraph.graph.withTransport(async ({ input }) => {
        requests.push(input.roots.map((ref) => ref.entityId));
        const source = input.roots[0]!;
        const index = chain.findIndex(
          (ref) => ref.entityId === source.entityId,
        );
        const target = chain[index + 1];
        return {
          nodes: [source, ...(target ? [target] : [])].map((ref) => ({
            ...ref,
            label: ref.entityType,
            metadata: {},
          })),
          edges: target
            ? [
                {
                  id: source.entityId,
                  source,
                  target,
                  relationshipKey: "next",
                  sourceKey: "direct",
                  label: "Next",
                  provenance: [],
                },
              ]
            : [],
          branches: [
            {
              root: source,
              relationshipKey: "next",
              label: "Next",
              target: target?.entityType ?? "inventory",
              items: target ? [target] : [],
              edgeIds: target ? [source.entityId] : [],
              totalCount: target ? 1 : 0,
              nextOffset: null,
            },
          ],
          truncated: false,
        };
      }),
    };
    render(
      <EntityRelations
        entity="cookbook"
        sourceId={root.entityId}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    await screen.findByRole("heading", { name: "Next" });
    fireEvent.click(screen.getByRole("button", { name: "Explore recipe" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Explore ingredient" }),
    );
    await waitFor(() => expect(requests).toHaveLength(3));
    fireEvent.click(
      screen.getByRole("button", { name: "Previous visited record" }),
    );
    expect(
      screen.getByRole("button", { name: "Next visited record" }),
    ).toBeEnabled();
    expect(requests).toEqual([
      [root.entityId],
      [recipe.entityId],
      [ingredient.entityId],
    ]);
  });

  it("shows populated groups first and preserves the selected record while exploring", async () => {
    const operations = {
      ...entityGraph,
      graph: entityGraph.graph.withTransport(async ({ input }) =>
        input.roots[0]?.entityType === "recipe"
          ? {
              nodes: [
                { ...recipe, label: "Roast vegetables", metadata: {} },
                { ...ingredient, label: "Carrots", metadata: {} },
              ],
              edges: [
                {
                  id: "recipe-ingredient",
                  source: recipe,
                  target: ingredient,
                  relationshipKey: "ingredients",
                  sourceKey: "direct",
                  label: "Ingredients",
                  provenance: [],
                },
              ],
              branches: [
                {
                  root: recipe,
                  relationshipKey: "ingredients",
                  label: "Ingredients",
                  target: "ingredient",
                  items: [ingredient],
                  totalCount: 1,
                  edgeIds: ["recipe-ingredient"],
                  nextOffset: null,
                },
              ],
              truncated: false,
            }
          : initial,
      ),
    };
    render(
      <EntityRelations
        entity="cookbook"
        sourceId={root.entityId}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    expect(
      await screen.findByRole("heading", { name: "Recipes" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Product" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show empty" }));
    expect(screen.getByRole("heading", { name: "Product" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Explore Roast vegetables" }),
    );
    expect(await screen.findByRole("link", { name: "Carrots" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to start" }));
    expect(screen.getByRole("heading", { name: "Recipes" })).toBeVisible();
    expect(screen.getByText("3 explored records")).toBeVisible();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Filter entity type" }),
      {
        target: { value: "expense" },
      },
    );
    expect(
      screen.getByText("No relationships match the current filters."),
    ).toBeVisible();
  });

  it("restores a selected record from URL-backed state and loads its neighborhood", async () => {
    const requests: string[] = [];
    const operations = {
      ...entityGraph,
      graph: entityGraph.graph.withTransport(async ({ input }) => {
        requests.push(input.roots[0]!.entityId);
        return input.roots[0]!.entityType === "recipe"
          ? {
              nodes: [
                { ...recipe, label: "Roast vegetables", metadata: {} },
                { ...ingredient, label: "Carrots", metadata: {} },
              ],
              edges: [],
              branches: [
                {
                  root: recipe,
                  relationshipKey: "ingredients",
                  label: "Ingredients",
                  target: "ingredient" as const,
                  items: [ingredient],
                  totalCount: 1,
                  edgeIds: [],
                  nextOffset: null,
                },
              ],
              truncated: false,
            }
          : initial;
      }),
    };
    render(
      <EntityRelations
        entity="cookbook"
        sourceId={root.entityId}
        operations={operations}
        state={{
          view: "list",
          selected: "recipe:RCP-4K7M",
          trail: ["cookbook:CKB-4K7M", "recipe:RCP-4K7M"],
          cursor: 1,
        }}
      />,
      { wrapper: harness.wrapper },
    );
    expect(
      await screen.findByRole("heading", { name: "Ingredients" }),
    ).toBeVisible();
    expect(requests).toEqual([recipe.entityId]);
  });

  it("keeps a completed path response hidden after returning to explored records", async () => {
    let resolvePaths!: (value: {
      nodes: EntityGraphOutput["nodes"];
      edges: EntityGraphOutput["edges"];
      paths: { nodeRefs: [typeof root, typeof recipe]; edgeIds: string[] }[];
      completion: "exhausted";
      shortestPathCertain: true;
    }) => void;
    const pathRequest = new Promise<Parameters<typeof resolvePaths>[0]>(
      (resolve) => {
        resolvePaths = resolve;
      },
    );
    const operations = {
      ...entityGraph,
      graph: entityGraph.graph.withTransport(async () => initial),
      graphPaths: entityGraph.graphPaths.withTransport(async () => pathRequest),
    };
    function CancelHarness() {
      const [state, setState] = useState<EntityRelationsState>({
        view: "graph",
        destination: "recipe:RCP-4K7M",
      });
      return (
        <EntityRelations
          entity="cookbook"
          sourceId={root.entityId}
          operations={operations}
          state={state}
          onStateChange={setState}
        />
      );
    }
    render(<CancelHarness />, { wrapper: harness.wrapper });
    expect(await screen.findByText("Searching for paths…")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Return to explored records" }),
    );
    await act(async () =>
      resolvePaths({
        nodes: initial.nodes,
        edges: initial.edges,
        paths: [{ nodeRefs: [root, recipe], edgeIds: ["test-edge"] }],
        completion: "exhausted",
        shortestPathCertain: true,
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Path 1 · 1 hops" }),
    ).not.toBeInTheDocument();
  });

  it("ignores a completed branch request after the selected record changes", async () => {
    let resolveBranch!: (value: EntityGraphOutput) => void;
    const branchRequest = new Promise<EntityGraphOutput>((resolve) => {
      resolveBranch = resolve;
    });
    const operations = {
      ...entityGraph,
      graph: entityGraph.graph.withTransport(async ({ input }) => {
        if (input.relationshipKeys) return branchRequest;
        if (input.roots[0]!.entityType === "recipe")
          return {
            nodes: [{ ...recipe, label: "Roast vegetables", metadata: {} }],
            edges: [],
            branches: [
              {
                root: recipe,
                relationshipKey: "ingredients",
                label: "Ingredients",
                target: "ingredient" as const,
                items: [],
                totalCount: 0,
                edgeIds: [],
                nextOffset: null,
              },
            ],
            truncated: false,
          };
        return {
          ...initial,
          branches: [
            { ...initial.branches[0]!, totalCount: 13, nextOffset: 1 },
          ],
        };
      }),
    };
    render(
      <EntityRelations
        entity="cookbook"
        sourceId={root.entityId}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Show 12 more" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Explore Roast vegetables" }),
    );
    resolveBranch(initial);
    expect(
      await screen.findByRole("button", { name: "Back to start" }),
    ).toBeVisible();
  });

  it("offers a retry after an initial transport failure", async () => {
    let failed = true;
    const operations = {
      ...entityGraph,
      graph: entityGraph.graph.withTransport(async () => {
        if (failed) throw new Error("unavailable");
        return initial;
      }),
    };
    render(
      <EntityRelations
        entity="cookbook"
        sourceId={root.entityId}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Relationships could not be loaded",
    );
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Recipes" })).toBeVisible(),
    );
  });
});
