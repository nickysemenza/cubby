import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EntityListPage } from "./EntityListPage";

const mocks = vi.hoisted(() => ({
  listWorkbench: vi.fn(),
  previewClick: vi.fn(),
  inspectRow: vi.fn(),
  useEntityList: vi.fn(),
  useEntityPreview: vi.fn(),
}));

vi.mock("~/components/page/Page", () => ({
  usePageCount: vi.fn(),
}));

vi.mock("../hooks/useEntityList", () => ({
  useEntityList: (...args: unknown[]) => {
    mocks.useEntityList(...args);
    return {
      totalCount: 2,
      workbench: { entity: "vendor", table: {} },
    };
  },
}));

vi.mock("../hooks/useEntityPreview", () => ({
  useEntityPreview: (...args: unknown[]) => {
    mocks.useEntityPreview(...args);
    const enabled = args[1] !== undefined;
    return {
      onRowClick: enabled ? mocks.previewClick : undefined,
      inspectRow: enabled ? mocks.inspectRow : undefined,
      onRowHover: vi.fn(),
      onRowHoverEnd: vi.fn(),
      PreviewSheet: () => <div>Intermediate preview</div>,
      preview: enabled
        ? {
            entityType: "vendor",
            id: "VND-4K7M",
            rowKey: "VND-4K7M",
          }
        : undefined,
      dockedInspector: enabled ? <aside>Vendor inspector</aside> : null,
      inspectorToggle: enabled ? (
        <button type="button">Toggle inspector</button>
      ) : null,
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
  beforeEach(() => {
    mocks.listWorkbench.mockClear();
    mocks.useEntityList.mockClear();
    mocks.useEntityPreview.mockClear();
  });

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
    expect(props.defaultDensity).toBe("dense");
    expect(props.inspectorToggle).toBeTruthy();
    expect(mocks.useEntityList).toHaveBeenCalledWith(
      expect.objectContaining({ onInspectRow: mocks.inspectRow }),
    );
    expect(screen.getByText("Vendor inspector")).toBeInTheDocument();
    expect(screen.getByText("Intermediate preview")).toBeInTheDocument();

    screen.getByRole("button", { name: "Select row" }).click();
    expect(mocks.previewClick).toHaveBeenCalledWith({
      original: { id: "VND-4K7M" },
    });
  });

  it("keeps inspection out of a list that explicitly disables preview", () => {
    render(
      <EntityListPage
        entity="vendor"
        columns={[]}
        ariaLabel="Vendors table"
        preview={false}
      />,
    );

    expect(mocks.useEntityPreview).toHaveBeenCalledWith("vendor", undefined);
    expect(mocks.useEntityList).toHaveBeenCalledWith(
      expect.objectContaining({ onInspectRow: undefined }),
    );
    const props = mocks.listWorkbench.mock.lastCall?.[0] as Record<
      string,
      unknown
    >;
    expect(props.onRowClick).toBeUndefined();
    expect(props.desktopInspector).toBeNull();
    expect(screen.queryByText("Intermediate preview")).toBeNull();
  });

  it("keeps Finance rosters on the shared responsive inspector and row-selection seam", () => {
    render(
      <>
        <EntityListPage
          entity="financialAccount"
          columns={[]}
          ariaLabel="Accounts table"
        />
        <EntityListPage
          entity="financialTransaction"
          columns={[]}
          ariaLabel="Transactions table"
        />
      </>,
    );

    expect(mocks.useEntityPreview).toHaveBeenCalledWith("financialAccount", {
      idField: undefined,
      responsiveInspector: true,
    });
    expect(mocks.useEntityPreview).toHaveBeenCalledWith(
      "financialTransaction",
      {
        idField: undefined,
        responsiveInspector: true,
      },
    );
    const props = mocks.listWorkbench.mock.lastCall?.[0] as Record<
      string,
      unknown
    >;
    expect(props.defaultDensity).toBe("dense");
    expect(props.onRowClick).toBe(mocks.previewClick);
  });
});
