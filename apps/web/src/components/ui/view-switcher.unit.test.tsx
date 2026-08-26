import { render, screen } from "@testing-library/react";
import { Grid2X2, List } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { ViewSwitcher } from "./view-switcher";

describe("ViewSwitcher", () => {
  it("keeps phone-compact labels accessible", () => {
    render(
      <ViewSwitcher
        compactOnMobile
        options={[
          { value: "grid", label: "Grid", icon: Grid2X2 },
          { value: "list", label: "List", icon: List },
        ]}
        value="grid"
        onValueChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Grid view" })).toBeVisible();
    expect(screen.getByText("Grid")).toHaveClass("max-md:sr-only");
    expect(screen.getByText("List")).toHaveClass("max-md:sr-only");
  });
});
