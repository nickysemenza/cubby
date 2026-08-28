import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PhotoPassLoadError } from "./PhotoPassWorkbench";

describe("PhotoPassLoadError", () => {
  it("names a failed fetch and lets the operator retry without changing scope", () => {
    const onRetry = vi.fn();

    render(
      <PhotoPassLoadError
        title="Couldn't load this photo pass"
        detail="Connection lost."
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load this photo pass",
    );
    expect(screen.getByText("Connection lost.")).toBeVisible();
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveClass("min-h-12", "md:min-h-10");

    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
