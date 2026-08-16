import type { ColumnDef } from "@tanstack/react-table";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useMemo } from "react";
import { describe, expect, it, vi } from "vitest";
import { formatCurrency } from "~/lib/utils";
import {
  createActionsColumn,
  createCurrencyColumn,
  createImageColumn,
  createParentLinkColumn,
} from "./columnHelpers";

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
function renderColumn<TRow, TValue = ParentValue>(
  column: ColumnDef<TRow, TValue>,
  row: TRow,
) {
  function Harness() {
    const table = useReactTable({
      data: [row],
      columns: [column],
      getCoreRowModel: getCoreRowModel(),
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
    createColumnHelper<TaskRow>(),
    "task",
    "parentTaskId",
    "parentTaskName",
    options,
  );

const projectColumn = (): ColumnDef<ProjectRow, ParentValue> =>
  createParentLinkColumn(
    createColumnHelper<ProjectRow>(),
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
      createImageColumn(createColumnHelper<ImageRowFixture>(), {
        entity: "project",
        getImages: (row) => images[row.id] ?? [],
      }) as ColumnDef<ImageRowFixture, unknown>,
    [images],
  );
  const table = useReactTable({
    data: IMAGE_ROWS,
    columns: useMemo(() => [column], [column]),
    getCoreRowModel: getCoreRowModel(),
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
      createColumnHelper<{ id: string; images: unknown[] }>(),
      { entity: "product" },
    ) as ColumnDef<{ id: string; images: unknown[] }, unknown>;

    function PdfHarness() {
      const table = useReactTable({
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
        getCoreRowModel: getCoreRowModel(),
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
    createActionsColumn(createColumnHelper<ActionRow>(), entity) as ColumnDef<
      ActionRow,
      unknown
    >;

  it("offers the row's own code, and copies exactly that", () => {
    renderColumn<ActionRow, unknown>(actionsColumn("product"), {
      id: "PRD-4K7M",
    });

    fireEvent.click(screen.getByRole("button", { name: /Copy PRD-4K7M/ }));

    expect(clipboardMocks.copyShortcodes).toHaveBeenCalledWith(["PRD-4K7M"]);
  });

  // `image` is the one entity routed by uuid, so its link params carry `id`
  // rather than `shortcode` — and a uuid must never reach the clipboard as if
  // it were a public code.
  it("omits the copy item for an entity routed by uuid", () => {
    renderColumn<ActionRow, unknown>(actionsColumn("image"), {
      id: "3f6c1e0a-0000-4000-8000-000000000000",
    });

    expect(screen.getByRole("link", { name: /View details/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
  });
});

type MoneyRow = { amount: number | null };

const moneyColumn = (): ColumnDef<MoneyRow, number | null> =>
  createCurrencyColumn(createColumnHelper<MoneyRow>(), "amount");

// Only the steps a money column could plausibly land on. Widening this table
// isn't the point of the test — pulling the real px value for whatever `w-*`
// class ships is.
const TAILWIND_WIDTH_PX: Record<string, number> = {
  "w-16": 64,
  "w-20": 80,
  "w-24": 96,
  "w-28": 112,
  "w-32": 128,
  "w-40": 160,
};

describe("createCurrencyColumn", () => {
  it("declares a width wide enough for the widest formatted value", () => {
    const className = moneyColumn().meta?.className ?? "";
    const widthClass = className.split(" ").find((c) => c in TAILWIND_WIDTH_PX);
    expect(widthClass).toBeDefined();
    const widthPx = TAILWIND_WIDTH_PX[widthClass as string];

    // Measured in-browser: "-$999,999.99" (the widest sign+dollar amount this
    // column formats) renders at 128-144px in JetBrains Mono at the table's
    // cell font size. The old w-20 default (80px) clipped it mid-digit with
    // no ellipsis and no `title`, so a truncated number still looked complete.
    expect(widthPx).toBeGreaterThanOrEqual(128);
  });

  it("clips overflow with an ellipsis instead of a hard clip", () => {
    const className = moneyColumn().meta?.className ?? "";
    expect(className).toContain("truncate");
  });

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
