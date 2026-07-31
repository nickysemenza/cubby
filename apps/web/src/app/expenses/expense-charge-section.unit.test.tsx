import {
  unsafeExpenseShortcode,
  unsafePurchaseShortcode,
  unsafeVendorShortcode,
} from "@cubby/schemas/identifiers";
import type { ExpenseOut } from "@cubby/schemas/project";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
}));

vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    expense: {
      chargeContext: {
        queryOptions: (id: string) => ({ queryKey: ["charge-context", id] }),
      },
    },
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    className,
    ...props
  }: {
    children?: ReactNode;
    to: string;
    params?: Record<string, string>;
    className?: string;
  }) => {
    const href = params
      ? Object.entries(params).reduce(
          (path, [key, value]) => path.replace(`$${key}`, value),
          to,
        )
      : to;
    return (
      <a href={href} className={className} {...props}>
        {children}
      </a>
    );
  },
}));

import { ExpenseChargeSection } from "./expense-charge-section";

const expense: ExpenseOut = {
  id: unsafeExpenseShortcode("EXP-2345"),
  name: "Router bits",
  cost: 24.99,
  date: "2026-07-31",
  costType: "materials",
  trade: "other",
  url: null,
  notes: null,
  future: false,
  projectId: null,
  productId: null,
  vendor: "Tool Nirvana",
  orderId: "#11325",
  purchaseId: unsafePurchaseShortcode("PUR-2345"),
  vendorId: unsafeVendorShortcode("VEN-2345"),
  projectName: null,
  productName: null,
  productShortcode: null,
  createdAt: new Date("2026-07-31T12:00:00Z"),
  updatedAt: new Date("2026-07-31T12:00:00Z"),
};

const purchase = {
  id: unsafePurchaseShortcode("PUR-2345"),
  orderId: "#11325",
  date: "2026-07-29",
  vendorId: unsafeVendorShortcode("VEN-2345"),
  vendorName: "Tool Nirvana",
};

describe("ExpenseChargeSection", () => {
  it("renders the canonical purchase label as the only charge link", () => {
    useQueryMock.mockReturnValue({
      data: { purchase, siblings: [] },
      isPending: false,
    });

    render(<ExpenseChargeSection expense={expense} />);

    const chargeLink = screen.getByRole("link", { name: /#11325/ });
    expect(chargeLink).toHaveAttribute("href", "/purchases/PUR-2345");
    expect(within(chargeLink).getByText("#11325")).toHaveClass(
      "decoration-dotted",
    );
    expect(within(chargeLink).getByText(/Tool Nirvana/)).toBeInTheDocument();
    // The old layout rendered the same order id again as an inert badge.
    expect(screen.getAllByText("#11325")).toHaveLength(1);
  });

  it("uses the canonical charge date for an orderless purchase label", () => {
    useQueryMock.mockReturnValue({
      data: {
        purchase: { ...purchase, orderId: null },
        siblings: [],
      },
      isPending: false,
    });

    render(<ExpenseChargeSection expense={{ ...expense, orderId: null }} />);

    const chargeLink = screen.getByRole("link", {
      name: /Tool Nirvana.*Jul 29, 2026/,
    });
    expect(chargeLink).toHaveAttribute("href", "/purchases/PUR-2345");
    expect(chargeLink).not.toHaveTextContent("Jul 31, 2026");
  });
});
