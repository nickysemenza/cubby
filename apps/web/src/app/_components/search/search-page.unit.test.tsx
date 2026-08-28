import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { getSearchResultsFeedback, SearchResultsFeedback } from "./search-page";

describe("search result recovery", () => {
  it("prioritizes request failure over an empty result set", () => {
    expect(
      getSearchResultsFeedback({
        isLoading: false,
        error: new Error("search unavailable"),
        resultCount: 0,
      }),
    ).toBe("error");
  });

  it("offers the same retry action in the phone projection", () => {
    const onRetry = vi.fn();
    render(<SearchResultsFeedback state="error" onRetry={onRetry} mobile />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Search could not load.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
