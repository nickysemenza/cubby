import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MealTable } from "./meal-table";

const mocks = vi.hoisted(() => ({
  listWorkbench: vi.fn(),
  useEntityPreview: vi.fn(),
}));

vi.mock("../_components/hooks/useEntityPreview", () => ({
  useEntityPreview: (...args: unknown[]) => {
    mocks.useEntityPreview(...args);
    return {
      onRowClick: vi.fn(),
      onRowHover: vi.fn(),
      onRowHoverEnd: vi.fn(),
      PreviewSheet: () => <div>Intermediate meal preview</div>,
      preview: { entityType: "meal", id: "ML-4K7M", rowKey: "ML-4K7M" },
      dockedInspector: <aside>Meal inspector</aside>,
    };
  },
}));

vi.mock("../_components/hooks/useEntityList", () => ({
  useEntityList: () => ({ workbench: { entity: "meal", table: {} } }),
}));

vi.mock("../_components/hooks/useUpdateMutation", () => ({
  useUpdateMutation: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("../_components/hooks/useDeletableConfig", () => ({
  useDeletableConfig: () => ({}),
}));

vi.mock("../_components/data-table/ListWorkbench", () => ({
  ListWorkbench: (props: Record<string, unknown>) => {
    mocks.listWorkbench(props);
    return <>{props.desktopInspector as ReactNode}</>;
  },
}));

describe("MealTable inspector composition", () => {
  it("keeps the meal table in context while the responsive inspector owns the selected record", () => {
    render(<MealTable />);

    const props = mocks.listWorkbench.mock.lastCall?.[0] as Record<
      string,
      unknown
    >;
    expect(mocks.useEntityPreview).toHaveBeenCalledWith("meal", {
      responsiveInspector: true,
    });
    expect(props.currentRowId).toBe("ML-4K7M");
    expect(screen.getByText("Meal inspector")).toBeInTheDocument();
    expect(screen.getByText("Intermediate meal preview")).toBeInTheDocument();
  });
});
