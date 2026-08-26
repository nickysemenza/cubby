import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { EntityListPage } from "./EntityListPage";

const mocks = vi.hoisted(() => ({
  listWorkbench: vi.fn(),
  previewClick: vi.fn(),
  useEntityPreview: vi.fn(),
}));

vi.mock("~/components/page/Page", () => ({
  usePageCount: vi.fn(),
}));

vi.mock("../hooks/useEntityList", () => ({
  useEntityList: () => ({
    totalCount: 2,
    workbench: { entity: "vendor", table: {} },
  }),
}));

vi.mock("../hooks/useEntityPreview", () => ({
  useEntityPreview: (...args: unknown[]) => {
    mocks.useEntityPreview(...args);
    return {
      onRowClick: mocks.previewClick,
      onRowHover: vi.fn(),
      onRowHoverEnd: vi.fn(),
      PreviewSheet: () => <div>Intermediate preview</div>,
      preview: { entityType: "vendor", id: "VND-4K7M" },
      dockedInspector: <aside>Vendor inspector</aside>,
    };
  },
}));

vi.mock("./ListWorkbench", () => ({
  ListWorkbench: (props: Record<string, unknown>) => {
    mocks.listWorkbench(props);
    return (
      <div>
        {props.desktopInspector as ReactNode}
        <button
          type="button"
          onClick={() =>
            (props.onRowClick as (row: { original: { id: string } }) => void)({
              original: { id: "VND-4K7M" },
            })
          }
        >
          Select row
        </button>
      </div>
    );
  },
}));

describe("EntityListPage inspector composition", () => {
  it("forwards the current record and responsive inspector without changing row selection semantics", () => {
    render(
      <EntityListPage entity="vendor" columns={[]} ariaLabel="Vendors table" />,
    );

    const props = mocks.listWorkbench.mock.lastCall?.[0] as Record<
      string,
      unknown
    >;
    expect(mocks.useEntityPreview).toHaveBeenCalledWith("vendor", {
      idField: undefined,
      responsiveInspector: true,
    });
    expect(props.currentRowId).toBe("VND-4K7M");
    expect(screen.getByText("Vendor inspector")).toBeInTheDocument();
    expect(screen.getByText("Intermediate preview")).toBeInTheDocument();

    screen.getByRole("button", { name: "Select row" }).click();
    expect(mocks.previewClick).toHaveBeenCalledWith({
      original: { id: "VND-4K7M" },
    });
  });
});
