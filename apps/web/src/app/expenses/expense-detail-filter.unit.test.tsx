import { type ExpenseOut, expenseOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

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

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("ExpenseDetail filter links", () => {
  it("keeps the editable value primary and exposes a separate cohort action", async () => {
    render(<ExpenseDetail expense={expense} />, { wrapper: harness.wrapper });

    const edit = await screen.findByRole("button", {
      name: "Item or service",
    });
    const filter = await screen.findByRole("link", {
      name: "Show all item or service expenses",
    });

    expect(edit.contains(filter)).toBe(false);
    expect(filter).toHaveAttribute("href", "/expenses?lineKind=principal");
    expect(filter).toHaveClass("size-10", "sm:size-7");
  });
});
