import type { MerchantVendorInference } from "@cubby/schemas/financial-transaction";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { PossibleVendor } from "./possible-vendor";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("PossibleVendor", () => {
  it("shows a neutral linked suggestion and its evidence count", () => {
    const vendorId = testShortcode("vendor", "possible-vendor-alpha");
    const inference: MerchantVendorInference = {
      status: "suggested",
      candidates: [
        {
          vendorId,
          vendorName: "Neighborhood Supply",
          supportingTransactionCount: 3,
          lastSeenDate: "2026-08-20",
        },
      ],
    };
    render(<PossibleVendor inference={inference} />, {
      wrapper: harness.wrapper,
    });

    expect(
      screen.getByRole("link", { name: "Neighborhood Supply" }),
    ).toHaveAttribute("href", `/vendors/${vendorId}`);
    expect(
      screen.getByText(/Based on 3 previously settled transactions/),
    ).toBeInTheDocument();
    expect(document.querySelector("[class*='text-positive']")).toBeNull();
    expect(document.querySelector("[class*='text-warning']")).toBeNull();
  });

  it("exposes ambiguous candidates as an expandable accessible list", () => {
    const inference: MerchantVendorInference = {
      status: "ambiguous",
      candidates: [
        {
          vendorId: testShortcode("vendor", "possible-vendor-alpha"),
          vendorName: "Alpha Supply",
          supportingTransactionCount: 4,
          lastSeenDate: "2026-08-20",
        },
        {
          vendorId: testShortcode("vendor", "possible-vendor-beta"),
          vendorName: "Beta Market",
          supportingTransactionCount: 1,
          lastSeenDate: "2026-08-18",
        },
      ],
    };
    render(<PossibleVendor inference={inference} />, {
      wrapper: harness.wrapper,
    });

    const disclosure = screen.getByText("2 possible vendors");
    expect(disclosure.closest("summary")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Alpha Supply" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Beta Market" }),
    ).toBeInTheDocument();
  });

  it("renders no relationship for absent or one-vote evidence", () => {
    const { container, rerender } = render(
      <PossibleVendor inference={{ status: "none", candidates: [] }} />,
      { wrapper: harness.wrapper },
    );
    expect(container).toBeEmptyDOMElement();

    rerender(
      <PossibleVendor
        inference={{
          status: "insufficient_history",
          candidates: [
            {
              vendorId: testShortcode("vendor", "possible-vendor-one-off"),
              vendorName: "One-Off Supply",
              supportingTransactionCount: 1,
              lastSeenDate: "2026-08-20",
            },
          ],
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
