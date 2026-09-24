import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EntityOverrideTable } from "./EntityOverrideTable";

describe("EntityOverrideTable", () => {
  it("filters comparisons and opens each row independently", () => {
    render(<EntityOverrideTable />);
    fireEvent.change(screen.getByLabelText("Search entity, path, or value"), {
      target: { value: "relationFilterOverrides" },
    });
    const summaries = screen.getAllByText(
      "presentation.detail.relationFilterOverrides",
    );
    expect(summaries.length).toBeGreaterThan(1);
    const first = summaries[0]!.closest("details");
    const second = summaries[1]!.closest("details");
    expect(first).not.toHaveAttribute("open");
    expect(second).not.toHaveAttribute("open");
    fireEvent.click(
      within(first!).getByText("presentation.detail.relationFilterOverrides"),
    );
    expect(first).toHaveAttribute("open");
    expect(second).not.toHaveAttribute("open");
    fireEvent.click(
      within(first!).getByText("presentation.detail.relationFilterOverrides"),
    );
    expect(first).not.toHaveAttribute("open");
  });
});
