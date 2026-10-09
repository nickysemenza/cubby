import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ScopeChip } from "./ScopeChip";

describe("ScopeChip", () => {
  it("surfaces an invalid entity filter with its clear action", () => {
    const onClear = vi.fn();
    render(
      <ScopeChip
        name="Product"
        value={UNRESOLVABLE_ENTITY_FILTER}
        onClear={onClear}
      />,
    );

    expect(screen.getByText("Invalid link filter")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Clear Product scope" }),
    );
    expect(onClear).toHaveBeenCalledOnce();
  });
});
