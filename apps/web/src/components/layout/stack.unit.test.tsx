import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Stack } from "./stack";

/**
 * `space-y-*` alone (the old base class) only sets `margin-top` on non-first
 * children — inline elements ignore vertical margin, so two `<span>`s render
 * concatenated on one line with no separator. This is what silently broke
 * every saved-view description in DataTableViews. `flex flex-col` blockifies
 * children, which is the part that actually forces the line break; `gap`
 * still spaces them via `space-y-*` margins on the now-block children.
 */
describe("Stack blockifies inline children", () => {
  it("renders two inline spans as separate flex-column items, not one run-together line", () => {
    render(
      <Stack gap="tight">
        <span>Products in stock</span>
        <span>All items currently in inventory</span>
      </Stack>,
    );

    const first = screen.getByText("Products in stock");
    const second = screen.getByText("All items currently in inventory");

    // Same container, and that container is a flex column — the mechanism
    // that blockifies the two spans instead of leaving them inline.
    expect(first.parentElement).toBe(second.parentElement);
    expect(first.parentElement).toHaveClass("flex", "flex-col");
  });
});
