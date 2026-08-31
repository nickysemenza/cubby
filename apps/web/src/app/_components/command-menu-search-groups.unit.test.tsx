import {
  type SearchDestination,
  searchResultGroupSchema,
} from "@cubby/schemas/search";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { Command } from "cmdk";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandGroup, CommandList } from "~/components/ui/command";

import { SearchGroupItem } from "./command-menu";

const productId = testShortcode("product", "PRD-SRCH");
const inventoryId = testShortcode("inventory", "INV-SRCH");
const locationId = testShortcode("location", "LOC-SRCH");
const expenseId = testShortcode("expense", "EXP-SRCH");
const componentProductId = testShortcode("product", "PRD-COMP");
const componentInventoryId = testShortcode("inventory", "INV-COMP");

const group = searchResultGroupSchema.parse({
  kind: "product",
  key: "product:fixture",
  primary: {
    id: productId,
    entityType: "product",
    title: "Relational Drill",
    subtitle: "Fixture Tools",
    typeHint: "hardware",
    imageUrl: null,
  },
  bestMatch: {
    id: productId,
    entityType: "product",
    title: "Relational Drill",
    subtitle: "Fixture Tools",
    typeHint: "hardware",
    imageUrl: null,
    matchKind: "exact",
    matchField: "title",
    matchReason: "Exact title match",
    matchTerms: ["relational", "drill"],
  },
  placements: [
    {
      id: inventoryId,
      locationId,
      locationPath: "Garage › Tool shelf",
      amount: { value: 1, unit: "each" },
      placement: "stock",
    },
  ],
  componentPlacements: [
    {
      component: {
        id: componentProductId,
        entityType: "product",
        title: "Relational Drill Battery",
        subtitle: "Fixture Tools",
        typeHint: "hardware",
        imageUrl: null,
      },
      componentQuantity: 2,
      placement: {
        id: componentInventoryId,
        locationId,
        locationPath: "Garage › Battery shelf",
        amount: { value: 2, unit: "each" },
        placement: "stock",
      },
    },
  ],
  matchedActivity: [
    {
      id: expenseId,
      entityType: "expense",
      title: "Relational Drill purchase",
      subtitle: null,
      typeHint: "materials",
      imageUrl: null,
      matchKind: "prefix",
      matchField: "title",
      matchReason: "Title prefix match",
      matchTerms: ["relational", "drill"],
    },
  ],
});

function Harness({
  onSelect,
}: {
  onSelect: (item: SearchDestination) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Command>
      <CommandList>
        <CommandGroup>
          <SearchGroupItem
            expanded={expanded}
            group={group}
            isDevtoolsVisible={false}
            onSeeAll={() => undefined}
            onSelect={onSelect}
            onToggle={(next) => setExpanded(next ?? !expanded)}
          />
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

describe("command search Product families", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    vi.unstubAllGlobals();
  });

  it("expands with arrow keys and keeps Inventory as a direct destination", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);

    const product = screen.getByRole("option", { name: /Relational Drill/ });
    expect(product).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(product, { key: "ArrowRight" });
    expect(product).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Garage › Tool shelf")).toBeInTheDocument();
    expect(screen.getByText("Relational Drill Battery")).toBeInTheDocument();
    expect(screen.getByText(/2× kit content/)).toBeInTheDocument();
    expect(screen.getByText("Relational Drill purchase")).toBeInTheDocument();

    const placement = screen
      .getAllByRole("option")
      .find((option) => option.dataset.value === `placement-${inventoryId}`);
    expect(placement).toBeDefined();
    fireEvent.click(placement!);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: inventoryId, entityType: "inventory" }),
    );

    const componentPlacement = screen
      .getAllByRole("option")
      .find(
        (option) =>
          option.dataset.value ===
          `component-placement-${componentInventoryId}`,
      );
    expect(componentPlacement).toBeDefined();
    fireEvent.click(componentPlacement!);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: componentInventoryId,
        entityType: "inventory",
        title: "Relational Drill Battery",
      }),
    );

    fireEvent.keyDown(product, { key: "ArrowLeft" });
    expect(product).toHaveAttribute("aria-expanded", "false");
  });

  it("offers a separate pointer disclosure target", () => {
    render(<Harness onSelect={vi.fn()} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand Relational Drill placements and matching records",
      }),
    );
    expect(
      screen.getByRole("button", {
        name: "Collapse Relational Drill placements and matching records",
      }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});
