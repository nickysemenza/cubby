import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InventorySessionLoadError } from "./InventorySessionWorkbench";

describe("InventorySessionLoadError", () => {
  it("blocks an incomplete recount behind an accessible retry action", () => {
    const onRetry = vi.fn();

    render(
      <InventorySessionLoadError
        title="Couldn't load inventory for Garage"
        detail="Connection lost."
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load inventory for Garage",
    );
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveClass("min-h-12", "md:min-h-10");

    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
