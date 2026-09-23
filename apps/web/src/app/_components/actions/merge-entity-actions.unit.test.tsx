import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import type { EntityActionRow } from "./entity-actions";
import {
  type MergeMutation,
  mergeEntityActionDefinitions,
  useStagedMerge,
} from "./merge-entity-actions";

const keeper = {
  id: testShortcode("ingredient", "ING-4K7M"),
  name: "Potato starch",
} satisfies EntityActionRow;

const alias = {
  id: testShortcode("ingredient", "ING-4K7N"),
  name: "Potato Starch",
} satisfies EntityActionRow;

const mixedVendorPurchases = [
  {
    id: testShortcode("purchase", "PUR-4K7M"),
    vendorId: testShortcode("vendor", "VND-4K7M"),
  },
  {
    id: testShortcode("purchase", "PUR-4K7N"),
    vendorId: testShortcode("vendor", "VND-4K7N"),
  },
] satisfies readonly (EntityActionRow & { vendorId: string })[];

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function MergeActionHarness({
  mutation,
  onResolved,
}: {
  mutation: MergeMutation<void>;
  onResolved: (success: boolean) => void;
}) {
  const action = useStagedMerge("ingredient", mutation);
  const stageMerge = () => {
    const pending = action.run?.([keeper, alias]);
    if (pending) void pending.then((result) => onResolved(result.success));
  };

  return (
    <>
      <button type="button" onClick={stageMerge}>
        Stage ingredient merge
      </button>
      {action.dialog}
    </>
  );
}

function PurchaseAvailabilityHarness() {
  const purchaseAction = mergeEntityActionDefinitions[2];
  const availability = purchaseAction.use().availability;
  if (!availability)
    throw new Error("Purchase merge must declare availability.");
  const result = availability({
    entity: "purchase",
    surface: "selection",
    rows: mixedVendorPurchases,
  });

  return (
    <output>
      {result.status === "disabled" ? result.reason : "available"}
    </output>
  );
}

describe("merge entity actions", () => {
  it("bounds every merge action to a selection of at least two", () => {
    for (const definition of mergeEntityActionDefinitions) {
      expect(definition).toMatchObject({ minSelection: 2, verb: "merge" });
    }
  });

  it("keeps a staged selection until the merge dialog executes its typed mutation", async () => {
    const merges: Array<{ keepId: string; mergeIds: string[] }> = [];
    const resolved: boolean[] = [];
    render(
      <MergeActionHarness
        mutation={{
          isPending: false,
          mutateAsync: async (input) => {
            merges.push(input);
          },
        }}
        onResolved={(success) => resolved.push(success)}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Stage ingredient merge" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Merge ingredients?",
      }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() =>
      expect(merges).toEqual([{ keepId: keeper.id, mergeIds: [alias.id] }]),
    );
    await waitFor(() => expect(resolved).toEqual([true]));
  });

  it("rejects cross-vendor purchase selections before opening a merge dialog", async () => {
    render(<PurchaseAvailabilityHarness />, { wrapper: harness.wrapper });

    expect(
      await screen.findByText(
        "Purchases must share a vendor before they can be merged.",
      ),
    ).toBeVisible();
  });
});
