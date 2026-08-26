import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CalendarRangeError } from "./unified-calendar";

describe("CalendarRangeError", () => {
  it("explains the unavailable range and offers a thumb-sized retry", () => {
    const onRetry = vi.fn();

    render(<CalendarRangeError onRetry={onRetry} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The calendar could not be loaded",
    );
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveClass("h-11");

    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
