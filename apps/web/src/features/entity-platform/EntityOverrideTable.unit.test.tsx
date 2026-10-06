import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EntityOverrideTable } from "./EntityOverrideTable";

describe("EntityOverrideTable", () => {
  it("filters comparisons and opens the owning entity", () => {
    const onSelectEntity = vi.fn();
    render(<EntityOverrideTable onSelectEntity={onSelectEntity} />);
    const table = screen.getByRole("table", { name: "Declaration overrides" });
    const allRows = within(table).getAllByRole("row").length;

    fireEvent.change(screen.getByLabelText("Search entity, path, or value"), {
      target: { value: "relationFilterOverrides" },
    });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThan(allRows - 1);
    for (const row of rows)
      expect(
        within(row).getByText("presentation.detail.relationFilterOverrides"),
      ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Outcome"), {
      target: { value: "invalid" },
    });
    const invalid = within(table).getAllByRole("row").slice(1);
    for (const row of invalid)
      expect(within(row).getByText("Invalid default")).toBeInTheDocument();

    const firstEntity = within(invalid[0]!).getAllByRole("button")[0]!;
    fireEvent.click(firstEntity);
    expect(onSelectEntity).toHaveBeenCalledWith(firstEntity.textContent);
  });
});
