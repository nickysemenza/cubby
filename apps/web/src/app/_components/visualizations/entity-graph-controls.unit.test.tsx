import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GraphData, GraphFilters } from "./dependency-graph-model";
import { EntityGraphControls } from "./entity-graph-controls";

const data: GraphData = {
  nodes: [
    {
      id: "PRJ-AB12",
      name: "Kitchen refresh",
      metadata: [],
      href: "/projects/PRJ-AB12",
    },
    {
      id: "TSK-CD34",
      name: "Write proposal",
      metadata: [],
      href: "/tasks/TSK-CD34",
    },
  ],
  edges: [],
};

const filters: GraphFilters = {
  direction: "all",
  grouped: true,
  hideCompleted: true,
  hideUnconnected: true,
  reduceEdges: false,
};

const onChange = vi.fn();

function ControlsHarness({ recipes = false }: { recipes?: boolean }) {
  const [search, setSearch] = useState("");
  return (
    <EntityGraphControls
      data={data}
      filters={filters}
      onChange={onChange}
      recipes={recipes}
      search={search}
      onSearch={setSearch}
    />
  );
}

afterEach(() => {
  cleanup();
  onChange.mockClear();
});

describe("EntityGraphControls", () => {
  it("filters focus choices and emits work-specific graph filters", () => {
    render(<ControlsHarness />);

    const focus = screen.getByRole("combobox", { name: "Focus record" });
    expect(
      screen.getByRole("option", { name: /Kitchen refresh/ }),
    ).toBeVisible();

    fireEvent.change(
      screen.getByRole("textbox", { name: "Find graph record" }),
      {
        target: { value: "tsk-cd34" },
      },
    );

    expect(
      screen.getByRole("option", { name: "Write proposal (TSK-CD34)" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /Kitchen refresh/ }),
    ).not.toBeInTheDocument();

    fireEvent.change(focus, { target: { value: "TSK-CD34" } });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Dependency direction" }),
      { target: { value: "upstream" } },
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Hide completed work" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Hide redundant dependency edges",
      }),
    );

    expect(onChange).toHaveBeenNthCalledWith(1, { focus: "TSK-CD34" });
    expect(onChange).toHaveBeenNthCalledWith(2, { direction: "upstream" });
    expect(onChange).toHaveBeenNthCalledWith(3, { hideCompleted: false });
    expect(onChange).toHaveBeenNthCalledWith(4, { reduceEdges: true });
    expect(screen.getByRole("option", { name: "Blockers" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Blocked work" })).toBeVisible();
  });

  it("uses recipe-specific relationship labels", () => {
    render(<ControlsHarness recipes />);

    expect(
      screen.getByRole("option", { name: "Recipes using this" }),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: "Used recipes" })).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Hide unconnected recipes" }),
    ).toBeChecked();
  });
});
