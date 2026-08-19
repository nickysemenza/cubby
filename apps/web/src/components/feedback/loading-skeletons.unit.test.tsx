import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DashboardSectionLoading,
  DetailSpecPlateLoading,
  ListLoadingSkeleton,
} from "./loading-skeletons";

describe("ListLoadingSkeleton", () => {
  it("uses a table-shaped loading surface without duplicating the page title", () => {
    render(<ListLoadingSkeleton />);

    const loadingList = screen.getByRole("status", {
      name: "Loading records…",
    });
    expect(loadingList).toHaveAttribute("aria-busy", "true");
    expect(loadingList).toHaveClass("border", "bg-card");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("exposes meaningful status labels for detail and dashboard shapes", () => {
    const { rerender } = render(
      <DetailSpecPlateLoading label="Loading PRD-123 details…" />,
    );
    expect(
      screen.getByRole("status", { name: "Loading PRD-123 details…" }),
    ).toBeInTheDocument();

    rerender(<DashboardSectionLoading label="Loading project work…" />);
    expect(
      screen.getByRole("status", { name: "Loading project work…" }),
    ).toBeInTheDocument();
  });
});
