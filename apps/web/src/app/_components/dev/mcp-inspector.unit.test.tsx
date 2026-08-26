import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CatalogErrorState } from "./mcp-inspector";

describe("CatalogErrorState", () => {
  it("keeps catalog failure actionable", () => {
    const onRetry = vi.fn();
    render(
      <CatalogErrorState message="catalog unavailable" onRetry={onRetry} />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Failed to load MCP catalog: catalog unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry catalog" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
