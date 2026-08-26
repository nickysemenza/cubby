import {
  type ProductProjectUsesOut,
  productProjectUsesOut,
} from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type ProductProjectUsesMocks = {
  projectUses: { current: ProductProjectUsesOut | undefined };
  clientList: {
    current:
      | {
          data: Array<{ id: string; name: string }>;
          extraActions?: unknown;
        }
      | undefined;
  };
};

const mocks = vi.hoisted<ProductProjectUsesMocks>(() => ({
  projectUses: { current: undefined },
  clientList: { current: undefined },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.projectUses.current, isPending: false }),
}));

vi.mock("~/app/products/product.functions", () => ({
  product: {
    projectUses: { queryOptions: () => ({ queryKey: ["projectUses"] }) },
    setProjectUses: { mutationOptions: () => ({}) },
  },
}));

vi.mock("~/app/projects/project.functions", () => ({
  project: { setToolUsage: { mutationOptions: () => ({}) } },
}));

vi.mock("~/app/_components/hooks/useActionMutation", () => ({
  useActionMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("~/app/_components/hooks/useClientEntityList", () => ({
  useClientEntityList: (options: {
    data: Array<{ id: string; name: string }>;
    extraActions?: unknown;
  }) => {
    mocks.clientList.current = options;
    return { workbench: {} };
  },
}));

vi.mock("~/app/_components/hooks/useProjectOptions", () => ({
  useProjectOptions: () => ({ rows: [], isLoading: false }),
}));

vi.mock("~/app/_components/data-table/ListWorkbench", () => ({
  ListWorkbench: () => <div data-testid="project-use-table" />,
}));

import {
  ProductProjectUses,
  shouldShowProductProjectUses,
} from "./product-project-uses";

const productId = testShortcode("product", "PRD-HISTORY");
const projectUse = productProjectUsesOut.parse({
  productId,
  productName: "Formerly reusable resource",
  manufacturer: "Acme",
  category: "household",
  canEdit: false,
  projectUseCount: 1,
  netLifetimeCost: 42,
  costPerProjectUse: null,
  grossLifetimeAcquisitionCost: 42,
  projects: [
    {
      projectId: testShortcode("project", "PRJ-PAST"),
      projectName: "Past kitchen repair",
      status: "done",
      kind: null,
      projectPurchaseCost: 42,
      sharedWindow: null,
      attachedAt: new Date("2026-01-01T00:00:00Z"),
    },
  ],
});

describe("ProductProjectUses", () => {
  it("keeps the section available for reusable products or confirmed historical uses", () => {
    expect(shouldShowProductProjectUses("tools", 0)).toBe(true);
    expect(shouldShowProductProjectUses("software", 0)).toBe(true);
    expect(shouldShowProductProjectUses("household", 1)).toBe(true);
    expect(shouldShowProductProjectUses("household", 0)).toBe(false);
  });

  it("shows recategorized project use as read-only history", () => {
    mocks.projectUses.current = projectUse;
    render(<ProductProjectUses productId={productId} />);

    expect(screen.getByTestId("project-use-table")).toBeInTheDocument();
    expect(mocks.clientList.current?.data).toEqual([
      expect.objectContaining({ name: "Past kitchen repair" }),
    ]);
    expect(
      screen.getByText(
        "Historical project use is read-only because this product is no longer a reusable resource.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit projects" }),
    ).not.toBeInTheDocument();
    expect(mocks.clientList.current?.extraActions).toBeUndefined();
  });

  it("retains edit affordances for current reusable resources", () => {
    mocks.projectUses.current = {
      ...projectUse,
      category: "tools",
      canEdit: true,
    };
    render(<ProductProjectUses productId={productId} />);

    expect(
      screen.getByRole("button", { name: "Edit projects" }),
    ).toBeInTheDocument();
    expect(mocks.clientList.current?.extraActions).toEqual(
      expect.any(Function),
    );
  });
});
