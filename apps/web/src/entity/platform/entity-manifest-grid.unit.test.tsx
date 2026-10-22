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

import { EntityManifestGrid } from "./entity-manifest-grid";
import { SavedViewChips } from "./entity-schema-inspector";
import { overridesFor } from "./entity-schema-model";

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

function recordRows() {
  return [
    ...sheet().querySelectorAll<HTMLTableRowElement>("tr.table-record-row"),
  ];
}

async function entityRow(entity: string) {
  fireEvent.change(
    await screen.findByPlaceholderText("Search entities and declarations"),
    {
      target: { value: entity },
    },
  );
  return waitFor(() => {
    const row = within(sheet())
      .getByText(entity, { exact: true })
      .closest("tr.table-record-row");
    if (!(row instanceof HTMLTableRowElement))
      throw new Error(`row missing for ${entity}`);
    return row;
  });
}

function panel(entity: string) {
  return screen.findByRole("complementary", { name: `${entity} schema` });
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
  it.each([
    ["recipe", { create: "yes", read: "yes", update: "yes", delete: "yes" }],
    ["run", { create: "no", read: "yes", update: "no", delete: "no" }],
    ["image", { create: "no", read: "yes", update: "yes", delete: "yes" }],
  ] as const)(
    "splits %s kernel actions into CRUD cells",
    async (entity, slots) => {
      renderGrid();

      const row = await entityRow(entity);
      for (const [slot, value] of Object.entries(slots))
        expect(within(row).getByTitle(`${slot}: ${value}`)).toBeInTheDocument();
    },
  );

  it("sorts numeric columns largest first, then smallest, then back to declaration order", async () => {
    renderGrid();
    const header = await screen.findByRole("button", {
      name: "Sort by Declaration overrides",
    });
    const firstEntity = () =>
      recordRows()[0]
        ?.querySelector("td")
        ?.textContent?.replace("external", "")
        .trim();
    await waitFor(() => expect(recordRows().length).toBeGreaterThan(0));
    const descendingByOverrides = [...allEntities].sort(
      (left, right) => overridesFor(right).length - overridesFor(left).length,
    );
    const ascendingByOverrides = [...allEntities].sort(
      (left, right) => overridesFor(left).length - overridesFor(right).length,
    );

    fireEvent.click(header);
    expect(header.closest("th")).toHaveAttribute("aria-sort", "descending");
    await waitFor(() => expect(firstEntity()).toBe(descendingByOverrides[0]));

    fireEvent.click(header);
    expect(header.closest("th")).toHaveAttribute("aria-sort", "ascending");
    await waitFor(() => expect(firstEntity()).toBe(ascendingByOverrides[0]));

    fireEvent.click(header);
    expect(header.closest("th")).toHaveAttribute("aria-sort", "none");
    await waitFor(() => expect(firstEntity()).toBe(allEntities[0]));
  });

  it("inspects a searched row with shared panel metadata and close controls", async () => {
    const onSelect = vi.fn();
    const { rerender } = renderGrid({ onSelect });
    const row = await entityRow("product");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenLastCalledWith("product");

    rerender(
      <EntityManifestGrid
        selected="product"
        onSelect={onSelect}
        onSheetChange={vi.fn()}
        active={false}
      />,
    );
    const productPanel = await panel("product");
    expect(within(productPanel).getByText("Storage table")).toBeInTheDocument();
    expect(
      within(productPanel).getAllByText(
        "presentation.detail.relationFilterOverrides",
      )[0],
    ).toBeInTheDocument();
    expect(
      within(productPanel).getByRole("link", { name: "Open schema page" }),
    ).toHaveAttribute("href", "/entities/schema/product");
    expect(row).toHaveAttribute("aria-current", "true");
    fireEvent.click(
      within(productPanel).getByRole("button", { name: "Close panel" }),
    );
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("closes the standard inspector with Escape from inside it", async () => {
    const { onSelect } = renderGrid({ selected: "product" });
    const close = within(await panel("product")).getByRole("button", {
      name: "Close panel",
    });
    close.focus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("sorts the lifecycle Delete column independently of the CRUD D column", async () => {
    renderGrid();
    const lifecycle = await screen.findByRole("button", {
      name: "Sort by Surfaces · Delete",
    });
    const crud = within(sheet()).getByRole("button", {
      name: "Sort by delete",
    });

    fireEvent.click(lifecycle);

    expect(lifecycle.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(crud.closest("th")).toHaveAttribute("aria-sort", "none");
    // Text sorts A→Z, so entities without a delete mode ("") lead.
    await waitFor(() => expect(recordRows().length).toBeGreaterThan(0));
    const firstRow = recordRows()[0]!;
    expect(within(firstRow).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("steps the open panel with J/K across the full row model", async () => {
    const index = allEntities.length - 2;
    const selected = allEntities[index]!;
    const { onSelect } = renderGrid({ selected });
    const close = within(await panel(selected)).getByRole("button", {
      name: "Close panel",
    });
    close.focus();
    fireEvent.keyDown(close, { key: "j" });
    expect(onSelect).toHaveBeenLastCalledWith(allEntities[index + 1]);
    fireEvent.keyDown(close, { key: "k" });
    expect(onSelect).toHaveBeenLastCalledWith(allEntities[index - 1]);
  });

  it("navigates the panel to a relation target", async () => {
    const { onSelect } = renderGrid({ selected: "wish" });

    const row = within(await panel("wish"))
      .getByText("candidates")
      .closest("tr")!;
    const target = within(row).getByRole("button");
    fireEvent.click(target);

    expect(onSelect).toHaveBeenLastCalledWith(target.textContent);
  });
});

describe("EntityManifestGrid panel relations", () => {
  it("marks wish's `candidates` relation omitted with its reason", async () => {
    renderGrid({ selected: "wish" });

    const row = within(await panel("wish"))
      .getByText("candidates")
      .closest("tr")!;
    expect(within(row).getByText("omitted")).toHaveAttribute(
      "title",
      "The Candidate alternatives section edits candidates in place with its own renderer.",
    );
  });

  it("marks task's compiler-derived `plantings` relation as derived", async () => {
    renderGrid({ selected: "task" });

    const row = within(await panel("task"))
      .getByText("plantings")
      .closest("tr")!;
    expect(within(row).getByText("derived")).toBeInTheDocument();
  });

  it.each([["product", "images", "image"]] as const)(
    "shows %s.%s as a custom list when %s has a separate list source",
    async (entity, relation, target) => {
      renderGrid({ selected: entity });

      const row = within(await panel(entity))
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
