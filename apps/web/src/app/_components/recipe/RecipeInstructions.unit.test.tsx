import type { RecipeOut } from "@cubby/schemas/recipe";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecipeInstructions } from "./RecipeInstructions";
import { recipeKitchenProgressStorageKey } from "./recipe-kitchen-progress";

vi.mock("~/lib/wasm", () => ({
  wasm: { parse_rich_text: (value: string) => value },
}));

vi.mock("./richtext", () => ({
  formatRichText: (value: string) => value,
}));

const recipe = (id = "RCP-ONE"): RecipeOut =>
  ({
    id,
    name: "Dinner",
    yield: null,
    servings: null,
    notes: null,
    images: [],
    sections: [
      {
        id: "section-one",
        name: null,
        ingredients: [],
        instructions: [{ instruction: "Mix the batter" }],
      },
    ],
  }) as unknown as RecipeOut;

beforeEach(() => localStorage.clear());

describe("RecipeInstructions kitchen progress", () => {
  it("restores completed steps after remount when the detail view opts in", async () => {
    const input = recipe();
    const progressKey = recipeKitchenProgressStorageKey(input.id);
    const first = render(
      <RecipeInstructions recipe={input} kitchenProgressKey={input.id} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /mix the batter/i }));
    await waitFor(() =>
      expect(localStorage.getItem(progressKey)).toContain("section-one:0"),
    );
    first.rerender(
      <RecipeInstructions
        recipe={{ ...input, servings: 2 }}
        kitchenProgressKey={input.id}
      />,
    );
    expect(
      screen.getByRole("button", { name: /mix the batter/i }),
    ).toHaveAttribute("aria-pressed", "true");
    first.unmount();

    render(<RecipeInstructions recipe={input} kitchenProgressKey={input.id} />);
    expect(
      screen.getByRole("button", { name: /mix the batter/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps embedded and export instruction views storage-free", () => {
    const input = recipe();
    render(<RecipeInstructions recipe={input} />);

    fireEvent.click(screen.getByRole("button", { name: /mix the batter/i }));
    expect(
      localStorage.getItem(recipeKitchenProgressStorageKey(input.id)),
    ).toBeNull();
  });
});
