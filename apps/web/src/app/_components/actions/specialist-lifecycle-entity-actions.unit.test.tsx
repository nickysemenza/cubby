import { act, render, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type DialogProps = {
  description: string;
  items: { id: string; name: string }[];
  renderItem: (item: { id: string; name: string }) => unknown;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => Promise<void>;
};

const mocks = vi.hoisted(() => ({
  cookbookMutationOptions: vi.fn(),
  imageMutationOptions: vi.fn(),
  cookbookMutateAsync: vi.fn(),
  imageMutateAsync: vi.fn(),
  navigate: vi.fn(),
  dialogProps: null as DialogProps | null,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("~/app/recipes/recipe.functions", () => ({
  recipe: {
    deleteCookbook: { mutationOptions: mocks.cookbookMutationOptions },
  },
}));
vi.mock("~/entities/image.functions", () => ({
  image: { delete: { mutationOptions: mocks.imageMutationOptions } },
}));
vi.mock("../hooks/useActionMutation", () => ({
  useActionMutation: () => ({
    isPending: false,
    mutateAsync: (input: { cookbookId?: string; ids?: string[] }) =>
      input.cookbookId
        ? mocks.cookbookMutateAsync(input)
        : mocks.imageMutateAsync(input),
  }),
}));
vi.mock("~/components/dialogs/bulk-action-dialog", () => ({
  BulkActionDialog: (props: DialogProps) => {
    mocks.dialogProps = props;
    return null;
  },
}));

import type { EntityActionRow } from "./entity-actions";
import {
  useDeleteCookbookEntityAction,
  useDeleteImageEntityAction,
} from "./specialist-lifecycle-entity-actions";

describe("specialist lifecycle catalog actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dialogProps = null;
  });

  it("keeps Cookbook selection staged through its cascade confirmation", async () => {
    mocks.cookbookMutateAsync.mockResolvedValueOnce({ deletedRecipes: 3 });
    const { result, rerender } = renderHook(useDeleteCookbookEntityAction);
    let pending!: Promise<{ success: boolean }>;

    act(() => {
      pending = result.current.run?.([
        {
          id: "CKB-4K7M",
          book: "Weeknight Suppers",
          recipeCount: 3,
        } as EntityActionRow & { book: string; recipeCount: number },
      ]) as Promise<{ success: boolean }>;
    });
    rerender();
    render(result.current.dialog);

    await waitFor(() => expect(mocks.dialogProps).not.toBeNull());
    expect(mocks.dialogProps?.description).toContain("sub-recipe");
    expect(
      mocks.dialogProps?.renderItem({
        id: "CKB-4K7M",
        name: "Weeknight Suppers",
      }),
    ).toBe('"Weeknight Suppers" and its 3 imported recipes');

    await act(async () => mocks.dialogProps?.onSubmit());
    expect(mocks.cookbookMutateAsync).toHaveBeenCalledWith({
      cookbookId: "CKB-4K7M",
    });
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/cookbooks" });
    await expect(pending).resolves.toEqual({ success: true });
  });

  it("resolves Cookbook staging as cancelled without deleting", async () => {
    const { result, rerender } = renderHook(useDeleteCookbookEntityAction);
    let pending!: Promise<{ success: boolean }>;

    act(() => {
      pending = result.current.run?.([
        {
          id: "CKB-4K7N",
          book: "Preserves",
          recipeCount: 1,
        } as EntityActionRow & { book: string; recipeCount: number },
      ]) as Promise<{ success: boolean }>;
    });
    rerender();
    render(result.current.dialog);

    await waitFor(() => expect(mocks.dialogProps).not.toBeNull());
    act(() => mocks.dialogProps?.onOpenChange(false));
    await expect(pending).resolves.toEqual({ success: false });
    expect(mocks.cookbookMutateAsync).not.toHaveBeenCalled();
  });

  it("uses Image's hard-delete operation before returning to the image list", async () => {
    mocks.imageMutateAsync.mockResolvedValueOnce({ deleted: 1 });
    const { result, rerender } = renderHook(useDeleteImageEntityAction);
    let pending!: Promise<{ success: boolean }>;

    act(() => {
      pending = result.current.run?.([
        {
          id: "IMG-4K7M",
          filename: "shelf.jpg",
        } as EntityActionRow & { filename: string },
      ]) as Promise<{ success: boolean }>;
    });
    rerender();
    render(result.current.dialog);

    await waitFor(() => expect(mocks.dialogProps).not.toBeNull());
    expect(mocks.dialogProps?.description).toContain("stored file");
    await act(async () => mocks.dialogProps?.onSubmit());
    expect(mocks.imageMutateAsync).toHaveBeenCalledWith({
      ids: ["IMG-4K7M"],
    });
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/images" });
    await expect(pending).resolves.toEqual({ success: true });
  });
});
