import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recipe } from "~/app/recipes/recipe.functions";
import { image } from "~/entities/image.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import type { EntityActionRow } from "./entity-actions";
import {
  type SpecialistLifecycleOperations,
  useDeleteCookbookEntityAction,
  useDeleteImageEntityAction,
} from "./specialist-lifecycle-entity-actions";

const cookbookRow = {
  id: testShortcode("cookbook", "CKB-4K7M"),
  book: "Weeknight Suppers",
  recipeCount: 3,
} satisfies EntityActionRow;

const preservesRow = {
  id: testShortcode("cookbook", "CKB-4K7N"),
  book: "Preserves",
  recipeCount: 1,
} satisfies EntityActionRow;

const imageRow = {
  id: testShortcode("image", "IMG-4K7M"),
  filename: "shelf.jpg",
} satisfies EntityActionRow;

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function lifecycleOperations(
  onCookbookDelete: (cookbookId: string) => void,
  onImageDelete: (ids: readonly string[]) => void,
): SpecialistLifecycleOperations {
  return {
    deleteCookbook: recipe.deleteCookbook.withTransport(async ({ input }) => {
      onCookbookDelete(input.cookbookId);
      return { deletedRecipes: 3 };
    }),
    deleteImage: image.delete.withTransport(async ({ input }) => {
      onImageDelete(input.ids);
      return {
        deleted: input.ids.length,
        sideEffects: { backgroundBatches: [] },
      };
    }),
  };
}

function CookbookActionHarness({
  operations,
  row,
  onResolved,
}: {
  operations: SpecialistLifecycleOperations;
  row: EntityActionRow;
  onResolved: (success: boolean) => void;
}) {
  const action = useDeleteCookbookEntityAction(operations);
  const stageCookbook = () => {
    const pending = action.run?.([row]);
    if (pending) void pending.then((result) => onResolved(result.success));
  };

  return (
    <>
      <button type="button" onClick={stageCookbook}>
        Stage cookbook deletion
      </button>
      {action.dialog}
    </>
  );
}

function ImageActionHarness({
  operations,
  onResolved,
}: {
  operations: SpecialistLifecycleOperations;
  onResolved: (success: boolean) => void;
}) {
  const action = useDeleteImageEntityAction(operations);
  const stageImage = () => {
    const pending = action.run?.([imageRow]);
    if (pending) void pending.then((result) => onResolved(result.success));
  };

  return (
    <>
      <button type="button" onClick={stageImage}>
        Stage image deletion
      </button>
      {action.dialog}
    </>
  );
}

describe("specialist lifecycle catalog actions", () => {
  it("keeps Cookbook selection staged through its cascade confirmation", async () => {
    const cookbookDeletes: string[] = [];
    const resolved: boolean[] = [];
    render(
      <CookbookActionHarness
        operations={lifecycleOperations(
          (cookbookId) => cookbookDeletes.push(cookbookId),
          () => undefined,
        )}
        row={cookbookRow}
        onResolved={(success) => resolved.push(success)}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Stage cookbook deletion" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Delete 1 Cookbook?" }),
    ).toBeVisible();
    expect(screen.getByText(/sub-recipe/)).toBeVisible();
    expect(
      screen.getByText('"Weeknight Suppers" and its 3 imported recipes'),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(cookbookDeletes).toEqual([cookbookRow.id]));
    await waitFor(() => expect(resolved).toEqual([true]));
    await waitFor(() =>
      expect(harness.router.state.location.pathname).toBe("/cookbooks"),
    );
  });

  it("resolves Cookbook staging as cancelled without deleting", async () => {
    const cookbookDeletes: string[] = [];
    const resolved: boolean[] = [];
    render(
      <CookbookActionHarness
        operations={lifecycleOperations(
          (cookbookId) => cookbookDeletes.push(cookbookId),
          () => undefined,
        )}
        row={preservesRow}
        onResolved={(success) => resolved.push(success)}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Stage cookbook deletion" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Delete 1 Cookbook?" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(resolved).toEqual([false]));
    expect(cookbookDeletes).toEqual([]);
  });

  it("uses Image's hard-delete operation before returning to the image list", async () => {
    const imageDeletes: Array<readonly string[]> = [];
    const resolved: boolean[] = [];
    render(
      <ImageActionHarness
        operations={lifecycleOperations(
          () => undefined,
          (ids) => imageDeletes.push(ids),
        )}
        onResolved={(success) => resolved.push(success)}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Stage image deletion" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Delete 1 Image?" }),
    ).toBeVisible();
    expect(screen.getByText(/stored file/)).toBeVisible();
    expect(screen.getByText("shelf.jpg")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(imageDeletes).toEqual([[imageRow.id]]));
    await waitFor(() => expect(resolved).toEqual([true]));
    await waitFor(() =>
      expect(harness.router.state.location.pathname).toBe("/images"),
    );
  });
});
