import { act, fireEvent, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createCubbyColumnHelper, useCubbyTable } from "./table-features";
import TableHeaderLayout from "./TableHeaderLayout";

interface TestRow {
  id: string;
  name: string;
}

const helper = createCubbyColumnHelper<TestRow>();
const columns = helper.columns([
  helper.display({
    id: "select",
    header: "Select",
    meta: { entityColumnRole: "selection" },
  }),
  helper.display({
    id: "image",
    header: "Image",
    meta: { entityColumnRole: "image" },
  }),
  helper.accessor("name", {
    id: "nutrient-301",
    header: "Calcium (mg)",
    size: 180,
    minSize: 80,
    maxSize: 400,
    meta: {
      provenance: {
        kind: "derived",
        sources: [
          {
            entity: "financialTransaction",
            label: null,
            relation: "financial-transactions",
          },
        ],
      },
    },
  }),
  helper.display({
    id: "actions",
    header: "Actions",
    meta: { entityColumnRole: "action" },
  }),
]);

let lastTable: ReturnType<typeof useCubbyTable<TestRow>> | undefined;

function nutrientResizeHandle() {
  const header = screen
    .getByRole("button", { name: "Reorder nutrient-301 column" })
    .closest("th");
  const handle = header?.querySelector(
    '[title="Drag to resize · double-click to reset"]',
  );
  if (!(handle instanceof HTMLElement))
    throw new Error("missing resize handle");
  return handle;
}

function Harness() {
  const table = useCubbyTable({
    data: [{ id: "row-a", name: "Alpha" }],
    columns,
    getRowId: (row) => row.id,
  });
  lastTable = table;
  return (
    <table>
      <thead>
        <TableHeaderLayout
          table={table}
          styles={{ header: "", sortIcon: "" }}
          isDebugEnabled={false}
        />
      </thead>
    </table>
  );
}

describe("TableHeaderLayout", () => {
  it("does not render reorder grips for the locked structural columns", () => {
    render(<Harness />);

    expect(
      screen.queryByRole("button", { name: "Reorder select column" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reorder image column" }),
    ).not.toBeInTheDocument();
    // Locked to the trailing edge — the row-actions menu is not the user's to
    // move, so it gets no grip either.
    expect(
      screen.queryByRole("button", { name: "Reorder actions column" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reorder nutrient-301 column" }),
    ).toBeInTheDocument();
  });

  it("hydrates the reorder grips with the server's aria-describedby id", async () => {
    // dnd-kit's default DndDescribedBy id comes from a module counter that
    // advances differently across the server and client passes.
    const container = document.createElement("div");
    container.innerHTML = renderToString(<Harness />);
    document.body.append(container);
    const serverDescribedBy = container
      .querySelector('[aria-label="Reorder nutrient-301 column"]')
      ?.getAttribute("aria-describedby");
    expect(serverDescribedBy).toMatch(/^DndDescribedBy-/);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const root = await act(async () => hydrateRoot(container, <Harness />));
    try {
      expect(
        consoleError.mock.calls.filter(([message]) =>
          String(message).includes("hydrat"),
        ),
      ).toEqual([]);
      expect(
        container
          .querySelector('[aria-label="Reorder nutrient-301 column"]')
          ?.getAttribute("aria-describedby"),
      ).toBe(serverDescribedBy);
    } finally {
      consoleError.mockRestore();
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("shows provenance without replacing the sortable header label", () => {
    render(<Harness />);

    expect(
      screen.getByRole("note", { name: "From Transactions" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Sort by Calcium (mg)" }),
    ).toHaveTextContent("Calcium (mg)");
  });

  it("commits a native mouse resize without starting column ordering", () => {
    render(<Harness />);
    const handle = nutrientResizeHandle();
    const orderBefore = lastTable?.state.columnOrder;

    fireEvent.mouseDown(handle, { clientX: 180 });
    fireEvent.mouseMove(document, { clientX: 240 });
    fireEvent.mouseUp(document, { clientX: 240 });

    expect(lastTable?.getColumn("nutrient-301")?.getSize()).toBe(240);
    expect(lastTable?.state.columnOrder).toEqual(orderBefore);
    expect(
      screen.getByRole("button", { name: "Reorder nutrient-301 column" }),
    ).toBeInTheDocument();
  });

  it("supports touch resize and double-click reset", () => {
    render(<Harness />);
    const handle = nutrientResizeHandle();

    fireEvent.touchStart(handle, { touches: [{ clientX: 180 }] });
    fireEvent.touchMove(document, { touches: [{ clientX: 220 }] });
    fireEvent.touchEnd(document, { touches: [{ clientX: 220 }] });
    expect(lastTable?.getColumn("nutrient-301")?.getSize()).toBe(220);

    fireEvent.doubleClick(handle);
    expect(lastTable?.getColumn("nutrient-301")?.getSize()).toBe(180);
  });
});
