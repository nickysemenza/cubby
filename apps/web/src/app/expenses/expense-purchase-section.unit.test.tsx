import {
  expenseChargeContextOut,
  type ExpenseOut,
} from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type ExpensePurchaseOperations,
  ExpensePurchaseSection,
} from "./expense-purchase-section";
import { expense as expenseOperations } from "./expense.functions";

const expense: ExpenseOut = {
  id: testShortcode("expense", "EXP-2345"),
  name: "Router bits",
  cost: 24.99,
  date: "2026-07-31",
  lineKind: "principal",
  lineBasis: "item_line",
  costType: "materials",
  trade: "other",
  url: null,
  notes: null,
  future: false,
  projectId: null,
  productId: null,
  productQuantity: null,
  vendor: "Tool Nirvana",
  orderId: "#11325",
  orderUrl: null,
  purchaseId: testShortcode("purchase", "PUR-2345"),
  purchaseDate: "2026-07-29",
  purchaseDisplayLabel: null,
  vendorId: testShortcode("vendor", "VEN-2345"),
  vendorLogo: null,
  projectName: null,
  productName: null,
  beneficiaries: [],
  funders: [],
  sourceClaims: [],
  createdAt: new Date("2026-07-31T12:00:00Z"),
  updatedAt: new Date("2026-07-31T12:00:00Z"),
};

const purchase = {
  id: testShortcode("purchase", "PUR-2345"),
  orderId: "#11325",
  displayLabel: null,
  date: "2026-07-29",
  vendorId: testShortcode("vendor", "VEN-2345"),
  vendorName: "Tool Nirvana",
};

const buildOperations = (
  context: z.input<typeof expenseChargeContextOut>,
): ExpensePurchaseOperations => {
  const chargeContext = expenseOperations.chargeContext.withTransport(
    async () => expenseChargeContextOut.parse(context),
  );
  return { chargeContext: chargeContext.queryOptions };
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("ExpensePurchaseSection", () => {
  it("shows an inline error and recovers purchase items on retry", async () => {
    let unavailable = true;
    const operation = expenseOperations.chargeContext.withTransport(
      async () => {
        if (unavailable) throw new Error("Temporary connection failure");
        return expenseChargeContextOut.parse({ purchase, siblings: [] });
      },
    );
    render(
      <ExpensePurchaseSection
        expense={expense}
        operations={{ chargeContext: operation.queryOptions }}
      />,
      { wrapper: harness.wrapper },
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Temporary connection failure",
    );
    unavailable = false;
    fireEvent.click(
      screen.getByRole("button", { name: "Retry purchase items" }),
    );
    expect(
      await screen.findByText("This is the only expense in the purchase."),
    ).toBeVisible();
  });
  it("renders the canonical purchase label as the only purchase link", async () => {
    render(
      <ExpensePurchaseSection
        expense={expense}
        operations={buildOperations({ purchase, siblings: [] })}
      />,
      { wrapper: harness.wrapper },
    );

    const chargeLink = await screen.findByRole("link", { name: /#11325/ });
    expect(chargeLink).toHaveAttribute("href", "/purchases/PUR-2345");
    expect(within(chargeLink).getByText("#11325")).toHaveClass(
      "decoration-dotted",
    );
    expect(within(chargeLink).getByText(/Tool Nirvana/)).toBeInTheDocument();
    // The old layout rendered the same order id again as an inert badge.
    expect(screen.getAllByText("#11325")).toHaveLength(1);
  });

  it("uses the canonical purchase date for an orderless purchase label", async () => {
    render(
      <ExpensePurchaseSection
        expense={{ ...expense, orderId: null }}
        operations={buildOperations({
          purchase: { ...purchase, orderId: null },
          siblings: [],
        })}
      />,
      { wrapper: harness.wrapper },
    );

    const chargeLink = await screen.findByRole("link", {
      name: /Tool Nirvana.*Jul 29, 2026/,
    });
    expect(chargeLink).toHaveAttribute("href", "/purchases/PUR-2345");
    expect(chargeLink).not.toHaveTextContent("Jul 31, 2026");
  });
});
