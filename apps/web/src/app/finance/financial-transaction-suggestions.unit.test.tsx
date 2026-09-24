import type { MerchantVendorInference } from "@cubby/schemas/financial-transaction";
import type { VendorShortcode } from "@cubby/schemas/identifiers";
import { testShortcode } from "@cubby/schemas/testing";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useForm, useWatch } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entityListHiddenColumns } from "~/entities/entity-display";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { purchaseSearchFilters } from "./financial-selectors";
import {
  emptyFinancialTransactionForm,
  FinancialTransactionFormFields,
  type FinancialTransactionFormValues,
} from "./financial-transaction-form";

const suggestion = (
  vendorId: VendorShortcode,
  vendorName: string,
): MerchantVendorInference => ({
  status: "suggested",
  candidates: [
    {
      vendorId,
      vendorName,
      supportingTransactionCount: 2,
      lastSeenDate: "2026-08-20",
    },
  ],
});

const OLD_VENDOR = testShortcode("vendor", "old-suggestion");
const NEW_VENDOR = testShortcode("vendor", "new-suggestion");

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness({ clock: { now: 0 } });
});

afterEach(() => {
  harness.dispose();
});

function TestForm({
  loadVendorInference,
}: {
  loadVendorInference: (merchant: string) => Promise<MerchantVendorInference>;
}) {
  const form = useForm<FinancialTransactionFormValues>({
    defaultValues: {
      ...emptyFinancialTransactionForm,
      accountId: "FAC-2345",
      purchaseId: "PUR-2345",
      merchant: "Old Processor",
    },
  });
  const selectedPurchase = useWatch({
    control: form.control,
    name: "purchaseId",
  });
  return (
    <>
      <FinancialTransactionFormFields
        form={form}
        loadVendorInference={loadVendorInference}
      />
      <output data-testid="selected-purchase">{selectedPurchase}</output>
    </>
  );
}

describe("Financial Transaction Vendor suggestions", () => {
  it("debounces Merchant changes, scopes by the new Vendor, and preserves selection", async () => {
    const loadVendorInference = vi.fn(async (merchant: string) =>
      merchant === "New Processor"
        ? suggestion(NEW_VENDOR, "New Supply")
        : suggestion(OLD_VENDOR, "Old Supply"),
    );
    render(<TestForm loadVendorInference={loadVendorInference} />, {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await harness.clock!.advanceBy(350);
      await Promise.resolve();
    });
    expect(screen.getByText("Old Supply")).toBeInTheDocument();
    expect(screen.getByTestId("selected-purchase")).toHaveTextContent(
      "PUR-2345",
    );

    fireEvent.click(screen.getByRole("button", { name: "All purchases" }));
    expect(screen.queryByText("Old Supply")).not.toBeInTheDocument();
    expect(screen.getByTestId("selected-purchase")).toHaveTextContent(
      "PUR-2345",
    );

    fireEvent.change(screen.getByDisplayValue("Old Processor"), {
      target: { value: "New Processor" },
    });
    await act(async () => {
      await harness.clock!.advanceBy(349);
    });
    expect(loadVendorInference).not.toHaveBeenCalledWith("New Processor");
    await act(async () => {
      await harness.clock!.advanceBy(10);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadVendorInference).toHaveBeenCalledWith("New Processor");
    await act(async () => {
      await harness.clock!.advanceBy(1);
    });
    expect(screen.getByText("New Supply")).toBeInTheDocument();
    expect(screen.getByTestId("selected-purchase")).toHaveTextContent(
      "PUR-2345",
    );
  });

  it("combines typed Purchase search with Vendor scope and keeps the list column hidden", () => {
    expect(purchaseSearchFilters("invoice 42", OLD_VENDOR)).toEqual({
      search: "invoice 42",
      vendorId: OLD_VENDOR,
    });
    expect(purchaseSearchFilters("invoice 42", null)).toEqual({
      search: "invoice 42",
      vendorId: undefined,
    });
    expect(entityListHiddenColumns("financialTransaction")).toMatchObject({
      vendorInference: false,
    });
  });
});
