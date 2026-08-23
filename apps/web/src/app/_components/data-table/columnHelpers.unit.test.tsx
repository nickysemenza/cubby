import { flexRender, type RowData, useTable } from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useMemo } from "react";
import { describe, expect, it, vi } from "vitest";
import { provisionalOptions } from "~/app/finance/financial-account-options";
import { booleanCellOptions } from "~/lib/select-options";
import { formatCurrency } from "~/lib/utils";
import {
  createActionsColumn,
  createBooleanColumn,
  createCurrencyColumn,
  createFilterableSelectColumn,
  createImageColumn,
  createNameColumn,
  createParentLinkColumn,
  describeProductPricingSource,
  productPriceClearLabel,
  renderProductPriceValue,
} from "./columnHelpers";
import { EditableCell } from "./editable-cell";
import {
  type CubbyColumnDef as ColumnDef,
  createCubbyColumnHelper,
  cubbyTableFeatures,
  useCubbyTable,
} from "./table-features";

/**
 * The thumbnail itself pulls in the hover-preview popup and the CF image
 * transform helpers — none of which this suite is asking about. Stubbing it to
 * a bare count keeps the assertion on the one thing `createImageColumn` owns:
 * WHICH images reach the cell.
 */
vi.mock("~/app/_components/table/ImageThumbnail", () => ({
  ImageThumbnail: ({ images }: { images: unknown[] }) => (
    <span data-testid="thumb">{images.length}</span>
  ),
}));

/**
 * `EntityInlineLink` renders through `EntityPreviewLink`, which is a TanStack
 * `Link` plus a lazily-fetched hovercard — both need a router and a query
 * client this test has no interest in. Stubbing that one leaf keeps the real
 * `EntityInlineLink` (and its per-entity `match`) in the render path while
 * encoding the two things this column is responsible for — the target entity
 * and the id — into an href we can assert on.
 */
vi.mock("~/app/_components/EntityPreviewLink", () => ({
  dottedEntityLink: "",
  EntityPreviewLink: ({
    entity,
    id,
    children,
  }: {
    entity: string;
    id: string;
    children: ReactNode;
  }) => <a href={`/${entity}/${id}`}>{children}</a>,
}));

vi.mock("~/app/projects/project-mark", () => ({
  ProjectMarkById: () => <span aria-hidden="true">project</span>,
}));

const clipboardMocks = vi.hoisted(() => ({ copyShortcodes: vi.fn() }));
vi.mock("~/lib/clipboard", () => ({
  copyShortcodes: clipboardMocks.copyShortcodes,
}));

/**
 * The actions menu is a base-ui portal that only mounts its items once opened.
 * Flattening the primitives renders those items inline, which keeps the
 * assertion on what `createActionsColumnBase` decides — which items exist, and
 * with what payload — rather than on base-ui's open/close machinery.
 */
vi.mock("~/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    render,
  }: {
    children: ReactNode;
    onClick?: () => void;
    render?: { props: { to: string; params: Record<string, string> } };
  }) =>
    render ? (
      <a href={`${render.props.to}:${Object.values(render.props.params)[0]}`}>
        {children}
      </a>
    ) : (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
}));

type ParentValue = { id: string | null; name: string | null };

type TaskRow = {
  parentTaskId: string | null;
  parentTaskName: string | null;
};

type ProjectRow = {
  parentId: string | null;
  parentName: string | null;
};

/**
 * Renders the column through a real table so the accessor and the cell are
 * exercised the way `<RTable>` runs them — a hand-built `info.getValue()` would
 * test the cell body while silently accepting a wrong `idField`/`nameField`.
 */
function renderColumn<TRow extends RowData, TValue = ParentValue>(
  column: ColumnDef<TRow, TValue>,
  row: TRow,
) {
  function Harness() {
    const table = useTable({
      features: cubbyTableFeatures,
      data: [row],
      columns: [column] as unknown as ColumnDef<TRow, unknown>[],
    });
    const cell = table.getRowModel().rows[0]?.getVisibleCells()[0];
    if (!cell) throw new Error("expected one row with one cell");
    return (
      <table>
        <tbody>
          <tr>
            <td>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
          </tr>
        </tbody>
      </table>
    );
  }
  return render(<Harness />);
}

const taskColumn = (
  options?: Parameters<typeof createParentLinkColumn>[4],
): ColumnDef<TaskRow, ParentValue> =>
  createParentLinkColumn(
    createCubbyColumnHelper<TaskRow>(),
    "task",
    "parentTaskId",
    "parentTaskName",
    options,
  );

const projectColumn = (): ColumnDef<ProjectRow, ParentValue> =>
  createParentLinkColumn(
    createCubbyColumnHelper<ProjectRow>(),
    "project",
    "parentId",
    "parentName",
  );

describe("createParentLinkColumn", () => {
  it("links the parent through the column's own entity and id", () => {
    renderColumn(taskColumn(), {
      parentTaskId: "TSK-9QP2",
      parentTaskName: "Frame the shed",
    });

    const link = screen.getByRole("link", { name: /Frame the shed/ });
    // The entity half of the href is what stops a task column from pointing at
    // /project/… — the two call sites differ only in that argument.
    expect(link).toHaveAttribute("href", "/task/TSK-9QP2");
    expect(screen.getByText("Frame the shed")).toBeInTheDocument();
  });

  it("reads the id and name off the fields it was given", () => {
    renderColumn(projectColumn(), {
      parentId: "PRJ-4K7M",
      parentName: "Backyard",
    });

    expect(screen.getByRole("link", { name: /Backyard/ })).toHaveAttribute(
      "href",
      "/project/PRJ-4K7M",
    );
  });

  it.each([
    ["both missing", { parentTaskId: null, parentTaskName: null }],
    ["id missing", { parentTaskId: null, parentTaskName: "Frame the shed" }],
    // A name with no id is the one that matters: it reads as linkable but has
    // nothing to link to, so the guard has to be on both halves, not just the
    // name it would otherwise render.
    ["name missing", { parentTaskId: "TSK-9QP2", parentTaskName: null }],
  ])("renders NoneValue when %s", (_label, row: TaskRow) => {
    renderColumn(taskColumn(), row);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("defaults id, header, and width per entity", () => {
    const task = taskColumn();
    expect(task.id).toBe("parentTask");
    expect(task.header).toBe("Parent Task");
    expect(task.meta?.className).toBe("w-40");
    // Reparenting is not offered through this column at any call site.
    expect(task.enableSorting).toBe(false);

    // A project's parent is another project, so "Parent Task" would be wrong
    // and the shorter "Parent" reads correctly in the WBS tree.
    const project = projectColumn();
    expect(project.id).toBe("parent");
    expect(project.header).toBe("Parent");
  });

  it("lets options override the id, header, and width", () => {
    const column = taskColumn({
      id: "wbsParent",
      header: "Rolls Up To",
      className: "w-64",
    });

    expect(column.id).toBe("wbsParent");
    expect(column.header).toBe("Rolls Up To");
    expect(column.meta?.className).toBe("w-64");
  });
});

type TreeNameRow = {
  id: string;
  name: string;
  subRows?: TreeNameRow[];
};

const treeNameColumns = [
  createNameColumn(createCubbyColumnHelper<TreeNameRow>(), "product", "name", {
    expandable: true,
    rowLink: () => null,
  }) as ColumnDef<TreeNameRow, unknown>,
];

function TreeNameHarness() {
  const table = useCubbyTable({
    data: [
      { id: "PRD-PLAIN", name: "Standalone product" },
      {
        id: "PRD-KIT",
        name: "Expandable kit",
        subRows: [{ id: "PRD-PART", name: "Nested component" }],
      },
    ],
    columns: treeNameColumns,
    getRowId: (row) => row.id,
    getSubRows: (row) => row.subRows,
    initialState: { expanded: true },
  });

  return (
    <table>
      <tbody>
        {table.getRowModel().rows.map((row) => {
          const cell = row.getVisibleCells()[0];
          if (!cell) throw new Error("expected a name cell");
          return (
            <tr key={row.id}>
              <td data-row-id={row.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

describe("createNameColumn expandable layout", () => {
  it("starts top-level leaves at the cell edge and reserves the lane only for nested leaves", () => {
    const { container } = render(<TreeNameHarness />);
    const spacerSelector = "span.size-6.shrink-0";

    expect(
      container
        .querySelector('[data-row-id="PRD-PLAIN"]')
        ?.querySelector(spacerSelector),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-row-id="PRD-PART"]')
        ?.querySelector(spacerSelector),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Collapse" }),
    ).toBeInTheDocument();
  });
});

type ImageRowFixture = { id: string };

type ImagesByRowId = Record<
  string,
  Array<{ id: string; url: string; filename?: string }>
>;

/** Same reference on every render — the table must not rebuild its row model. */
const IMAGE_ROWS: ImageRowFixture[] = [{ id: "PRJ-1" }];

/**
 * One long-lived table whose `data` never changes while `getImages` does —
 * exactly the shape of a list that hydrates its thumbnails from a SECOND query
 * (projects fetch theirs via `image.imagesByProjectIds`).
 */
function ImageHarness({ images }: { images: ImagesByRowId }) {
  const column = useMemo(
    () =>
      createImageColumn(createCubbyColumnHelper<ImageRowFixture>(), {
        entity: "project",
        getImages: (row) => images[row.id] ?? [],
      }) as ColumnDef<ImageRowFixture, unknown>,
    [images],
  );
  const table = useTable({
    features: cubbyTableFeatures,
    data: IMAGE_ROWS,
    columns: useMemo(() => [column], [column]),
  });
  const cell = table.getRowModel().rows[0]?.getVisibleCells()[0];
  if (!cell) throw new Error("expected one row with one cell");
  return (
    <table>
      <tbody>
        <tr>
          <td>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
        </tr>
      </tbody>
    </table>
  );
}

describe("createImageColumn", () => {
  it("shows images that arrive after the first render", () => {
    // Mount empty, the way a list renders before its images query resolves.
    const { rerender } = render(<ImageHarness images={{}} />);
    expect(screen.getByTestId("thumb")).toHaveTextContent("0");

    // The query resolves: a NEW column def carries a fresh `getImages`, but
    // `data` is unchanged. TanStack rebuilds its core row model only on `data`,
    // so `row._valuesCache.image` still holds the empty array from above — the
    // cell must therefore read `row.original`, not `info.getValue()`, or every
    // thumbnail stays frozen at the placeholder forever.
    rerender(
      <ImageHarness
        images={{
          "PRJ-1": [{ id: "img-1", url: "https://example.com/a.png" }],
        }}
      />,
    );
    expect(screen.getByTestId("thumb")).toHaveTextContent("1");
  });

  it("keeps PDFs out of the default row-embedded thumbnails", () => {
    const column = createImageColumn(
      createCubbyColumnHelper<{ id: string; images: unknown[] }>(),
      { entity: "product" },
    ) as ColumnDef<{ id: string; images: unknown[] }, unknown>;

    function PdfHarness() {
      const table = useTable({
        features: cubbyTableFeatures,
        data: [
          {
            id: "PRD-1",
            images: [
              {
                id: "doc",
                url: "https://example.com/manual.pdf",
                filename: "manual.pdf",
                contentType: "application/pdf",
              },
              {
                id: "photo",
                url: "https://example.com/photo.png",
                filename: "photo.png",
                contentType: "image/png",
              },
            ],
          },
        ],
        columns: [column],
      });
      const cell = table.getRowModel().rows[0]?.getVisibleCells()[0];
      if (!cell) throw new Error("expected one row with one cell");
      return (
        <table>
          <tbody>
            <tr>
              <td>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            </tr>
          </tbody>
        </table>
      );
    }

    render(<PdfHarness />);
    expect(screen.getByTestId("thumb")).toHaveTextContent("1");
  });
});

describe("createActionsColumn", () => {
  interface ActionRow {
    id: string;
  }

  const actionsColumn = (entity: "product" | "image") =>
    createActionsColumn(
      createCubbyColumnHelper<ActionRow>(),
      entity,
    ) as ColumnDef<ActionRow, unknown>;

  it("offers the row's own code, and copies exactly that", () => {
    renderColumn<ActionRow, unknown>(actionsColumn("product"), {
      id: "PRD-4K7M",
    });

    fireEvent.click(screen.getByRole("button", { name: /Copy PRD-4K7M/ }));

    expect(clipboardMocks.copyShortcodes).toHaveBeenCalledWith(["PRD-4K7M"]);
  });

  // `image` used to be the one entity routed by uuid, so this asserted that its
  // row offered no copy item — a uuid must never reach the clipboard as if it
  // were a public code. Images carry `IMG-` codes now and route on them like
  // every other entity, so the copy item is CORRECT here; the case that needed
  // suppressing no longer exists.
  it("offers the copy item for an image, which is shortcode-routed like the rest", () => {
    renderColumn<ActionRow, unknown>(actionsColumn("image"), {
      id: "IMG-4K7M",
    });

    expect(screen.getByRole("link", { name: /View details/ })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Copy IMG-4K7M/ }));

    expect(clipboardMocks.copyShortcodes).toHaveBeenCalledWith(["IMG-4K7M"]);
  });
});

type MoneyRow = { amount: number | null };

const moneyColumn = (): ColumnDef<MoneyRow, number | null> =>
  createCurrencyColumn(createCubbyColumnHelper<MoneyRow>(), "amount");

describe("createCurrencyColumn", () => {
  it("carries the fully formatted value in a title attribute", () => {
    renderColumn(moneyColumn(), { amount: -999999.99 });

    const formatted = formatCurrency(-999999.99);
    expect(screen.getByTitle(formatted)).toHaveTextContent(formatted);
  });

  it("omits the title for an empty cell", () => {
    renderColumn(moneyColumn(), { amount: null });

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(document.querySelector("[title]")).toBeNull();
  });
});

// The unknown-marker is a single glyph with no accessible name, so these assert
// on text content: "—" present means the cell claimed "we do not know".
const DASH = "—";

type TrackedRow = { stockTracked: boolean | null };

const TRACKED_OPTIONS = booleanCellOptions({
  true: "Tracked",
  false: "Not tracked",
});

const trackedColumn = (
  onSave?: (v: boolean | null, row: TrackedRow) => Promise<void>,
): ColumnDef<TrackedRow, string | null> =>
  createBooleanColumn(createCubbyColumnHelper<TrackedRow>(), "stockTracked", {
    trueFalseOptions: TRACKED_OPTIONS,
    undecided: { label: "Undecided" },
    ...(onSave ? { editable: { onSave } } : {}),
  }) as ColumnDef<TrackedRow, string | null>;

describe("createBooleanColumn", () => {
  // The bug this factory exists to prevent: `false` is a decision somebody
  // recorded, and it used to render as nothing (expense `future`) or as bare
  // text indistinguishable from the undecided case.
  it("renders all three states distinctly, and false is not the dash", () => {
    const { unmount } = renderColumn<TrackedRow, string | null>(
      trackedColumn(),
      { stockTracked: false },
    );
    expect(screen.getByText("Not tracked")).toBeVisible();
    expect(screen.queryByText(DASH)).toBeNull();
    unmount();

    const second = renderColumn<TrackedRow, string | null>(trackedColumn(), {
      stockTracked: true,
    });
    expect(screen.getByText("Tracked")).toBeVisible();
    expect(screen.queryByText(DASH)).toBeNull();
    second.unmount();

    // null is the ONE case the dash is correct for — undecided really is unknown.
    renderColumn<TrackedRow, string | null>(trackedColumn(), {
      stockTracked: null,
    });
    expect(screen.getByText(DASH)).toBeVisible();
    expect(screen.queryByText(/tracked/i)).toBeNull();
  });

  // `stockTracked: false` reading back as `null` is a bug this codebase has
  // already shipped once (see server/mcp/tools/product.tools.ts), so the
  // string encoding the editor round-trips through is pinned here.
  it("round-trips false through the string encoding without collapsing to null", async () => {
    const saved: (boolean | null)[] = [];
    const onSave = async (v: boolean | null) => {
      saved.push(v);
    };

    renderColumn<TrackedRow, string | null>(trackedColumn(onSave), {
      stockTracked: null,
    });

    const cellData = trackedColumn(onSave).meta?.cellData;
    if (!cellData?.applyPaste) throw new Error("expected a pasteable column");

    // Paste accepts the human label as well as the encoded value — that is what
    // makes a copied "Not tracked" land in another boolean column.
    await cellData.applyPaste({ stockTracked: null }, { text: "Not tracked" });
    await cellData.applyPaste({ stockTracked: null }, { json: "true" });

    expect(saved).toEqual([false, true]);
  });

  it("copies the label, and copies nothing when undecided", () => {
    const cellData = trackedColumn().meta?.cellData;
    if (!cellData) throw new Error("expected cellData");

    expect(cellData.getCopyPayload({ stockTracked: false })).toEqual({
      text: "Not tracked",
      json: "false",
    });
    // Nothing to copy beats copying the word "Undecided" — an empty TSV field
    // is what an unknown value means to the range engine.
    expect(cellData.getCopyPayload({ stockTracked: null })).toBeNull();
  });

  it("only offers the clear affordance when an undecided state is named", () => {
    const boolColumn = (undecided?: { label: string }) =>
      createBooleanColumn(
        createCubbyColumnHelper<TrackedRow>(),
        "stockTracked",
        {
          trueFalseOptions: TRACKED_OPTIONS,
          ...(undecided ? { undecided } : {}),
          editable: { onSave: async () => {} },
        },
      ) as ColumnDef<TrackedRow, string | null>;

    // Asserted through the rendered editor rather than the config object: the
    // config is internal, the clear button is the behaviour. The picker names it
    // after the undecided label, so clearing reads as a state rather than an ✗.
    const withUndecided = renderColumn<TrackedRow, string | null>(
      boolColumn({ label: "Undecided" }),
      { stockTracked: true },
    );
    fireEvent.click(screen.getByText("Tracked"));
    // Presence, not visibility: the editor renders through a body portal, which
    // jsdom reports as not visible regardless of the real layout.
    expect(
      screen.getByRole("button", { name: /Clear Undecided/i }),
    ).toBeInTheDocument();
    withUndecided.unmount();

    // Without a named undecided state there is nothing valid to clear TO — the
    // field's schema may not accept null at all.
    renderColumn<TrackedRow, string | null>(boolColumn(), {
      stockTracked: true,
    });
    fireEvent.click(screen.getByText("Tracked"));
    expect(screen.queryByRole("button", { name: /^Clear/i })).toBeNull();
  });
});

describe("createCurrencyColumn zero handling", () => {
  // The reported bug: a $0 warranty replacement rendered as the unknown-marker
  // while the column footer summed the same row as 0. `Expense.cost` books a
  // gifted or broken item as 0 and reserves NULL for "unclassified", so the two
  // must not share a rendering.
  it("renders a real zero as $0.00 and reserves the dash for null", () => {
    const { unmount } = renderColumn<MoneyRow, number | null>(moneyColumn(), {
      amount: 0,
    });
    expect(screen.getByText(formatCurrency(0))).toBeVisible();
    expect(screen.queryByText(DASH)).toBeNull();
    unmount();

    renderColumn<MoneyRow, number | null>(moneyColumn(), { amount: null });
    expect(screen.getByText(DASH)).toBeVisible();
  });

  it("still suppresses zero when a column opts in explicitly", () => {
    const opted = createCurrencyColumn(
      createCubbyColumnHelper<MoneyRow>(),
      "amount",
      { zeroAsEmpty: true },
    );
    renderColumn<MoneyRow, number | null>(
      opted as ColumnDef<MoneyRow, number | null>,
      { amount: 0 },
    );
    expect(screen.getByText(DASH)).toBeVisible();
  });
});

// Range copy/paste reads `meta.cellData`, never the rendered cell — so a column
// that renders correctly can still be silently absent from the copy range. That
// is exactly what happened when two `createTextColumn` enum columns were
// hand-rolled into bare accessors to get the new dot+label render (PR #766
// review): the cells looked right and dropped out of the range engine.
describe("enum/boolean columns stay in the copy/paste range", () => {
  type EnumRow = { kind: string | null };
  const OPTIONS = [{ value: "purchase", label: "Purchase" }];

  it("createFilterableSelectColumn wires cellData even with no filter and no editor", () => {
    const column = createFilterableSelectColumn(
      createCubbyColumnHelper<EnumRow>(),
      "kind",
      {
        placeholder: "Filter by kind...",
        selectOptions: OPTIONS,
        // The shape the financial-transaction columns use: the manifest owns the
        // filter control, and the column is read-only.
        filterConfig: null,
      },
    );

    const cellData = column.meta?.cellData;
    expect(cellData?.kind).toBe("select");
    // Copy carries the human label, not the raw enum the old text column emitted.
    expect(cellData?.getCopyPayload({ kind: "purchase" })).toEqual({
      text: "Purchase",
      json: "purchase",
    });
    // Read-only: no editor means no paste target, same as before the conversion.
    expect(cellData?.applyPaste).toBeUndefined();
    // `filterConfig: null` must leave meta.filterConfig undefined so the
    // manifest's control is the one that attaches.
    expect(column.meta?.filterConfig).toBeUndefined();
  });
});

// The factory used to hardcode `true → positive / false → slate`, which is only
// right when "true" is the good outcome. `FinancialAccount.provisional` is the
// inverse — provisional is the UNRESOLVED state — so the list cell rendered it
// green while its own detail page rendered it amber, and a deliberately-amber
// "Planned" expense silently went green (PR #766 review). The roster is now the
// single source of both label and tone.
describe("boolean tones come from the roster, not the factory", () => {
  type ProvisionalRow = { provisional: boolean | null };

  it("honours an inverted tone map and matches what other surfaces render", () => {
    const column = createBooleanColumn(
      createCubbyColumnHelper<ProvisionalRow>(),
      "provisional",
      { trueFalseOptions: provisionalOptions },
    ) as ColumnDef<ProvisionalRow, string | null>;

    // The dot the table cell paints must be the same ink the detail page's
    // `renderOptionCell(…, provisionalOptions)` paints for the same value.
    const inkFor = (value: string) =>
      provisionalOptions.find((o) => o.value === value)?.color;
    expect(inkFor("true")).toBe("var(--warning)");
    expect(inkFor("false")).toBe("var(--positive)");

    renderColumn<ProvisionalRow, string | null>(column, { provisional: true });
    const dot = document.querySelector("td span[aria-hidden]");
    expect(dot).not.toBeNull();
    expect((dot as HTMLElement).style.backgroundColor).toBe("var(--warning)");
  });
});

// `Product.price`'s EditableCell edits the manual override but displays
// `pricing.effectivePrice` (override OR the Expense-derived fallback), so an
// override and a derived price render as the same bare number with nothing
// telling them apart. `renderProductPriceValue` / `describeProductPricingSource`
// / `productPriceClearLabel` are the shared fix — both the product detail page
// and the product list column call the same three functions, so the two
// surfaces cannot disagree about what the cell means.
describe("Product pricing cell (explicit vs derived legibility)", () => {
  const explicitPricing = {
    effectivePrice: 20,
    derivedPrice: 12,
    source: "explicit" as const,
    knownExpenseCount: 3,
    partial: false,
  };
  const derivedPricing = {
    effectivePrice: 12,
    derivedPrice: 12,
    source: "derived" as const,
    knownExpenseCount: 3,
    partial: false,
  };
  const nonePricing = {
    effectivePrice: null,
    derivedPrice: null,
    source: "none" as const,
    knownExpenseCount: 0,
    partial: false,
  };

  it("describes each pricing source in prose, shared by the caption and the cell tooltip", () => {
    expect(describeProductPricingSource(explicitPricing)).toBe(
      "Manual override",
    );
    expect(describeProductPricingSource(derivedPricing)).toBe(
      "Derived from 3 expenses",
    );
    expect(
      describeProductPricingSource({ ...derivedPricing, partial: true }),
    ).toBe("Derived from 3 expenses · partial history");
    expect(describeProductPricingSource(nonePricing)).toBe(
      "No override or quantified purchase history",
    );
  });

  it("renders an explicit override and a derived price with different glyphs, not just the same bare number", () => {
    const { unmount } = render(
      <div>{renderProductPriceValue(explicitPricing)}</div>,
    );
    expect(screen.getByText("$20.00")).toBeInTheDocument();
    expect(document.querySelector("svg.lucide-pin")).not.toBeNull();
    expect(document.querySelector("svg.lucide-sigma")).toBeNull();
    unmount();

    render(<div>{renderProductPriceValue(derivedPricing)}</div>);
    expect(screen.getByText("$12.00")).toBeInTheDocument();
    expect(document.querySelector("svg.lucide-sigma")).not.toBeNull();
    expect(document.querySelector("svg.lucide-pin")).toBeNull();
  });

  it("renders the muted dash when there is no price at all", () => {
    render(<div>{renderProductPriceValue(nonePricing)}</div>);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("names the derived fallback when clearing has one to return to, and says so plainly when it doesn't", () => {
    expect(productPriceClearLabel({ derivedPrice: 12 })).toBe(
      "Revert to $12.00 (derived)",
    );
    expect(productPriceClearLabel({ derivedPrice: null })).toBe(
      "Clear override (no derived price on record)",
    );
  });

  // The bug this cell rework fixes: the display showed `pricing.effectivePrice`
  // (override OR derived) while the editor seeded from the raw `value`
  // (override only) — so a derived-only product showed a real number, but
  // opening it landed on a blank box with nothing on the cell explaining why.
  // The glyph now tells the reader it's derived *before* they click; the blank
  // box on open is then legible ("nothing WAS overridden") instead of looking
  // like a lost value.
  it("a derived-only product's cell shows the derived cue, and its editor opens blank — the raw stored override, not the displayed fallback", async () => {
    render(
      <EditableCell
        value={null}
        onSave={vi.fn().mockResolvedValue(undefined)}
        config={{ type: "currency" }}
        renderValue={() => renderProductPriceValue(derivedPricing)}
      />,
    );

    expect(screen.getByText("$12.00")).toBeInTheDocument();
    expect(document.querySelector("svg.lucide-sigma")).not.toBeNull();

    fireEvent.click(screen.getByRole("button"));
    const input = await screen.findByRole("spinbutton");
    expect(input).toHaveValue(null);
  });
});
