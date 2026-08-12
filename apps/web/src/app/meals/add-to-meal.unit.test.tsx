import {
  unsafeMealShortcode,
  unsafeRecipeShortcode,
} from "@cubby/schemas/identifiers";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addRecipe: vi.fn(),
  createMeal: vi.fn(),
  getByDateRange: vi.fn(),
  invalidate: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: { mutationFn: unknown }) => ({
    mutate:
      options.mutationFn === mocks.createMeal
        ? mocks.createMeal
        : mocks.addRecipe,
    isPending: false,
  }),
  useQuery: () => ({
    data: [
      {
        id: unsafeMealShortcode("MEL-4K7M"),
        name: "Tuesday dinner",
        recipes: [{ recipe: { name: "Soup" } }],
      },
    ],
    isLoading: false,
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    meal: {
      getByDateRange: {
        queryOptions: mocks.getByDateRange,
      },
      create: {
        mutationOptions: () => ({ mutationFn: mocks.createMeal }),
      },
      addRecipe: {
        mutationOptions: () => ({ mutationFn: mocks.addRecipe }),
      },
    },
  }),
}));

vi.mock("./use-meal-mutations", () => ({
  useInvalidateMeals: () => mocks.invalidate,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { AddToMeal } from "./add-to-meal";

const recipeId = unsafeRecipeShortcode("RCP-4K7M");

afterEach(() => {
  vi.clearAllMocks();
});

describe("AddToMeal", () => {
  it("offers existing meal slots for the selected day and adds to the selected slot", () => {
    render(<AddToMeal recipeId={recipeId} />);

    fireEvent.click(screen.getByRole("button", { name: "Add to meal" }));

    expect(mocks.getByDateRange).toHaveBeenCalledWith(
      expect.objectContaining({
        from: expect.any(String),
        to: expect.any(String),
      }),
    );
    const slot = screen.getByRole("combobox", { name: "meal slot" });
    fireEvent.keyDown(slot, { key: "ArrowDown" });
    fireEvent.click(
      screen.getByRole("option", { name: "Tuesday dinner (1 recipe)" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add to selected meal" }),
    );

    expect(mocks.addRecipe).toHaveBeenCalledWith({
      mealId: "MEL-4K7M",
      recipeId,
      scale: 1,
    });
    expect(mocks.createMeal).not.toHaveBeenCalled();
  });

  it("retains creating a separate meal as the default", () => {
    render(<AddToMeal recipeId={recipeId} />);

    fireEvent.click(screen.getByRole("button", { name: "Add to meal" }));
    fireEvent.click(screen.getByRole("button", { name: "Create meal" }));

    expect(mocks.createMeal).toHaveBeenCalledWith({
      date: expect.any(String),
      recipes: [{ recipeId, scale: 1 }],
    });
    expect(mocks.addRecipe).not.toHaveBeenCalled();
  });
});
