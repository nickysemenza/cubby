import type { ProductWithFoodOut } from "@cubby/schemas/product";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    params,
    children,
    ...props
  }: {
    to: string;
    search?: Record<string, unknown>;
    params?: Record<string, string>;
    children: ReactNode;
  }) => {
    const path = Object.entries(params ?? {}).reduce(
      (value, [key, replacement]) => value.replace(`$${key}`, replacement),
      to,
    );
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(search ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    return (
      <a href={`${path}${query.size ? `?${query}` : ""}`} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
}));

vi.mock("~/app/_components/hooks/useActionMutation", () => ({
  useActionMutation: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("~/app/_components/hooks/useEntityDelete", () => ({
  useEntityDelete: () => ({ deleteButton: null, deleteDialog: null }),
}));

vi.mock("../data-table/editable-cell", () => ({
  EditableCell: ({
    value,
    renderValue,
  }: {
    value: unknown;
    renderValue: (value: never) => ReactNode;
  }) => <button type="button">{renderValue(value as never)}</button>,
}));

vi.mock("../data-table/columnHelpers", () => ({
  describeProductPricingSource: () => "No price recorded",
  productPriceClearLabel: () => "Clear price",
  renderProductPriceValue: () => "No price",
}));

vi.mock("../EntityInlineLink", () => ({
  EntityInlineLink: ({ data }: { data: { name: string } }) => (
    <a href="/entity-detail">{data.name}</a>
  ),
}));

vi.mock("../print-label-button", () => ({ PrintLabelButton: () => null }));
vi.mock("./product-notes-markdown", () => ({
  ProductNotesMarkdown: () => null,
}));

import { ProductBasicInfo } from "./product-basic-info";

const product = {
  id: "PRD-4K7M",
  name: "Impact Driver",
  manufacturer: "Milwaukee",
  model: "2853-20",
  price: null,
  pricing: { source: "none", value: null },
  category: "power_tools",
  upc: null,
  fdc_id: null,
  ingredient: { id: "ING-2ABC", name: "Driver bits" },
  food: null,
  externalIds: [],
  tags: ["M18"],
  notes: null,
} as unknown as ProductWithFoodOut;

describe("ProductBasicInfo filter links", () => {
  it("links read-only values and keeps editable/relationship cohorts separate", () => {
    render(<ProductBasicInfo product={product} onEdit={vi.fn()} />);

    expect(
      screen.getByRole("link", { name: "Show all products by Milwaukee" }),
    ).toHaveAttribute("href", "/products?view=table&manufacturer=Milwaukee");
    expect(
      screen.getByRole("link", {
        name: "Show all products matching model 2853-20",
      }),
    ).toHaveAttribute("href", "/products?view=table&model=2853-20");
    expect(
      screen.getByRole("link", { name: "Show all products tagged M18" }),
    ).toHaveAttribute("href", "/products?view=table&tags=M18");

    const categoryEdit = screen.getByRole("button", { name: "power_tools" });
    const categoryFilter = screen.getByRole("link", {
      name: "Show all products in power_tools",
    });
    expect(categoryEdit.contains(categoryFilter)).toBe(false);
    expect(categoryFilter).toHaveAttribute(
      "href",
      "/products?view=table&category=power_tools",
    );

    const ingredientDetail = screen.getByRole("link", { name: "Driver bits" });
    const ingredientFilter = screen.getByRole("link", {
      name: "Show all products for Driver bits",
    });
    expect(ingredientDetail).toHaveAttribute("href", "/entity-detail");
    expect(ingredientFilter).toHaveAttribute(
      "href",
      "/products?view=table&ingredient=ING-2ABC",
    );
  });
});
