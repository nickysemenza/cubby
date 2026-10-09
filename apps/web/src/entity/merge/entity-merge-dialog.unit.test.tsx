import { testShortcode } from "@cubby/schemas/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { mergeConfigFor } from "~/entity/merge/merge-configs";
import { entityGraph } from "~/integrations/tanstack-query/generated/entity-graph.gen";

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

    const config = mergeConfigFor("vendor");
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

describe("EntityMergeDialog generic kernel merge", () => {
  it("keeps an undated Purchase selectable instead of filtering it from merge candidates", async () => {
    const keeper = {
      id: testShortcode("purchase", "PUR-4K7M"),
      vendorId: testShortcode("vendor", "VND-4K7M"),
      vendorName: "Synthetic supplier",
      date: "2026-03-01",
      orderId: "KNOWN-ORDER",
      displayLabel: null,
      expenseCount: 1,
      expenseTotal: 20,
    };
    const candidate = {
      ...keeper,
      id: testShortcode("purchase", "PUR-4K7N"),
      date: null,
      orderId: "UNDATED-ORDER",
      expenseCount: 0,
      expenseTotal: 0,
    };
    const config = mergeConfigFor("purchase");
    if (!config?.candidateQuery)
      throw new Error("Purchase candidate query missing");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    queryClient.setQueryData(config.candidateQuery(keeper).queryKey, {
      items: [candidate],
    });
    const onConfirm = vi.fn();
    renderWithClient(
      <EntityMergeDialog
        entity="purchase"
        open
        onOpenChange={() => {}}
        onConfirm={onConfirm}
        isPending={false}
        keeper={keeper}
        impactPreviewOperations={{
          connections: entityGraph.connections.withTransport(() =>
            Promise.resolve({
              id: candidate.id,
              kind: "purchase",
              redirectedFrom: null,
              groups: [],
            }),
          ),
        }}
      />,
      queryClient,
    );
    expect(await screen.findByText("UNDATED-ORDER")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Merge/ }));
    expect(onConfirm).toHaveBeenCalledWith(keeper.id, [candidate.id]);
  });

  it("offers a ranked merge for a kernel-merged entity without its own config", async () => {
    const onConfirm = vi.fn();
    const rows = [
      { id: testShortcode("plant", "PLANT-4K7M"), name: "Basil" },
      { id: testShortcode("plant", "PLANT-4K7N"), name: "Sweet basil" },
    ];

    renderWithClient(
      <EntityMergeDialog
        entity="plant"
        open
        onOpenChange={() => {}}
        onConfirm={onConfirm}
        isPending={false}
        rows={rows}
        impactPreviewOperations={{
          connections: entityGraph.connections.withTransport(() =>
            Promise.resolve({
              id: rows[1]!.id,
              kind: "plant",
              redirectedFrom: null,
              groups: [],
            }),
          ),
        }}
      />,
    );

    expect(await screen.findByText("Merge plants?")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(onConfirm).toHaveBeenCalledWith(rows[0]!.id, [rows[1]!.id]);
  });
});
