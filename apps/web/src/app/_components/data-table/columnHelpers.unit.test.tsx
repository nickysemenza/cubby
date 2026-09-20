import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import { testShortcode } from "@cubby/schemas/testing";
import { flexRender, type RowData, useTable } from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { provisionalOptions } from "~/app/finance/financial-account-options";
import { booleanCellOptions } from "~/lib/select-options";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { formatCurrency } from "~/lib/utils";

import { EntityActionsProvider } from "../actions/entity-actions";
import {
  createActionsColumn,
  createBooleanColumn,
  createCurrencyColumn,
  createEntityInlineLinkColumn,
  createFilterableSelectColumn,
  createImageColumn,
  createNameColumn,
  createParentLinkColumn,
  createSingleEntityInlineLinkColumn,
  describeProductPricingSource,
  productPriceClearLabel,
  renderProductPriceValue,
  rowImages,
} from "./columnHelpers";
import { EditableCell } from "./editable-cell";
import {
  type CubbyColumnDef as ColumnDef,
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  cubbyTableFeatures,
  materializeCubbyColumns,
  useCubbyTable,
} from "./table-features";

type ParentValue = { id: string | null; name: string | null };

const activeBrowserHarnesses: Array<
  ReturnType<typeof createBrowserTestHarness>
> = [];

afterEach(() => {
  for (const harness of activeBrowserHarnesses) harness.dispose();
  activeBrowserHarnesses.length = 0;
});

function columnForTable<TRow extends RowData, TValue>(
  column: ColumnDef<TRow, TValue>,
): ColumnDef<TRow, unknown>[] {
  return materializeCubbyColumns(
    createCubbyColumnCollection<TRow>((add) => add(column)),
  );
}

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
  wrap?: (children: ReactNode) => ReactNode,
  options?: { browser?: boolean },
) {
  function Harness() {
    const table = useTable<typeof cubbyTableFeatures, TRow>({
      features: cubbyTableFeatures,
      data: [row],
      columns: columnForTable(column),
    });
    const cell = table.getRowModel().rows[0]?.getVisibleCells()[0];
    if (!cell) throw new Error("expected one row with one cell");
    const markup = (
      <table>
        <tbody>
          <tr>
            <td>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
          </tr>
        </tbody>
      </table>
    );
    return wrap?.(markup) ?? markup;
  }
  if (!options?.browser) return render(<Harness />);
  const browserHarness = createBrowserTestHarness();
  activeBrowserHarnesses.push(browserHarness);
  const result = render(
    <browserHarness.wrapper>
      <Harness />
    </browserHarness.wrapper>,
  );
  return result;
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
  it("links the parent through the column's own entity and id", async () => {
    renderColumn(
      taskColumn(),
      {
        parentTaskId: "TSK-9QP2",
        parentTaskName: "Frame the shed",
      },
      undefined,
      { browser: true },
    );

    const link = await screen.findByRole("link", { name: /Frame the shed/ });
    expect(link).toHaveAttribute("href", "/tasks/TSK-9QP2");
    expect(screen.getByText("Frame the shed")).toBeInTheDocument();
  });

  it("reads the id and name off the fields it was given", async () => {
    renderColumn(
      projectColumn(),
      {
        parentId: "PRJ-4K7M",
        parentName: "Backyard",
      },
      undefined,
      { browser: true },
    );

    expect(
      await screen.findByRole("link", { name: /Backyard/ }),
    ).toHaveAttribute("href", "/projects/PRJ-4K7M");
  });

  it.each([
    ["both missing", { parentTaskId: null, parentTaskName: null }],
    ["id missing", { parentTaskId: null, parentTaskName: "Frame the shed" }],
    // A name with no id is the one that matters: it reads as linkable but has
    // nothing to link to, so the guard has to be on both halves, not just the
    // name it would otherwise render.
    ["name missing", { parentTaskId: "TSK-9QP2", parentTaskName: null }],
  ])("renders NoneValue when %s", async (_label, row: TaskRow) => {
    renderColumn(taskColumn(), row, undefined, { browser: true });

    expect(await screen.findByText("—")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("defaults id, header, and width per entity", () => {
    const task = taskColumn();
    expect(task.id).toBe("parentTask");
    expect(task.header).toBe("Parent Task");
    expect(task.meta?.className).toBe("w-40");
    expect(task.enableSorting).toBe(false);

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

describe("createSingleEntityInlineLinkColumn", () => {
  it("always supplies a semantic entity header unless the caller names one", () => {
    const helper = createCubbyColumnHelper<{ location: never }>();
    const location = createSingleEntityInlineLinkColumn(
      helper,
      "location",
      "location",
    );
    const renamed = createSingleEntityInlineLinkColumn(
      helper,
      "location",
      "location",
      { header: "Stored at" },
    );

    expect(location.header).toBe("Location");
    expect(renamed.header).toBe("Stored at");
  });

  type ProductRelationRow = {
    product: { id: string; name: string; manufacturer: string } | null;
  };

  const productColumn = (editable?: {
    onSave: (id: string | null) => Promise<void>;
  }) =>
    createSingleEntityInlineLinkColumn(
      createCubbyColumnHelper<ProductRelationRow>(),
      "product",
      "product",
      editable
        ? { editable: { onSave: (id) => editable.onSave(id) } }
        : undefined,
    );

  const productRow: ProductRelationRow = {
    product: {
      id: "PRD-2ABC",
      name: "Workbench light",
      manufacturer: "Makita",
    },
  };

  it("uses one adapter for the visible link and ID-only clipboard payload", async () => {
    const onSave = vi.fn(async (_id: string | null) => {});
    const column = productColumn({ onSave });
    const cellData = column.meta?.cellData;
    if (!cellData?.applyPaste) throw new Error("expected a pasteable relation");

    renderColumn(column, productRow, undefined, { browser: true });
    expect(
      await screen.findByRole("link", { name: /Workbench light/ }),
    ).toHaveAttribute("href", "/products/PRD-2ABC");
    expect(cellData.getCopyPayload(productRow)).toEqual({
      text: "Workbench light",
      json: { id: "PRD-2ABC", name: "Workbench light" },
    });

    await cellData.applyPaste(productRow, {
      json: { id: "PRD-3ABC", name: "Replacement light" },
    });
    expect(onSave).toHaveBeenCalledWith("PRD-3ABC");
  });

  it("renders the explicit empty marker for a malformed singular projection", () => {
    const malformed: ProductRelationRow = {
      product: {
        id: "PRD-2ABC",
        name: "Workbench light",
        manufacturer: "Makita",
      },
    };
    // External projections are runtime data. Break the required product field
    // after construction to cover the same malformed response a Zod boundary
    // can deliver without weakening the static fixture type.
    if (!malformed.product) throw new Error("expected a product projection");
    Object.assign(malformed.product, { manufacturer: null });

    renderColumn(productColumn(), malformed);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("createEntityInlineLinkColumn", () => {
  type ProductCollectionRow = {
    products: Array<{ id: string; name: string; manufacturer: string }>;
  };

  const productCollectionColumn = () =>
    createEntityInlineLinkColumn(
      createCubbyColumnHelper<ProductCollectionRow>(),
      "products",
      "product",
      { dedupe: true },
    );

  it("publishes collection refs for table-owned image batching", () => {
    const row: ProductCollectionRow = {
      products: [
        { id: "PRD-2ABC", name: "Workbench light", manufacturer: "Makita" },
        { id: "PRD-3ABC", name: "Task light", manufacturer: "DeWalt" },
      ],
    };

    expect(productCollectionColumn().meta?.entityRefs?.(row)).toEqual([
      { entityType: "product", entityId: "PRD-2ABC" },
      { entityType: "product", entityId: "PRD-3ABC" },
    ]);
  });

  it("keeps malformed collection projections strict", () => {
    const malformed: ProductCollectionRow = {
      products: [
        { id: "PRD-2ABC", name: "Workbench light", manufacturer: "Makita" },
      ],
    };
    Object.assign(malformed.products[0]!, { manufacturer: null });

    expect(() => renderColumn(productCollectionColumn(), malformed)).toThrow(
      "Invalid input",
    );
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
  }),
];

describe("createNameColumn header", () => {
  it("omits an unspecified header so TanStack can derive the accessor id label", () => {
    const column = createNameColumn(
      createCubbyColumnHelper<TreeNameRow>(),
      "product",
      "name",
    );

    expect(Object.hasOwn(column, "header")).toBe(false);
  });
});

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
    columns: treeNameColumns.flatMap((column) => columnForTable(column)),
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
      }),
    [images],
  );
  const table = useTable({
    features: cubbyTableFeatures,
    data: IMAGE_ROWS,
    columns: useMemo(() => columnForTable(column), [column]),
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
    const { rerender, container } = render(<ImageHarness images={{}} />);
    expect(container.querySelector("img")).toBeNull();

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
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("a.png"),
    );
  });

  it("keeps PDFs out of `rowImages` thumbnails", () => {
    // `images` is typed, not `unknown[]`: `rowImages` requires a row that
    // really carries images, which is the whole point of it being named at the
    // call site rather than reached through a cast.
    type PdfRow = {
      id: string;
      images: Array<{
        id: string;
        url: string;
        filename: string;
        contentType?: string;
      }>;
    };
    const column = createImageColumn(createCubbyColumnHelper<PdfRow>(), {
      entity: "product",
      getImages: rowImages,
    });

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
        columns: columnForTable(column),
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

    const { container } = render(<PdfHarness />);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("photo.png"),
    );
  });

  it("defaults to `row.displayImages` when `getImages` is omitted", () => {
    // The server-resolved list contract every `displayImages` manifest
    // entity's list row carries — `getImages` is only for a table of a
    // non-list shape.
    type DisplayImagesRow = {
      id: string;
      displayImages: DisplayImageSummary[];
    };
    const column = createImageColumn(
      createCubbyColumnHelper<DisplayImagesRow>(),
      { entity: "product" },
    );

    function DisplayImagesHarness() {
      const table = useTable({
        features: cubbyTableFeatures,
        data: [
          {
            id: "PRD-1",
            displayImages: [
              {
                id: testShortcode("image", "IMG-1"),
                url: "https://example.com/cover.png",
              },
            ],
          },
        ],
        columns: columnForTable(column),
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

    const { container } = render(<DisplayImagesHarness />);
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("cover.png"),
    );
  });

  it("preserves provenance metadata for projected thumbnails", () => {
    type ImageProjectionRow = {
      id: string;
      displayImages: DisplayImageSummary[];
    };
    const provenance = {
      kind: "derived" as const,
      sources: [{ entity: "image" as const, label: null, relation: "images" }],
    };

    const column = createImageColumn(
      createCubbyColumnHelper<ImageProjectionRow>(),
      { entity: "product", provenance },
    );

    expect(column.meta?.provenance).toEqual(provenance);
  });
});

describe("createActionsColumn", () => {
  interface ActionRow {
    id: string;
  }

  const actionsColumn = (entity: "product" | "image") =>
    createActionsColumn(createCubbyColumnHelper<ActionRow>(), entity);

  const withCopyActions = (
    entity: "product" | "image",
    copiedCodes: string[],
  ) =>
    function CopyActionsProvider({ children }: { children: ReactNode }) {
      return (
        <EntityActionsProvider
          value={{
            entity,
            rowMenuItems: (row) => (
              <button type="button" onClick={() => copiedCodes.push(row.id)}>
                Copy {row.id}
              </button>
            ),
          }}
        >
          {children}
        </EntityActionsProvider>
      );
    };

  it("publishes the row's own code to its registered action presenter", async () => {
    const copiedCodes: string[] = [];
    renderColumn<ActionRow, unknown>(
      actionsColumn("product"),
      { id: "PRD-4K7M" },
      (children) => {
        const CopyActionsProvider = withCopyActions("product", copiedCodes);
        return <CopyActionsProvider>{children}</CopyActionsProvider>;
      },
      { browser: true },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open menu" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Copy PRD-4K7M/ }),
    );

    expect(copiedCodes).toEqual(["PRD-4K7M"]);
  });

  it("uses the image action presenter for a shortcode-routed image", async () => {
    const copiedCodes: string[] = [];
    renderColumn<ActionRow, unknown>(
      actionsColumn("image"),
      { id: "IMG-4K7M" },
      (children) => {
        const CopyActionsProvider = withCopyActions("image", copiedCodes);
        return <CopyActionsProvider>{children}</CopyActionsProvider>;
      },
      { browser: true },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open menu" }));
    expect(
      await screen.findByRole("menuitem", { name: /View details/ }),
    ).toBeVisible();

    fireEvent.click(
      await screen.findByRole("button", { name: /Copy IMG-4K7M/ }),
    );

    expect(copiedCodes).toEqual(["IMG-4K7M"]);
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

type TrackedBooleanOptions = {
  trueFalseOptions: typeof TRACKED_OPTIONS;
  undecided?: { label: string };
  editable?: {
    onSave: (newValue: boolean | null, row: TrackedRow) => Promise<void>;
  };
};

const trackedColumn = (
  onSave?: (v: boolean | null, row: TrackedRow) => Promise<void>,
) => {
  const options: TrackedBooleanOptions = {
    trueFalseOptions: TRACKED_OPTIONS,
    undecided: { label: "Undecided" },
  };
  if (onSave) options.editable = { onSave };
  return createBooleanColumn(
    createCubbyColumnHelper<TrackedRow>(),
    "stockTracked",
    options,
  );
};

describe("createBooleanColumn", () => {
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

    renderColumn<TrackedRow, string | null>(trackedColumn(), {
      stockTracked: null,
    });
    expect(screen.getByText(DASH)).toBeVisible();
    expect(screen.queryByText(/tracked/i)).toBeNull();
  });

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
    expect(cellData.getCopyPayload({ stockTracked: null })).toBeNull();
  });

  it("only offers the clear affordance when an undecided state is named", () => {
    const boolColumn = (undecided?: { label: string }) => {
      const options: TrackedBooleanOptions = {
        trueFalseOptions: TRACKED_OPTIONS,
        editable: { onSave: async () => {} },
      };
      if (undecided) options.undecided = undecided;
      return createBooleanColumn(
        createCubbyColumnHelper<TrackedRow>(),
        "stockTracked",
        options,
      );
    };

    const withUndecided = renderColumn<TrackedRow, string | null>(
      boolColumn({ label: "Undecided" }),
      { stockTracked: true },
    );
    fireEvent.click(screen.getByText("Tracked"));
    expect(
      screen.getByRole("button", { name: /Clear Undecided/i }),
    ).toBeInTheDocument();
    withUndecided.unmount();

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
    renderColumn(opted, { amount: 0 });
    expect(screen.getByText(DASH)).toBeVisible();
  });
});

// Range copy/paste reads `meta.cellData`, never the rendered cell — so a column
// that renders correctly can still be silently absent from the copy range. That
// is exactly what happened when two `createTextColumn` enum columns were
// hand-rolled into bare accessors to get a custom enum render (PR #766
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
    expect(cellData?.getCopyPayload({ kind: "purchase" })).toEqual({
      text: "Purchase",
      json: "purchase",
    });
    expect(cellData?.applyPaste).toBeUndefined();
    // `filterConfig: null` must leave meta.filterConfig undefined so the
    // manifest's control is the one that attaches.
    expect(column.meta?.filterConfig).toBeUndefined();

    renderColumn<EnumRow, string | null>(column, { kind: "purchase" });
    expect(screen.getByText("Purchase").parentElement).toHaveStyle({
      "--enum-pill-color": "var(--chart-1)",
    });
  });
});

describe("boolean tones come from the roster, not the factory", () => {
  type ProvisionalRow = { provisional: boolean | null };

  it("honours an inverted tone map and matches what other surfaces render", () => {
    const column = createBooleanColumn(
      createCubbyColumnHelper<ProvisionalRow>(),
      "provisional",
      { trueFalseOptions: provisionalOptions },
    );

    // The pill the table cell paints must use the same tint the detail page's
    // `renderOptionCell(…, provisionalOptions)` paints for the same value.
    const inkFor = (value: string) =>
      provisionalOptions.find((o) => o.value === value)?.color;
    expect(inkFor("true")).toBe("var(--warning)");
    expect(inkFor("false")).toBe("var(--positive)");

    renderColumn<ProvisionalRow, string | null>(column, { provisional: true });
    const pill = screen.getByText("Provisional").parentElement;
    expect(pill).toHaveClass("rounded-full");
    expect(pill).toHaveStyle({
      "--enum-pill-color": "var(--warning)",
    });
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

  it("a derived-only product's cell shows the derived cue, and its editor opens blank — the raw stored override, not the displayed fallback", async () => {
    render(
      <EditableCell
        value={null}
        onSave={async () => {}}
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
