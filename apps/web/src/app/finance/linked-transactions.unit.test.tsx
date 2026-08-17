import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
}));

vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    financialTransaction: {
      list: {
        queryOptions: (input: unknown) => ({
          queryKey: ["financial-transaction", "list", input],
        }),
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
      <a href={href} className={className}>
        {children}
      </a>
    );
  },
}));

import { LinkedTransactions } from "./linked-transactions";

describe("LinkedTransactions", () => {
  it("keeps every fixed-layout column readable and renders shared status labels", () => {
    useQueryMock.mockReturnValue({
      data: {
        items: [
          {
            id: "FTR-2345",
            merchant: "Neighborhood Market",
            rawDescription: null,
            accountId: "FAC-2345",
            accountName: "Household Card",
            status: "posted",
            postedDate: "2026-08-16",
            amount: 42.5,
            allocations: [],
          },
        ],
      },
    });

    render(<LinkedTransactions accountId="FAC-2345" />);

    expect(
      screen.getByRole("columnheader", { name: "Transaction" }),
    ).toHaveClass("w-40");
    expect(screen.getByRole("columnheader", { name: "Account" })).toHaveClass(
      "w-32",
    );
    expect(screen.getByRole("columnheader", { name: "Status" })).toHaveClass(
      "w-24",
    );
    expect(screen.getByRole("columnheader", { name: "Posted" })).toHaveClass(
      "w-24",
    );
    expect(screen.getByRole("columnheader", { name: "Amount" })).toHaveClass(
      "w-36",
      "text-right",
    );

    const transactionLink = screen.getByRole("link", {
      name: "Neighborhood Market",
    });
    expect(transactionLink).toHaveAttribute(
      "href",
      "/financial-transactions/FTR-2345",
    );
    expect(transactionLink).toHaveClass("block", "truncate");

    const accountLink = screen.getByRole("link", { name: "Household Card" });
    expect(accountLink).toHaveAttribute("href", "/financial-accounts/FAC-2345");
    expect(accountLink).toHaveClass("block", "truncate");

    const row = transactionLink.closest("tr");
    expect(row).not.toBeNull();
    const statusCell = within(row as HTMLTableRowElement).getAllByRole(
      "cell",
    )[2];
    expect(statusCell).toHaveTextContent("Posted");
    expect(statusCell).not.toHaveTextContent(/^posted$/);
    expect(statusCell?.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});
