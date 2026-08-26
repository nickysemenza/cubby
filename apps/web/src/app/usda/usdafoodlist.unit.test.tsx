import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { USDAFoodList, withUSDAListIdentity } from "./usdafoodlist";

const mocks = vi.hoisted(() => ({
  listWorkbench: vi.fn(),
  useEntityList: vi.fn(),
  useEntityPreview: vi.fn(),
}));

vi.mock("../_components/hooks/useEntityPreview", () => ({
  useEntityPreview: (...args: unknown[]) => {
    mocks.useEntityPreview(...args);
    return {
      onRowClick: vi.fn(),
      onRowHover: vi.fn(),
      onRowHoverEnd: vi.fn(),
      PreviewSheet: () => <div>Intermediate USDA preview</div>,
      preview: {
        entityType: "usda-food",
        id: "12345",
        rowKey: "usda-food:12345",
      },
      dockedInspector: <aside>USDA inspector</aside>,
    };
  },
}));

vi.mock("../_components/hooks/useEntityList", () => ({
  useEntityList: (...args: unknown[]) => {
    mocks.useEntityList(...args);
    return { workbench: { entity: "usda-food", table: {} } };
  },
}));

vi.mock("../_components/data-table/ListWorkbench", () => ({
  ListWorkbench: (props: Record<string, unknown>) => {
    mocks.listWorkbench(props);
    return <>{props.desktopInspector as ReactNode}</>;
  },
}));

describe("USDAFoodList", () => {
  it("adapts the external FDC identity to the shared list contract", () => {
    const row = withUSDAListIdentity({
      fdc_id: 12345,
      foodInfo: { description: "Example food" },
    });

    expect(row).toMatchObject({ id: "12345", name: "Example food" });
  });

  it("keeps FDC identity in the responsive inspector and projects scan-ready mobile facts", () => {
    render(<USDAFoodList />);

    const props = mocks.listWorkbench.mock.lastCall?.[0] as Record<
      string,
      unknown
    >;
    expect(mocks.useEntityPreview).toHaveBeenCalledWith("usda-food", {
      idField: "fdc_id",
      responsiveInspector: true,
    });
    expect(props.currentRowId).toBe("usda-food:12345");
    expect(props.defaultDensity).toBe("dense");
    expect(screen.getByText("USDA inspector")).toBeInTheDocument();
    expect(screen.getByText("Intermediate USDA preview")).toBeInTheDocument();

    const listOptions = mocks.useEntityList.mock.lastCall?.[0];
    expect(listOptions).toBeDefined();
    const { columns } = listOptions as {
      columns: Array<{
        id?: string;
        accessorKey?: string;
        meta?: { mobile?: unknown };
      }>;
    };
    const column = (id: string) =>
      columns.find(
        (candidate) => candidate.id === id || candidate.accessorKey === id,
      );
    expect(column("foodInfo-data_type")?.meta?.mobile).toMatchObject({
      slot: "subtitle",
    });
    expect(column("brandedFoodInfo")?.meta?.mobile).toMatchObject({
      slot: "meta",
    });
    expect(column("nutritionInfo")?.meta?.mobile).toMatchObject({
      slot: "meta",
    });
    expect(column("linkedProducts")?.meta?.mobile).toMatchObject({
      slot: "meta",
      interactive: true,
    });
  });
});
