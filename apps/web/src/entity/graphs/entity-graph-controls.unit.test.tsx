import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  GraphData,
  GraphFilters,
} from "../../ui/visualizations/dependency-graph-model";
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

function openPicker(name: string) {
  const control = screen.getByRole("combobox", { name });
  control.focus();
  fireEvent.keyDown(control, { key: "ArrowDown" });
  return control;
}

function pick(option: string | RegExp) {
  // A real click starts on the option; choose-mode pickers ignore a click
  // whose pointer went down on the trigger.
  const item = screen.getByRole("option", { name: option });
  fireEvent.pointerDown(item);
  fireEvent.click(item);
}

function choose(name: string, option: string) {
  openPicker(name);
  pick(option);
}

afterEach(() => {
  cleanup();
  onChange.mockClear();
});

describe("EntityGraphControls", () => {
  it("can scope unassigned work and restore all locations", () => {
    render(<ControlsHarness />);
    choose("Location", "No location");
    expect(onChange).toHaveBeenLastCalledWith({
      location: "",
      focus: undefined,
    });
    choose("Location", "All locations");
    expect(onChange).toHaveBeenLastCalledWith({
      location: undefined,
      focus: undefined,
    });
  });

  it("switches work grouping between location, hierarchy, and none", () => {
    render(<ControlsHarness />);
    for (const [value, label] of [
      ["location", "Location"],
      ["both", "Location & hierarchy"],
      ["none", "None"],
      ["hierarchy", "Hierarchy"],
    ] as const) {
      choose("Group by", label);
      expect(onChange).toHaveBeenLastCalledWith({
        grouped: value === "hierarchy" || value === "both",
        groupByLocation: value === "location" || value === "both",
      });
    }
  });

  it("filters focus choices and emits work-specific graph filters", () => {
    render(<ControlsHarness />);

    openPicker("Focus record");
    expect(
      screen.getByRole("option", { name: /Kitchen refresh/ }),
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Focus record" }), {
      key: "Escape",
    });

    fireEvent.change(
      screen.getByRole("textbox", { name: "Find graph record" }),
      {
        target: { value: "tsk-cd34" },
      },
    );

    openPicker("Focus record");
    expect(
      screen.queryByRole("option", { name: /Kitchen refresh/ }),
    ).not.toBeInTheDocument();
    // Record codes stay searchable but are never shown.
    expect(screen.queryByText(/TSK-CD34/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Write proposal/ }));
    choose("Dependency direction", "Blockers");
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
    openPicker("Dependency direction");
    expect(
      screen.getByRole("option", { name: "Blocked work" }),
    ).toBeInTheDocument();
  });

  it("uses recipe-specific relationship labels", () => {
    render(<ControlsHarness recipes />);
    openPicker("Dependency direction");

    expect(
      screen.getByRole("option", { name: "Recipes using this" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Used recipes" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Hide unconnected recipes" }),
    ).toBeChecked();
  });
});
