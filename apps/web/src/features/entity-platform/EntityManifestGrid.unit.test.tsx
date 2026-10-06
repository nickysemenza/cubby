import { allEntities } from "@cubby/schemas/entity-manifest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { overridesFor } from "./entity-schema-model";
import { EntityManifestGrid } from "./EntityManifestGrid";
import { SavedViewChips } from "./EntitySchemaInspector";

// The grid reads live row counts and the panel renders router links; render
// with `active={false}` inside a memory router so no query ever fires.
let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

function renderGrid(
  props: Partial<Parameters<typeof EntityManifestGrid>[0]> = {},
) {
  const all = {
    selected: null,
    onSelect: vi.fn(),
    onSheetChange: vi.fn(),
    ...props,
  };
  const view = render(<EntityManifestGrid {...all} active={false} />, {
    wrapper: harness.wrapper,
  });
  return { ...view, ...all };
}

function sheet() {
  return screen.getByRole("table", { name: "Entity schema" });
}

function entityRow(entity: string) {
  const button = within(sheet()).getByRole("button", { name: entity });
  const row = button.closest("tr");
  if (!row) throw new Error(`row missing for ${entity}`);
  return row;
}

function panel(entity: string) {
  return screen.getByRole("region", { name: `${entity} schema` });
}

describe("SavedViewChips", () => {
  it("renders ordinary and problem-backed views in manifest order", () => {
    render(<SavedViewChips entity="product" />);

    const firstBadge = screen.getByText("Shelf disagrees");
    const problemBadge = screen.getByText("Stocked but unpriced");

    expect(firstBadge.compareDocumentPosition(problemBadge)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("renders a dash when an entity declares no saved views", () => {
    render(<SavedViewChips entity="device" />);

    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("EntityManifestGrid schema sheet", () => {
  it("renders one row per declared entity", () => {
    renderGrid();

    // Header rows plus one row per entity.
    expect(within(sheet()).getAllByRole("row")).toHaveLength(
      allEntities.length + 2,
    );
  });

  it.each([
    ["recipe", { create: "yes", read: "yes", update: "yes", delete: "yes" }],
    ["run", { create: "no", read: "yes", update: "no", delete: "no" }],
    ["image", { create: "no", read: "yes", update: "yes", delete: "yes" }],
  ] as const)("splits %s kernel actions into CRUD cells", (entity, slots) => {
    renderGrid();

    const row = entityRow(entity);
    for (const [slot, value] of Object.entries(slots))
      expect(within(row).getByTitle(`${slot}: ${value}`)).toBeInTheDocument();
  });

  it("sorts numeric columns largest first, then smallest, then back to declaration order", () => {
    renderGrid();
    const header = within(sheet()).getByRole("button", { name: "Ovr" });
    const firstEntity = () =>
      within(within(sheet()).getAllByRole("row")[2]!).getAllByRole("button")[0]!
        .textContent;
    const byOverrides = [...allEntities].sort(
      (left, right) => overridesFor(left).length - overridesFor(right).length,
    );

    fireEvent.click(header);
    expect(header.closest("th")).toHaveAttribute("aria-sort", "descending");
    expect(firstEntity()).toBe(byOverrides.at(-1));

    fireEvent.click(header);
    expect(header.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(firstEntity()).toBe(byOverrides[0]);

    fireEvent.click(header);
    expect(header.closest("th")).not.toHaveAttribute("aria-sort");
    expect(firstEntity()).toBe(allEntities[0]);
  });

  it("selects a row into the side panel instead of expanding it inline", () => {
    const onSelect = vi.fn();
    const { rerender } = renderGrid({ onSelect });

    expect(screen.queryByRole("region", { name: /schema$/ })).toBeNull();
    fireEvent.click(within(entityRow("product")).getByRole("button"));
    expect(onSelect).toHaveBeenLastCalledWith("product");

    rerender(
      <EntityManifestGrid
        selected="product"
        onSelect={onSelect}
        onSheetChange={vi.fn()}
        active={false}
      />,
    );
    const productPanel = panel("product");
    expect(within(productPanel).getByText("Storage table")).toBeInTheDocument();
    expect(
      within(productPanel).getAllByText(
        "presentation.detail.relationFilterOverrides",
      )[0],
    ).toBeInTheDocument();
    expect(
      within(productPanel).getByRole("link", { name: "Open schema page" }),
    ).toHaveAttribute("href", "/entities/schema/product");
    expect(entityRow("product")).toHaveAttribute("aria-current", "true");

    // Clicking the selected row again, the close button, or Escape clears it.
    fireEvent.click(within(entityRow("product")).getByRole("button"));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    onSelect.mockClear();
    fireEvent.click(
      within(productPanel).getByRole("button", { name: "Close panel" }),
    );
    expect(onSelect).toHaveBeenLastCalledWith(null);
    onSelect.mockClear();
    fireEvent.keyDown(within(entityRow("recipe")).getByRole("button"), {
      key: "Escape",
    });
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("closes the panel with Escape from inside it and returns focus to the row", () => {
    const { onSelect } = renderGrid({ selected: "product" });
    const close = within(panel("product")).getByRole("button", {
      name: "Close panel",
    });
    close.focus();

    fireEvent.keyDown(close, { key: "Escape" });

    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(within(entityRow("product")).getByRole("button")).toHaveFocus();
  });

  it("sorts the lifecycle Delete column independently of the CRUD D column", () => {
    renderGrid();
    const lifecycle = within(sheet()).getByRole("button", { name: "Delete" });
    const crud = within(sheet()).getByRole("button", { name: "D" });

    fireEvent.click(lifecycle);

    expect(lifecycle.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(crud.closest("th")).not.toHaveAttribute("aria-sort");
    // Text sorts A→Z, so entities without a delete mode ("") lead.
    const firstRow = within(sheet()).getAllByRole("row")[2]!;
    expect(within(firstRow).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("moves the open panel with the arrow keys", () => {
    const { onSelect } = renderGrid({ selected: "product" });
    const productButton = within(entityRow("product")).getByRole("button");
    productButton.focus();

    fireEvent.keyDown(productButton, { key: "ArrowDown" });

    const next = allEntities[allEntities.indexOf("product") + 1]!;
    expect(onSelect).toHaveBeenLastCalledWith(next);
    expect(within(entityRow(next)).getByRole("button")).toHaveFocus();
  });

  it("navigates the panel to a relation target", () => {
    const { onSelect } = renderGrid({ selected: "wish" });

    const row = within(panel("wish")).getByText("candidates").closest("tr")!;
    const target = within(row).getByRole("button");
    fireEvent.click(target);

    expect(onSelect).toHaveBeenLastCalledWith(target.textContent);
  });
});

describe("EntityManifestGrid panel relations", () => {
  it("marks wish's `candidates` relation omitted with its reason", () => {
    renderGrid({ selected: "wish" });

    const row = within(panel("wish")).getByText("candidates").closest("tr")!;
    expect(within(row).getByText("omitted")).toHaveAttribute(
      "title",
      "The Candidate alternatives section edits candidates in place with its own renderer.",
    );
  });

  it("marks task's compiler-derived `plantings` relation as derived", () => {
    renderGrid({ selected: "task" });

    const row = within(panel("task")).getByText("plantings").closest("tr")!;
    expect(within(row).getByText("derived")).toBeInTheDocument();
  });

  it("marks vendor.runs derived now that Run reads the kernel list", () => {
    renderGrid({ selected: "vendor" });

    const row = within(panel("vendor"))
      .getByText("runs", { exact: true })
      .closest("tr")!;
    expect(within(row).getByText("derived")).toBeInTheDocument();
  });

  it.each([["product", "images", "image"]] as const)(
    "shows %s.%s as a custom list when %s has a separate list source",
    (entity, relation, target) => {
      renderGrid({ selected: entity });

      const row = within(panel(entity))
        .getByText(relation, { exact: true })
        .closest("tr")!;
      expect(within(row).getByRole("button", { name: target })).toBeVisible();
      expect(within(row).getByText("custom list")).toHaveAttribute(
        "title",
        `${target} has a list page, but its list cannot be used as an inline relation table.`,
      );
    },
  );
});

describe("EntityManifestGrid sheets", () => {
  it("opens an entity from the relations matrix on the entities sheet", () => {
    const { onSelect, onSheetChange } = renderGrid({ sheet: "relations" });

    expect(screen.getByText("explicitly omitted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "PRD" }));

    expect(onSheetChange).toHaveBeenLastCalledWith("entities");
    expect(onSelect).toHaveBeenLastCalledWith("product");
  });
});
