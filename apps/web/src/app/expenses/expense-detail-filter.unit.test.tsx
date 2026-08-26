import { type ExpenseOut, expenseOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string;
    search?: Record<string, unknown>;
    children: ReactNode;
  }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(search ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    return (
      <a href={`${to}${query.size ? `?${query}` : ""}`} {...props}>
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

vi.mock("~/components/page/Page", () => ({
  Page: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../_components/data-table/detail-page", () => ({
  DetailSections: ({
    sections,
  }: {
    sections: Array<{ title: string; content: ReactNode }>;
  }) => (
    <>
      {sections.map((section) => (
        <div key={section.title}>{section.content}</div>
      ))}
    </>
  ),
}));

vi.mock("../_components/data-table/editable-cell", () => ({
  EditableCell: ({
    value,
    renderValue,
  }: {
    value: unknown;
    renderValue: (value: never) => ReactNode;
  }) => <button type="button">{renderValue(value as never)}</button>,
}));

vi.mock("../_components/data-table/editable-entity-cell", () => ({
  EditableEntityCell: ({ value }: { value: ReactNode }) => (
    <button type="button">{value}</button>
  ),
}));

vi.mock("../_components/hooks/useEntityDetail", () => ({
  useEntityDetail: () => ({ commonSections: [] }),
}));
vi.mock("../_components/hooks/useEntityDelete", () => ({
  useEntityDelete: () => ({ deleteButton: null, deleteDialog: null }),
}));
vi.mock("../_components/hooks/useUpdateMutation", () => ({
  useUpdateMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("./project-suggestion-chips", () => ({
  ProjectSuggestionChips: () => null,
}));
vi.mock("./receive-expense-dialog", () => ({
  ReceiveExpenseDialog: () => null,
}));
vi.mock("./split-expense-dialog", () => ({ SplitExpenseDialog: () => null }));

import { ExpenseDetail } from "./expense-detail";

const expense: ExpenseOut = expenseOut.parse({
  id: testShortcode("expense", "EXP-4K7M"),
  name: "Copper pipe",
  cost: 42,
  date: "2026-08-18",
  lineKind: "principal",
  costType: "materials",
  lineBasis: "item_line",
  trade: "plumbing",
  future: false,
  vendor: null,
  vendorId: null,
  vendorLogo: null,
  projectId: null,
  projectName: null,
  productId: null,
  productName: null,
  productQuantity: null,
  purchaseId: null,
  orderId: null,
  orderUrl: null,
  notes: null,
  url: null,
  purchaseDate: null,
  purchaseDisplayLabel: null,
  sourceClaims: [],
  beneficiaries: [],
  funders: [],
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
});

describe("ExpenseDetail filter links", () => {
  it("keeps the editable value primary and exposes a separate cohort action", () => {
    render(<ExpenseDetail expense={expense} />);

    const edit = screen.getByRole("button", { name: "Item or service" });
    const filter = screen.getByRole("link", {
      name: "Show all item or service expenses",
    });

    expect(edit.contains(filter)).toBe(false);
    expect(filter).toHaveAttribute("href", "/expenses?lineKind=principal");
    expect(filter).toHaveClass("size-10", "sm:size-7");
  });
});
