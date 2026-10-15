import type { MealFoodAmount } from "@cubby/schemas/meal";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { FoodAmountEditor } from "./food-amount-editor";

function EditorHarness({
  sourceKind = "ingredient",
  initial = null,
}: {
  sourceKind?: "ingredient" | "recipe";
  initial?: MealFoodAmount | null;
}) {
  const [amount, setAmount] = useState(initial);
  return (
    <>
      <FoodAmountEditor
        amount={amount}
        onChange={setAmount}
        sourceKind={sourceKind}
        suggestedUnits={sourceKind === "recipe" ? ["bowl"] : undefined}
      />
      <output data-testid="amount">
        {amount ? `${amount.value}:${amount.unit}` : "empty"}
      </output>
    </>
  );
}

describe("FoodAmountEditor", () => {
  it("defaults to grams and parses typed fractions", () => {
    render(<EditorHarness />);

    expect(screen.getByLabelText("Unit")).toHaveValue("g");
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "1 1/2" },
    });

    expect(screen.getByTestId("amount")).toHaveTextContent("1.5:g");
  });

  it("keeps a source-specific unit outside the built-in suggestions", () => {
    render(<EditorHarness sourceKind="recipe" />);

    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("Unit"), {
      target: { value: "bowl" },
    });

    expect(screen.getByTestId("amount")).toHaveTextContent("2:bowl");
    expect(
      screen.getByText(/Suggested: bowl, g, serving, batch/),
    ).toBeVisible();
    expect(screen.getByText(/this amount can still be saved/i)).toBeVisible();
  });
});
