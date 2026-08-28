import { describe, expect, it } from "vitest";

import {
  purchaseIdentityLabel,
  purchaseLabel,
  purchaseLabelUsedVendor,
} from "./purchase-label";

/**
 * `Purchase` has no `name` column, so every surface that renders a charge
 * (`EntityInlineLink`, the hover preview, the embedded charges table) leans on
 * this one ladder. Each rung is pinned here: drift in any of them would make the
 * same charge read differently in three places.
 */
describe("purchaseLabel", () => {
  it("prefers the vendor's own order id — that's what the receipt says", () => {
    // The order id wins even with a vendor and date available: it's the value the
    // ledger's Order # links match on.
    expect(
      purchaseLabel({
        orderId: "111-1234567-1234567",
        vendorName: "Amazon",
        date: "2026-03-04",
      }),
    ).toBe("111-1234567-1234567");
  });

  it("appends preserved human context parenthetically", () => {
    expect(
      purchaseLabel({
        orderId: "11100722797",
        displayLabel: "pocket hole jig + bits",
        vendorName: "Rockler",
        date: "2024-05-01",
      }),
    ).toBe("11100722797 (pocket hole jig + bits)");
  });

  it("ignores blank display labels", () => {
    expect(
      purchaseLabel({
        orderId: "11100722797",
        displayLabel: "   ",
      }),
    ).toBe("11100722797");
  });

  it("falls back to vendor + charge date when there's no order id", () => {
    // ~40% of real charges never got an order id from the vendor, so this rung —
    // not the one above — is the common path for a walk-in buy.
    expect(
      purchaseLabel({
        orderId: null,
        vendorName: "Tool Nirvana",
        date: "2026-03-04",
      }),
    ).toBe("Tool Nirvana · Mar 4, 2026");
  });

  it("keeps orderless identity and appends human context", () => {
    expect(
      purchaseLabel({
        orderId: null,
        displayLabel: "walk-in lumber run",
        vendorName: "Ganahl Lumber",
        date: "2026-03-04",
      }),
    ).toBe("Ganahl Lumber · Mar 4, 2026 (walk-in lumber run)");
  });

  it("falls back to the bare vendor when there's no date either", () => {
    expect(purchaseLabel({ orderId: null, vendorName: "Ganahl Lumber" })).toBe(
      "Ganahl Lumber",
    );
    // An explicitly-null date is the same state as an absent one.
    expect(
      purchaseLabel({ orderId: null, vendorName: "Ganahl Lumber", date: null }),
    ).toBe("Ganahl Lumber");
  });

  it("degrades to 'Unknown vendor' rather than an empty label", () => {
    // Belt-and-braces, never the normal path: `vendorName` is null only when the
    // vendor row was soft-deleted, which the repo refuses while live charges
    // point at it. A label is still required — a blank one would render as a
    // dead, unclickable-looking link.
    expect(purchaseLabel({ orderId: null, vendorName: null })).toBe(
      "Unknown vendor",
    );
    expect(purchaseLabel({ orderId: null })).toBe("Unknown vendor");
    expect(purchaseLabel({ orderId: null, date: "2026-03-04" })).toBe(
      "Unknown vendor · Mar 4, 2026",
    );
  });

  it("treats an empty-string order id as absent", () => {
    // Clearing an inline text edit writes "", not null — it must not become the
    // label.
    expect(purchaseLabel({ orderId: "", vendorName: "Lowe's" })).toBe("Lowe's");
  });
});

describe("purchaseIdentityLabel", () => {
  it("omits display context for full purchase rosters", () => {
    expect(
      purchaseIdentityLabel({
        orderId: "11100722797",
        displayLabel: "pocket hole jig + bits",
        vendorName: "Rockler",
        date: "2024-05-01",
      }),
    ).toBe("11100722797");
  });

  it("keeps the orderless identity ladder", () => {
    expect(
      purchaseIdentityLabel({
        orderId: null,
        displayLabel: "walk-in lumber run",
        vendorName: "Ganahl Lumber",
        date: "2026-03-04",
      }),
    ).toBe("Ganahl Lumber · Mar 4, 2026");
  });
});

describe("purchaseLabelUsedVendor", () => {
  it("reports whether the label already spent the vendor name", () => {
    // Callers that show the vendor as secondary metadata use this so an
    // order-id-less charge doesn't print its vendor twice.
    expect(purchaseLabelUsedVendor({ orderId: null })).toBe(true);
    expect(purchaseLabelUsedVendor({ orderId: "WN63446464" })).toBe(false);
    // Same empty-string rule as the label itself, so the two can't disagree.
    expect(purchaseLabelUsedVendor({ orderId: "" })).toBe(true);
  });
});
