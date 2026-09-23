import type {
  EntityGraphExploreOutput,
  EntityGraphOutput,
} from "@cubby/schemas/entity-graph";
import { entityRecommendationsOut } from "@cubby/schemas/entity-recommendations";
import { expenseOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inventory } from "~/app/inventory/inventory.functions";
import { entityGraph } from "~/entities/entity-graph.functions";
import { recommendations } from "~/lib/recommendations.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

import { EntityRelations, type EntityRelationsState } from "./entity-relations";

const root = { entityType: "cookbook", entityId: "CKB-4K7M" } as const;
const recipe = { entityType: "recipe", entityId: "RCP-4K7M" } as const;
const ingredient = { entityType: "ingredient", entityId: "ING-4K7M" } as const;
const initial: EntityGraphExploreOutput = {
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
  paths: [{ nodeRefs: [root, recipe], edgeIds: ["test-edge"] }],
  completion: {
    status: "depth-limit",
    requestedDepth: 1,
    reachedDepth: 1,
  },
};
let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
  const recommendationOptions = recommendations.forEntity.queryOptions(root);
  harness.queryClient.setQueryDefaults(recommendationOptions.queryKey, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  harness.queryClient.setQueryData(recommendationOptions.queryKey, {
    source: root,
    basisKey: "no-suggestions",
    groups: [],
  });
});
afterEach(() => {
  harness.dispose();
});

describe("shared entity Relations", () => {
  it("keeps a full-page project proposal read-only until its reviewed change is applied", async () => {
    const expenseId = testShortcode("expense", "EXP-PROJ");
    const projectId = testShortcode("project", "PRJ-KTCN");
    const expenseRoot = { entityType: "expense", entityId: expenseId } as const;
    const graph: EntityGraphExploreOutput = {
      nodes: [{ ...expenseRoot, label: "Fixture purchase", metadata: {} }],
      edges: [],
      branches: [],
      truncated: false,
      paths: [],
      completion: {
        status: "exhausted",
        requestedDepth: 1,
        reachedDepth: 0,
      },
    };
    const update = vi.fn(async () => ({
      ...mock(expenseOut, {
        seed: 12,
        overrides: { id: expenseId, projectId },
      }),
      sideEffects: { backgroundBatches: [] },
    }));

    render(
      <EntityRelations
        entity="expense"
        sourceId={expenseId}
        operations={{
          ...entityGraph,
          explore: entityGraph.explore.withTransport(async () => graph),
          graph: entityGraph.graph.withTransport(async () => graph),
        }}
        recommendationOperations={{
          forEntity: recommendations.forEntity.withTransport(async () =>
            entityRecommendationsOut.parse({
              source: expenseRoot,
              basisKey: "expense-project:fixture",
              groups: [
                {
                  kind: "expense-project",
                  status: "ready",
                  currentTarget: null,
                  proposals: [
                    {
                      kind: "expense-project",
                      expenseId,
                      target: { id: projectId, name: "Kitchen refresh" },
                      effectiveStart: "2026-08-01",
                      effectiveEnd: "2026-10-31",
                      sameTradeCount: 2,
                      exactProductCount: 1,
                      supportingExpenses: [],
                      reasons: ["The purchase date falls within this project."],
                    },
                  ],
                },
              ],
            }),
          ),
        }}
        recommendationActionOperations={{
          expenseUpdate: () => ({ mutationFn: update }),
          inventoryMove: inventory.moveEntries,
        }}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Review Kitchen refresh suggestion",
      }),
    );
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText("Current:").parentElement).toHaveTextContent(
      "Unassigned",
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        {
          id: expenseId,
          data: { projectId },
        },
        expect.anything(),
      ),
    );
  });

  it("keeps relationship data usable when suggestions fail and retries them independently", async () => {
    harness.queryClient.removeQueries({
      queryKey: recommendations.forEntity.queryOptions(root).queryKey,
    });
    let failSuggestions = true;
    const recommendationOperations = {
      forEntity: recommendations.forEntity.withTransport(async () => {
        if (failSuggestions) throw new Error("recommendations unavailable");
        return {
          source: root,
          basisKey: "retry-basis",
          groups: [],
        };
      }),
    };
    const operations = {
      ...entityGraph,
      explore: entityGraph.explore.withTransport(async () => initial),
      graph: entityGraph.graph.withTransport(async () => initial),
    };
    render(
      <EntityRelations
        entity="cookbook"
        sourceId={root.entityId}
        operations={operations}
        recommendationOperations={recommendationOperations}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      await screen.findByRole("heading", { name: "Recipes" }),
    ).toBeVisible();
    expect(
      await screen.findByText("recommendations unavailable"),
    ).toBeVisible();
    failSuggestions = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry suggestions" }));
    await waitFor(() =>
      expect(
        screen.queryByText("recommendations unavailable"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "Recipes" })).toBeVisible();
  });

  it("explicitly explores two or three hops and reports bounded completion", async () => {
    const requests: Array<{ id: string; depth: number }> = [];
    const operations = {
      ...entityGraph,
      explore: entityGraph.explore.withTransport(async ({ input }) => {
        requests.push({ id: input.root.entityId, depth: input.depth });
        const focused =
          input.root.entityType === "recipe"
            ? {
                ...initial,
                nodes: [
                  { ...recipe, label: "Roast vegetables", metadata: {} },
                  { ...ingredient, label: "Carrots", metadata: {} },
                ],
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
                paths: [],
              }
            : initial;
        return {
          ...focused,
          completion: {
            status:
              input.depth === 3
                ? ("budget-limit" as const)
                : ("depth-limit" as const),
            requestedDepth: input.depth,
            reachedDepth: input.depth,
          },
        };
      }),
      graph: entityGraph.graph.withTransport(async () => initial),
    };
    render(
      <EntityRelations
        entity="cookbook"
        sourceId={root.entityId}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );

    await screen.findByRole("button", { name: "1 hop" });
    fireEvent.click(
      screen.getByRole("button", { name: "Explore Roast vegetables" }),
    );
    await waitFor(() =>
      expect(requests).toContainEqual({ id: recipe.entityId, depth: 1 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "3 hops" }));

    await waitFor(() =>
      expect(requests).toContainEqual({ id: recipe.entityId, depth: 3 }),
    );
    expect(
      await screen.findByText(
        /Exploration capacity was reached before every route could be checked/,
      ),
    ).toBeVisible();
  });

  it("loads each selected neighborhood and keeps visit history", async () => {
    const product = { entityType: "product", entityId: "PRD-4K7M" } as const;
    const inventory = {
      entityType: "inventory",
      entityId: "INV-4K7M",
    } as const;
    const chain = [root, recipe, ingredient, product, inventory];
    const requests: string[][] = [];
    const exploreRequests: string[] = [];
    const operations = {
      ...entityGraph,
      explore: entityGraph.explore.withTransport(async ({ input }) => {
        exploreRequests.push(input.root.entityId);
        const source = input.root;
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
          paths: [],
          completion: {
            status: "depth-limit" as const,
            requestedDepth: input.depth,
            reachedDepth: 1,
          },
        };
      }),
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
    await waitFor(() => expect(exploreRequests).toContain(ingredient.entityId));
    fireEvent.click(
      screen.getByRole("button", { name: "Previous visited record" }),
    );
    expect(
      screen.getByRole("button", { name: "Next visited record" }),
    ).toBeEnabled();
    expect(requests).toEqual([[recipe.entityId], [ingredient.entityId]]);
    expect(exploreRequests.slice(0, 3)).toEqual([
      root.entityId,
      recipe.entityId,
      ingredient.entityId,
    ]);
    expect(exploreRequests.at(-1)).toBe(recipe.entityId);
  });

  it("shows populated groups first and preserves the selected record while exploring", async () => {
    const operations = {
      ...entityGraph,
      explore: entityGraph.explore.withTransport(async () => initial),
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
      explore: entityGraph.explore.withTransport(async ({ input }) => {
        requests.push(input.root.entityId);
        return input.root.entityType === "recipe"
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
              paths: [],
              completion: {
                status: "depth-limit" as const,
                requestedDepth: input.depth,
                reachedDepth: 1,
              },
            }
          : initial;
      }),
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

  it("restores a selected record hidden inside a counted branch", async () => {
    const hiddenRecipe = {
      entityType: "recipe",
      entityId: testShortcode("recipe", "hidden-counted-branch"),
    } as const;
    const hiddenEdge: EntityGraphOutput["edges"][number] = {
      id: "hidden-test-edge",
      source: hiddenRecipe,
      target: root,
      relationshipKey: "cookbook",
      sourceKey: "direct",
      label: "Cookbook",
      provenance: [],
    };
    const grouped = {
      ...initial,
      branches: initial.branches.map((branch) => ({
        ...branch,
        totalCount:
          branch.relationshipKey === "recipes" ? 250 : branch.totalCount,
      })),
    };
    let pathReads = 0;
    const operations = {
      ...entityGraph,
      explore: entityGraph.explore.withTransport(async () => grouped),
      graphPaths: entityGraph.graphPaths.withTransport(async () => {
        pathReads++;
        return {
          nodes: [
            initial.nodes[0]!,
            { ...hiddenRecipe, label: "Hidden recipe", metadata: {} },
          ],
          edges: [hiddenEdge],
          paths: [{ nodeRefs: [root, hiddenRecipe], edgeIds: [hiddenEdge.id] }],
          completion: "exhausted",
          shortestPathCertain: true,
        };
      }),
    };
    harness.queryClient.setQueryData(
      operations.explore.queryOptions({ root, depth: 1 }).queryKey,
      grouped,
    );
    render(
      <EntityRelations
        entity="cookbook"
        sourceId={root.entityId}
        operations={operations}
        state={{
          view: "graph",
          selected: `recipe:${hiddenRecipe.entityId}`,
        }}
      />,
      { wrapper: harness.wrapper },
    );
    expect(
      await screen.findByRole("button", { name: "Path 1 · 1 connections" }),
    ).toBeVisible();
    expect(pathReads).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear path" }));
    expect(
      await screen.findByRole("heading", { name: "Weeknight cookbook" }),
    ).toBeVisible();
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
      explore: entityGraph.explore.withTransport(async () => initial),
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
    fireEvent.click(screen.getByRole("button", { name: "Clear path" }));
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
      screen.queryByRole("button", { name: "Path 1 · 1 connections" }),
    ).not.toBeInTheDocument();
  });

  it("ignores a completed branch request after the selected record changes", async () => {
    let resolveBranch!: (value: EntityGraphOutput) => void;
    const branchRequest = new Promise<EntityGraphOutput>((resolve) => {
      resolveBranch = resolve;
    });
    const operations = {
      ...entityGraph,
      explore: entityGraph.explore.withTransport(async ({ input }) => ({
        ...initial,
        branches: [{ ...initial.branches[0]!, totalCount: 13, nextOffset: 1 }],
        completion: {
          status: "pagination-limit" as const,
          requestedDepth: input.depth,
          reachedDepth: 1,
        },
      })),
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

  it("shows physical connections separately from derived relationships", async () => {
    const image = { entityType: "image", entityId: "IMG-4K7M" } as const;
    const operations = {
      ...entityGraph,
      explore: entityGraph.explore.withTransport(async () => initial),
      graph: entityGraph.graph.withTransport(async () => initial),
      connections: entityGraph.connections.withTransport(async ({ input }) => ({
        id: input.id,
        kind: "cookbook",
        redirectedFrom: null,
        groups: [
          {
            direction: "incoming",
            edgeKey: "EntityAttachment.imageId",
            label: "Photos",
            role: "media",
            otherKind: "image",
            count: 1,
            items: [{ id: image.entityId, kind: "image", name: "Cover photo" }],
            disposition: null,
          },
        ],
      })),
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
      await screen.findByRole("heading", { name: "Physical connections" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Cover photo" })).toBeVisible();
  });

  it("hides the physical connections section when there are no groups", async () => {
    const operations = {
      ...entityGraph,
      explore: entityGraph.explore.withTransport(async () => initial),
      graph: entityGraph.graph.withTransport(async () => initial),
      connections: entityGraph.connections.withTransport(async ({ input }) => ({
        id: input.id,
        kind: "cookbook",
        redirectedFrom: null,
        groups: [],
      })),
    };
    render(
      <EntityRelations
        entity="cookbook"
        sourceId={root.entityId}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    await screen.findByRole("heading", { name: "Recipes" });
    expect(
      screen.queryByRole("heading", { name: "Physical connections" }),
    ).not.toBeInTheDocument();
  });

  it("offers a retry after an initial transport failure", async () => {
    let failed = true;
    const operations = {
      ...entityGraph,
      explore: entityGraph.explore.withTransport(async () => {
        if (failed) throw new Error("unavailable");
        return initial;
      }),
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
    expect(await screen.findByText("unavailable")).toHaveTextContent(
      "unavailable",
    );
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Recipes" })).toBeVisible(),
    );
  });
});
