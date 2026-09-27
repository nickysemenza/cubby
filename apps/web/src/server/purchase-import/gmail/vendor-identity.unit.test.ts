import { describe, expect, it } from "vitest";

import { matchesVendorSender, vendorSearchTerms } from "./vendor-identity";

describe("Vendor mail identity", () => {
  it("finds mail by the Vendor website domain without configured senders", () => {
    const vendor = {
      website: "https://shop.example-outfitters.co.uk/orders",
      orderEmailSenders: [],
    };
    expect(vendorSearchTerms(vendor)).toEqual(["example-outfitters.co.uk"]);
    expect(
      matchesVendorSender(
        "Example Outfitters <receipt@notifications.example-outfitters.co.uk>",
        vendor,
      ),
    ).toBe(true);
    expect(
      matchesVendorSender("receipt@fake-example-outfitters.co.uk", vendor),
    ).toBe(false);
  });

  it("keeps a deliberately configured third-party sender exact", () => {
    const vendor = {
      website: "https://example-outfitters.test",
      orderEmailSenders: ["orders@receipts.test"],
    };
    expect(vendorSearchTerms(vendor)).toEqual([
      "example-outfitters.test",
      "orders@receipts.test",
    ]);
    expect(matchesVendorSender("Orders <orders@receipts.test>", vendor)).toBe(
      true,
    );
    expect(matchesVendorSender("other@receipts.test", vendor)).toBe(false);
  });

  it("does not infer a sender from an invalid or missing website", () => {
    const vendor = { website: "not a website", orderEmailSenders: [] };
    expect(vendorSearchTerms(vendor)).toEqual([]);
    expect(matchesVendorSender("orders@example.test", vendor)).toBe(false);
  });

  it("uses the same private-suffix boundary for website and sender", () => {
    const vendor = {
      website: "https://store.example.github.io",
      orderEmailSenders: [],
    };
    expect(matchesVendorSender("orders@store.example.github.io", vendor)).toBe(
      true,
    );
    expect(matchesVendorSender("orders@other.github.io", vendor)).toBe(false);
  });
});
