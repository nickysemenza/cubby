import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  walkthroughPlan,
  walkthroughRecipe,
} from "./recipe-walkthrough.fixtures";
import { RecipeWalkthrough } from "./RecipeWalkthrough";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(async () => {
  harness = createBrowserTestHarness();
  await act(async () => {
    await harness.loadRouter();
  });
});
afterEach(() => {
  harness.dispose();
});

describe("RecipeWalkthrough", () => {
  it("navigates source-anchored stops with accessible progress and expandable explanations", () => {
    render(
      <RecipeWalkthrough recipe={walkthroughRecipe} plan={walkthroughPlan} />,
      { wrapper: harness.routerWrapper },
    );
    expect(screen.getAllByText("Line the cake tin.")[0]).toBeVisible();
    expect(
      screen.getAllByText("Whisk half of the sugar into the batter.")[0],
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(
      screen.getByText(walkthroughPlan.walkthrough!.stops[0]!.explanation),
    ).not.toBeVisible();
    fireEvent.click(screen.getByText("Why this step · AI explanation"));
    expect(
      screen.getByText(walkthroughPlan.walkthrough!.stops[0]!.explanation),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByRole("heading", { name: "Finish and bake" }),
    ).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Step 2 of 2");
    expect(screen.getByText("Cake batter")).toBeVisible();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "2. Finish and bake" }),
    ).toHaveAttribute("aria-current", "step");
    fireEvent.click(
      screen.getByRole("button", { name: "1. Start with the batter" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Step 1 of 2");
    expect(
      screen.getByText(walkthroughPlan.walkthrough!.stops[0]!.explanation),
    ).not.toBeVisible();
  });

  it("uses current ingredient amounts without multiplying divided additions or rewriting instructions", () => {
    const { rerender } = render(
      <RecipeWalkthrough recipe={walkthroughRecipe} plan={walkthroughPlan} />,
      { wrapper: harness.routerWrapper },
    );
    const ingredients = screen.getByRole("list", {
      name: "Ingredients and prepared components for Mix the batter",
    });
    expect(within(ingredients).getByText("100 g")).toBeVisible();
    expect(
      within(ingredients).getByText(/this is the batch total/),
    ).toBeVisible();
    const scaled = {
      ...walkthroughRecipe,
      sections: walkthroughRecipe.sections.map((section) => ({
        ...section,
        ingredients: section.ingredients.map((usage) => ({
          ...usage,
          amounts: [{ value: 200, unit: "g" }],
        })),
      })),
    };
    rerender(<RecipeWalkthrough recipe={scaled} plan={walkthroughPlan} />);
    expect(within(ingredients).getByText("200 g")).toBeVisible();
    expect(
      screen.getAllByText("Whisk half of the sugar into the batter.")[0],
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("200 g")).toBeVisible();
    expect(screen.getByText(/this is the batch total/)).toBeVisible();
  });

  it("keeps instructions omitted from the AI plan accessible in the original method", () => {
    render(
      <RecipeWalkthrough recipe={walkthroughRecipe} plan={walkthroughPlan} />,
      { wrapper: harness.routerWrapper },
    );
    expect(screen.getByText("Serve with lemon slices.")).not.toBeVisible();
    fireEvent.click(screen.getByText("Full original method"));
    expect(screen.getByText("Serve with lemon slices.")).toBeVisible();
  });

  it("shows a compound source instruction once when several operations share a stop", () => {
    const plan = {
      ...walkthroughPlan,
      operations: walkthroughPlan.operations.map((operation) => ({
        ...operation,
        instructionRefs: walkthroughPlan.operations[0]!.instructionRefs,
      })),
      walkthrough: {
        overview: "Mix and bake.",
        stops: [
          {
            id: "cakes",
            title: "Make the cakes",
            explanation: "Both actions belong together.",
            operationIds: ["mix", "bake"],
          },
        ],
      },
    };
    render(<RecipeWalkthrough recipe={walkthroughRecipe} plan={plan} />, {
      wrapper: harness.routerWrapper,
    });
    const instructions = screen.getByRole("region", {
      name: "Recipe instructions for Make the cakes",
    });
    expect(
      within(instructions).getAllByText(
        "Whisk half of the sugar into the batter.",
      ),
    ).toHaveLength(1);
  });
});
