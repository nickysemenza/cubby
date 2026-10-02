import { buildNutrition } from "@cubby/schemas/nutrition";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NutritionLabel } from "./NutritionLabel";

const complete = (lower: number, upper: number | null = null) => ({
  status: "complete" as const,
  lower,
  upper,
  coverage: { covered: 1, total: 1 },
});

const partial = (lower: number, upper: number | null = null) => ({
  status: "partial" as const,
  lower,
  upper,
  coverage: { covered: 1, total: 2 },
});

const unavailable = () =>
  ({ status: "unavailable", reason: "no_data" }) as const;

describe("NutritionLabel", () => {
  it("keeps missing core rows visible and distinguishes known zero from pending", () => {
    const estimates = buildNutrition((key) =>
      key === "kcal"
        ? { status: "pending", reason: "totals_stale" }
        : key === "fat"
          ? complete(0)
          : unavailable(),
    );

    render(<NutritionLabel estimates={estimates} servingLabel="per serving" />);

    expect(screen.getByText("Pending")).toHaveAttribute(
      "title",
      "Nutrition calculation pending",
    );
    expect(screen.queryByText(/Pending(?:g|mg|ug)/)).not.toBeInTheDocument();

    const fatRow = screen.getByRole("region", { name: "Total Fat" });
    expect(fatRow).toHaveTextContent("0 g");
    expect(fatRow).toHaveTextContent("0%");

    for (const name of [
      "Total Fat",
      "Saturated Fat",
      "Cholesterol",
      "Sodium",
      "Carbohydrates",
      "Fiber",
      "Protein",
    ]) {
      expect(screen.getByRole("region", { name })).toBeVisible();
    }
  });

  it("retains amount and Daily Value ranges without presenting a partial subtotal as exact", () => {
    const estimates = buildNutrition((key) =>
      key === "kcal"
        ? partial(120, 180)
        : key === "fat"
          ? partial(10, 20)
          : key === "fiber"
            ? complete(10, 20)
            : unavailable(),
    );

    render(<NutritionLabel estimates={estimates} servingLabel="per serving" />);

    expect(screen.getByText("120–180 known · partial")).toBeVisible();

    const fatRow = screen.getByRole("region", { name: "Total Fat" });
    expect(fatRow).toHaveTextContent("10 g–20 g known · partial");
    expect(
      within(fatRow).getByTitle(
        "Daily Value omitted because the nutrient estimate is partial",
      ),
    ).toHaveTextContent("—");
    expect(fatRow).not.toHaveTextContent("partialg");

    const fiberRow = screen.getByRole("region", { name: "Fiber" });
    expect(fiberRow).toHaveTextContent("10 g–20 g");
    expect(fiberRow).toHaveTextContent("36–71%");
  });
});
