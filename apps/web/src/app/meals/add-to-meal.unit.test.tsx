import {
  unsafeMealShortcode,
  unsafeRecipeShortcode,
} from "@cubby/schemas/identifiers";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addRecipe: vi.fn(),
  createMeal: vi.fn(),
  updateMeal: vi.fn(),
  getByDateRange: vi.fn(),
  invalidate: vi.fn(),
  navigate: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: { mutationFn: (input: unknown) => unknown }) => ({
    mutate: (input: unknown) => options.mutationFn(input),
    mutateAsync: async (input: unknown) => options.mutationFn(input),
    isPending: false,
  }),
  useQuery: (options: { enabled?: boolean }) => {
    mocks.useQuery(options);
    return {
      data: [
        {
          id: unsafeMealShortcode("MEL-4K7M"),
          name: "Tuesday dinner",
          date: "2026-06-16",
          mealType: "dinner",
          mealKind: "cooked",
          recipes: [{ recipe: { name: "Soup" } }],
        },
        {
          id: unsafeMealShortcode("MEL-9Q2X"),
          name: "Corner Deli",
          date: "2026-06-16",
          mealType: "lunch",
          mealKind: "eating_out",
          recipes: [],
        },
      ],
      isLoading: false,
    };
  },
}));

vi.mock("~/entities/entity-mutation", () => ({
  entityMutationOptions: () => ({
    mutationFn: async (command: {
      action: "create" | "update" | "delete";
      id?: string;
      data?: unknown;
    }) => {
      if (command.action === "create") mocks.createMeal(command.data);
      if (command.action === "update") {
        mocks.updateMeal({ id: command.id, data: command.data });
      }
      return {
        item: { id: unsafeMealShortcode("MEL-4K7M"), date: "2026-06-16" },
        sideEffects: { backgroundBatches: [] },
      };
    },
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    meal: {
      getByDateRange: {
        queryOptions: (input: unknown) => {
          mocks.getByDateRange(input);
          return { queryKey: ["meal-range"] };
        },
      },
      create: {
        mutationOptions: () => ({ mutationFn: mocks.createMeal }),
      },
      addRecipe: {
        mutationOptions: () => ({ mutationFn: mocks.addRecipe }),
      },
      update: {
        mutationOptions: () => ({ mutationFn: mocks.updateMeal }),
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

    expect(mocks.useQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add to meal" }));

    expect(mocks.useQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );

    expect(mocks.getByDateRange).toHaveBeenCalledWith(
      expect.objectContaining({
        from: expect.any(String),
        to: expect.any(String),
      }),
    );
    const slot = screen.getByRole("combobox", { name: "meal" });
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
      // Slot is suggested from the hour of day, so assert its presence rather
      // than a value that changes depending on when the suite runs.
      mealType: expect.any(String),
      mealKind: "cooked",
      recipes: [{ recipeId, scale: 1 }],
    });
    expect(mocks.addRecipe).not.toHaveBeenCalled();
  });

  it("warns before planning a recipe into a meal that isn't cooked", async () => {
    // The silent loss this prevents: only `cooked` meals feed the shopping
    // list, so a recipe planned into an eating-out meal is never shopped for.
    render(<AddToMeal recipeId={recipeId} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to meal" }));

    const picker = screen.getByRole("combobox", { name: "meal" });
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    fireEvent.click(
      screen.getByRole("option", { name: "Corner Deli — Eating out" }),
    );

    expect(
      screen.getByText(/aren't added to the shopping list/i),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Add to selected meal" }),
    );

    // Re-kinded FIRST, so the meal is never briefly a non-cooked meal holding
    // a recipe — that intermediate state is the one the list drops.
    await vi.waitFor(() =>
      expect(mocks.updateMeal).toHaveBeenCalledWith({
        id: "MEL-9Q2X",
        data: { mealKind: "cooked" },
      }),
    );
    await vi.waitFor(() =>
      expect(mocks.addRecipe).toHaveBeenCalledWith({
        mealId: "MEL-9Q2X",
        recipeId,
        scale: 1,
      }),
    );
  });
});
