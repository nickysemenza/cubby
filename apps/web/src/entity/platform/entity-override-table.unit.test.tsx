import { allEntities } from "@cubby/schemas/entity-manifest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { EntityOverrideTable } from "./entity-override-table";
import { overridesFor } from "./entity-schema-model";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => harness.dispose());

function records(table: HTMLElement) {
  return [
    ...table.querySelectorAll<HTMLTableRowElement>("tr.table-record-row"),
  ];
}

describe("EntityOverrideTable", () => {
  it("filters comparisons through shared search and RFilters, preserving evidence and opening the owner", async () => {
    const onSelectEntity = vi.fn();
    render(<EntityOverrideTable onSelectEntity={onSelectEntity} />, {
      wrapper: harness.wrapper,
    });
    const table = await screen.findByRole("table", {
      name: "Declaration overrides",
    });
    fireEvent.change(
      await screen.findByPlaceholderText("Search entity, path, or value"),
      { target: { value: "relationFilterOverrides" } },
    );
    await waitFor(() => {
      expect(records(table).length).toBeGreaterThan(1);
      for (const row of records(table))
        expect(
          within(row).getByText("presentation.detail.relationFilterOverrides"),
        ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await screen.findByRole("button", { name: "Outcome" }));
    const required = await screen.findByRole("option", { name: /Required/ });
    fireEvent.pointerDown(required);
    fireEvent.click(required);
    await waitFor(() => {
      expect(records(table).length).toBeGreaterThan(0);
      for (const row of records(table))
        expect(within(row).getByText("Required")).toBeInTheDocument();
    });
    const row = records(table)[0]!;
    const cells = within(row).getAllByRole("cell");
    const owner = allEntities.find(
      (entity) => entity === cells[0]?.textContent,
    );
    if (!owner) throw new Error("Override owner is missing");
    const comparison = overridesFor(owner).find(
      (entry) => entry.path === "presentation.detail.relationFilterOverrides",
    );
    if (!comparison) throw new Error("Override comparison is missing");
    expect(cells[2]?.textContent).toBe(comparison.declared);
    expect(cells[3]?.textContent).toBe(
      comparison.without ?? comparison.reason ?? "No valid value",
    );
    fireEvent.click(row);
    expect(onSelectEntity).toHaveBeenCalledWith(owner);
  });
});
