import { type ExpenseOut, expenseOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { SettleExpenseDialog } from "./settle-expense-dialog";

const expense: ExpenseOut = expenseOut.parse({
  id: testShortcode("expense", "EXP-4K7M"),
  name: "Copper pipe",
  cost: 42,
  date: "2026-08-18",
  lineKind: "principal",
  costType: "materials",
  lineBasis: "item_line",
  trade: "plumbing",
  future: true,
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

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("SettleExpenseDialog", () => {
  it("preserves the final-cost draft when an unknown date becomes ineligible", async () => {
    render(
      <SettleExpenseDialog open onOpenChange={() => {}} expense={expense} />,
      { wrapper: harness.wrapper },
    );
    const cost = screen.getByLabelText("Final cost");
    fireEvent.change(cost, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Date unknown" }));
    fireEvent.change(cost, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark purchased" }));
    expect(
      await screen.findAllByText(/A date is required unless the cost is \$0/),
    ).not.toHaveLength(0);
    await waitFor(() =>
      expect(screen.getByLabelText("Expense date")).toBeInvalid(),
    );
    expect(cost).toHaveValue(12);
    expect(
      screen.getByRole("button", { name: "Mark purchased" }),
    ).toBeEnabled();
  });

  it("renders", () => {
    render(
      <SettleExpenseDialog open onOpenChange={() => {}} expense={expense} />,
      { wrapper: harness.wrapper },
    );

    expect(
      screen.getByRole("button", { name: "Mark purchased" }),
    ).toBeVisible();
    const form = screen
      .getByRole("button", { name: "Mark purchased" })
      .closest("form");
    const body = form?.querySelector('[data-slot="dialog-form-body"]');
    const footer = form?.querySelector('[data-slot="dialog-form-footer"]');
    expect(body).toBeTruthy();
    expect(footer).toContainElement(
      screen.getByRole("button", { name: "Mark purchased" }),
    );
    expect(body).not.toContainElement(
      screen.getByRole("button", { name: "Mark purchased" }),
    );
  });
});
