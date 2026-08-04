import type { ColumnDef } from "@tanstack/react-table";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import { type ReactNode, useMemo } from "react";
import { describe, expect, it, vi } from "vitest";
import { createImageColumn, createParentLinkColumn } from "./columnHelpers";

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
function renderColumn<TRow>(column: ColumnDef<TRow, ParentValue>, row: TRow) {
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
