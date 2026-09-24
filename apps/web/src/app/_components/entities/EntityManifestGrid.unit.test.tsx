import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { EntityManifestGrid, SavedViewChips } from "./EntityManifestGrid";

// jsdom has no ResizeObserver; the bottom "Reference graph" section
// (`EntityReferenceGraph` → `useContainerDimensions`) needs one to mount.
class TestResizeObserver {
  observe() {
    // no-op: the reference graph falls back to its initial dimensions.
  }
  unobserve() {
    // no-op
  }
  disconnect() {
    // no-op
  }
}
global.ResizeObserver ??= TestResizeObserver;

/** `EntityManifestGrid` reads the live-row-count query via `useQuery`; these
 * tests render with `active={false}` so it never fires, but the hook still
 * needs a `QueryClient` in context to mount at all. */
function renderGrid(props: Parameters<typeof EntityManifestGrid>[0]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  return render(<EntityManifestGrid {...props} active={false} />, {
    wrapper: Wrapper,
  });
}

describe("SavedViewChips", () => {
  it("renders ordinary and problem-backed views in manifest order", () => {
    render(<SavedViewChips entity="product" />);

    const firstBadge = screen.getByText("Shelf disagrees");
    const problemBadge = screen.getByText("Stocked but unpriced");

    expect(firstBadge.compareDocumentPosition(problemBadge)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(firstBadge).toBeInTheDocument();
    expect(problemBadge).toBeInTheDocument();
  });

  it("renders a dash when an entity declares no saved views", () => {
    render(<SavedViewChips entity="vendor" />);

    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

function noop() {
  // EntityManifestGrid's onSelect fires on row click; these tests only read
  // the rendered mega table, so the callback itself is never asserted on.
}

/**
 * The mobile `EntityIndex` nav (hidden at `md:` breakpoint via CSS, which
 * jsdom doesn't evaluate) renders every entity name as a `<button>` too, so a
 * bare `getByText(entity)` is ambiguous. The mega table's own entity cell is
 * the first `<td>`-descendant match in document order — the sub-row (if the
 * entity is selected) can repeat the same word in a `target` column, but it
 * renders after the entity's own row.
 */
function findEntityRow(entityName: string) {
  const cell = screen
    .getAllByText(entityName)
    .find((el) => el.closest("td") !== null);
  if (!cell) throw new Error(`entity row cell not found for ${entityName}`);
  const row = cell.closest("tr");
  if (!row) throw new Error(`entity row not found for ${entityName}`);
  return row;
}

describe("EntityManifestGrid mega table: kernel action condensation", () => {
  it("renders the full CRUD word (muted) for an entity with get/list/create/update/delete", () => {
    // `recipe` declares get, list, search, create, update, delete —
    // all four CRUD slots present, so it condenses to the bare word.
    renderGrid({ selected: "recipe", onSelect: noop });

    const row = findEntityRow("recipe");
    expect(within(row).getByText("CRUD")).toBeInTheDocument();
    // `search` isn't one of the four CRUD slots, so it renders as an extra.
    expect(within(row).getByText("+search")).toBeInTheDocument();
  });

  it("renders a fixed-position letter mask for an entity missing some CRUD actions", () => {
    // `importRun` declares only get and list — read-only, no create/update/delete.
    renderGrid({ selected: "importRun", onSelect: noop });

    const row = findEntityRow("importRun");
    expect(within(row).getByText("·R··")).toBeInTheDocument();
  });

  it("keeps the mask fixed-position for an entity missing only create", () => {
    // `image` declares get, list, search, update, delete — no create.
    renderGrid({ selected: "image", onSelect: noop });

    const row = findEntityRow("image");
    expect(within(row).getByText("·RUD")).toBeInTheDocument();
  });
});

describe("EntityManifestGrid mega table: relations sub-row", () => {
  it("exposes wish's omitted `candidates` relation and its reason", () => {
    renderGrid({ selected: "wish", onSelect: noop });

    // The selected row's relations sub-table is always expanded inline.
    expect(screen.getByText("candidates")).toBeInTheDocument();
    const reasonCell = screen.getByText(
      "The Candidate alternatives section edits candidates in place with its own renderer.",
    );
    expect(reasonCell).toBeInTheDocument();
  });

  it("marks task's compiler-derived `plantings` relation as derived, not declared", () => {
    renderGrid({ selected: "task", onSelect: noop });

    const plantingsRow = screen.getByText("plantings").closest("tr");
    if (plantingsRow === null)
      throw new Error("plantings relation row not found");
    // Both the relationship-level origin and the detail-table status read
    // "derived" for this row (the compiler generated the section).
    expect(within(plantingsRow).getAllByText("derived").length).toBeGreaterThan(
      0,
    );
  });
});

describe("EntityManifestGrid mega table: baseline rendering", () => {
  it("renders one row per declared entity plus the relations matrix", () => {
    renderGrid({ selected: "product", onSelect: noop });

    expect(screen.getByText("Relations matrix")).toBeInTheDocument();
    // Spot-check a handful of entities across the roster render as rows.
    for (const entity of ["product", "recipe", "vendor", "financialAccount"]) {
      expect(screen.getAllByText(entity).length).toBeGreaterThan(0);
    }
  });

  it("starts collapsed and lets the selected entity close or another entity open", () => {
    const onSelect = vi.fn();
    const { rerender } = renderGrid({ selected: null, onSelect });
    const product = within(findEntityRow("product")).getByRole("button");
    const recipe = within(findEntityRow("recipe")).getByRole("button");

    expect(product).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Declaration overrides")).not.toBeInTheDocument();
    fireEvent.click(product);
    expect(onSelect).toHaveBeenLastCalledWith("product");

    rerender(
      <EntityManifestGrid
        selected="product"
        onSelect={onSelect}
        active={false}
      />,
    );
    expect(product).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Declaration overrides")).toBeInTheDocument();
    expect(screen.getByText("Effective behavior")).toBeInTheDocument();
    expect(screen.getByText("Storage table")).toBeInTheDocument();
    expect(
      screen.getByText("presentation.detail.sectionOverrides"),
    ).toBeInTheDocument();
    fireEvent.click(product);
    expect(onSelect).toHaveBeenLastCalledWith(null);

    rerender(
      <EntityManifestGrid selected={null} onSelect={onSelect} active={false} />,
    );
    fireEvent.click(recipe);
    expect(onSelect).toHaveBeenLastCalledWith("recipe");
  });
});
