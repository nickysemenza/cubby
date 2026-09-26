import { testShortcode } from "@cubby/schemas/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { entities } from "~/entities/entities";
import { entityGraph } from "~/entities/entity-graph.functions";

import { EntityMergeDialog } from "./entity-merge-dialog";

/**
 * `MergeImpactPreview` is documented as advisory-only (see
 * `entity-operation-impact-preview.tsx`): a `block` disposition on a loser
 * must never disable the dialog's own confirm action. The real merge
 * mutation re-checks and is the actual authority; only it may refuse.
 */
function blockingConnections(): Promise<{
  id: string;
  kind: "ingredient" | "vendor";
  redirectedFrom: null;
  groups: {
    direction: "incoming";
    edgeKey: string;
    label: string;
    role: "reference";
    otherKind: "recipe";
    count: number;
    items: never[];
    disposition: { code: string; effect: "block"; description: string };
  }[];
}> {
  return Promise.resolve({
    id: "irrelevant",
    kind: "ingredient",
    redirectedFrom: null,
    groups: [
      {
        direction: "incoming",
        edgeKey: "recipe.ingredient",
        label: "Recipes",
        role: "reference",
        otherKind: "recipe",
        count: 1,
        items: [],
        disposition: {
          code: "block-recipe-reference",
          effect: "block",
          description: "This ingredient is used by a recipe.",
        },
      },
    ],
  });
}

function renderWithClient(ui: ReactNode, queryClient = new QueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe("EntityMergeDialog impact preview", () => {
  it("ranked mode: a blocking disposition on the loser leaves Merge enabled", async () => {
    const keeper = {
      id: testShortcode("ingredient", "ING-4K7M"),
      name: "Potato starch",
    };
    const loser = {
      id: testShortcode("ingredient", "ING-4K7N"),
      name: "Potato Starch",
    };

    renderWithClient(
      <EntityMergeDialog
        entity="ingredient"
        open
        onOpenChange={() => {}}
        onConfirm={() => {}}
        isPending={false}
        rows={[keeper, loser]}
        impactPreviewOperations={{
          connections:
            entityGraph.connections.withTransport(blockingConnections),
        }}
      />,
    );

    expect(
      await screen.findByText("Blocks the merge", { exact: false }),
    ).toBeVisible();

    const confirm = screen.getByRole("button", { name: "Merge" });
    expect(confirm).not.toBeDisabled();
  });

  it("fixed mode: a blocking disposition on a selected candidate leaves Merge enabled", async () => {
    const keeper = {
      id: testShortcode("vendor", "VND-4K7M"),
      name: "Acme Supply",
      purchaseCount: 3,
      spend: 120,
    };
    const candidate = {
      id: testShortcode("vendor", "VND-4K7N"),
      name: "Acme Supply Co",
      purchaseCount: 1,
      spend: 40,
    };

    const config = entities.vendor.mergeable;
    if (!config?.candidateQuery) {
      throw new Error("vendor merge config must declare a candidateQuery");
    }
    const plan = config.candidateQuery(keeper);

    // Fresh forever: the pre-seeded cache below stands in for the network
    // candidate list, and this keeps the query from ever re-executing it.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    queryClient.setQueryData(plan.queryKey, { items: [candidate] });

    renderWithClient(
      <EntityMergeDialog
        entity="vendor"
        open
        onOpenChange={() => {}}
        onConfirm={() => {}}
        isPending={false}
        keeper={keeper}
        impactPreviewOperations={{
          connections:
            entityGraph.connections.withTransport(blockingConnections),
        }}
      />,
      queryClient,
    );

    fireEvent.click(await screen.findByRole("checkbox"));

    expect(
      await screen.findByText("Blocks the merge", { exact: false }),
    ).toBeVisible();

    const confirm = screen.getByRole("button", { name: /^Merge/ });
    expect(confirm).not.toBeDisabled();
  });
});
