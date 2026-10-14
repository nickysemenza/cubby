import { describe, it, expect } from "vitest";

import { extractBestPrice } from "./price";
import type { UPCitemdbOffer } from "./types";

describe("extractBestPrice", () => {
  const flourOffers: UPCitemdbOffer[] = [
    {
      merchant: "Synthetic merchant 1",
      domain: "newegg.com",
      title: "Synthetic Mill, FLOUR WHT UNBLCH, 5 LB, (Pack of 4)",
      currency: "",
      price: 44.26,
      link: "",
      updated_t: 1541698267,
    },
    {
      merchant: "Synthetic merchant 2",
      domain: "unbeatablesale.com",
      title: "19505 Unbleached White Flour",
      currency: "",
      list_price: "17.6",
      price: 10.08,
      link: "",
      updated_t: 1765790253,
    },
    {
      merchant: "Synthetic merchant 3",
      domain: "sears.com",
      title: "Synthetic Mill Unbleached White Flour (4x5lb)",
      currency: "",
      price: 40.98,
      link: "",
      updated_t: 1481112348,
    },
    {
      merchant: "Synthetic merchant 4",
      domain: "rakuten.com",
      title: "Synthetic Mill Unbleached White Flour 5",
      currency: "",
      price: 29.69,
      link: "",
      updated_t: 1558537267,
    },
    {
      merchant: "Synthetic merchant 5",
      domain: "walmart.com",
      title:
        "Synthetic Mill Unbleached White All-Purpose Baking Flour - 5 lb - Case of 4",
      currency: "",
      price: 43.77,
      link: "",
      updated_t: 1763964903,
    },
    {
      merchant: "Synthetic merchant 6",
      domain: "neweggbusiness.com",
      title:
        "Synthetic Mill Flour Unbleached White Pastry, 5-pounds (Pack of4)",
      currency: "",
      price: 44.71,
      link: "",
      updated_t: 1526486869,
    },
    {
      merchant: "Synthetic merchant 7",
      domain: "albertsons.com",
      title: "Synthetic Mill - White Flour 5.00 lb",
      currency: "",
      price: 0, // Invalid price
      link: "",
      updated_t: 1484640880,
    },
    {
      merchant: "Synthetic merchant 8",
      domain: "pricefalls.com",
      title: "Flour Wht Unblch 5 Lb Pack Of 4",
      currency: "",
      price: 45.91,
      link: "",
      updated_t: 1484937931,
    },
    {
      merchant: "Synthetic merchant 9",
      domain: "Synthetic merchant 9",
      title: "Synthetic Mill, Unbleached White All-Purpose Flour, 5 Lb",
      currency: "",
      list_price: "11.09",
      price: 6.65,
      link: "",
      updated_t: 1749511124,
    },
  ];

  it("keeps only offers the model judges comparable to the queried item", async () => {
    const price = await extractBestPrice(
      flourOffers,
      "Synthetic Mill Unbleached White Flour 5 lb",
      async ({ offerTitle }) =>
        /pack of\s*4|case of\s*4|4x5lb/i.test(offerTitle)
          ? "incomparable"
          : "comparable",
    );
    // Valid single-item prices: $10.08, $29.69, $6.65
    // Sorted: $6.65, $10.08, $29.69
    // Median (middle of 3): $10.08
    expect(price).toBe(10.08);
  });

  it("returns null for empty offers", async () => {
    expect(
      await extractBestPrice([], "Sample item", async () => "comparable"),
    ).toBe(null);
  });

  it("returns null when all prices are zero", async () => {
    const offers: UPCitemdbOffer[] = [
      {
        merchant: "A",
        domain: "a.com",
        title: "Product",
        currency: "",
        price: 0,
        link: "",
        updated_t: 0,
      },
      {
        merchant: "B",
        domain: "b.com",
        title: "Product",
        currency: "",
        price: 0,
        link: "",
        updated_t: 0,
      },
    ];
    expect(
      await extractBestPrice(offers, "Sample item", async () => "comparable"),
    ).toBe(null);
  });

  it("returns null when every positive offer is judged incomparable", async () => {
    const offers: UPCitemdbOffer[] = [
      {
        merchant: "A",
        domain: "a.com",
        title: "Product (Pack of 4)",
        currency: "",
        price: 40.0,
        link: "",
        updated_t: 0,
      },
      {
        merchant: "B",
        domain: "b.com",
        title: "Product Case of 6",
        currency: "",
        price: 60.0,
        link: "",
        updated_t: 0,
      },
    ];
    expect(
      await extractBestPrice(
        offers,
        "Sample item, one bottle",
        async () => "incomparable",
      ),
    ).toBe(null);
  });

  it("accepts a multipack offer when it matches the queried sellable pack", async () => {
    const offer = {
      merchant: "A",
      domain: "a.com",
      title: "Sample item 4-pack",
      currency: "USD",
      price: 20,
    } satisfies UPCitemdbOffer;
    expect(
      await extractBestPrice(
        [offer],
        "Sample item pack of 4",
        async () => "comparable",
      ),
    ).toBe(20);
  });

  it("rejects invalid prices even when the offer title matches", async () => {
    const offers = [
      {
        merchant: "A",
        domain: "a.com",
        title: "Sample item",
        currency: "USD",
        price: Number.NaN,
      },
      {
        merchant: "B",
        domain: "b.com",
        title: "Sample item",
        currency: "USD",
        price: -2,
      },
    ] satisfies UPCitemdbOffer[];
    expect(
      await extractBestPrice(offers, "Sample item", async () => "comparable"),
    ).toBe(null);
  });

  it("propagates model failures instead of publishing a partial price", async () => {
    await expect(
      extractBestPrice([flourOffers[1]!], "Sample item", async () => {
        throw new Error("decision unavailable");
      }),
    ).rejects.toThrow("decision unavailable");
  });

  it("handles single valid offer", async () => {
    const offers: UPCitemdbOffer[] = [
      {
        merchant: "A",
        domain: "a.com",
        title: "Single Product 5lb",
        currency: "",
        price: 12.99,
        link: "",
        updated_t: 0,
      },
    ];
    expect(
      await extractBestPrice(
        offers,
        "Single Product 5lb",
        async () => "comparable",
      ),
    ).toBe(12.99);
  });

  it("calculates median for even number of prices", async () => {
    const offers: UPCitemdbOffer[] = [
      {
        merchant: "A",
        domain: "a.com",
        title: "Product A",
        currency: "",
        price: 10.0,
        link: "",
        updated_t: 0,
      },
      {
        merchant: "B",
        domain: "b.com",
        title: "Product B",
        currency: "",
        price: 20.0,
        link: "",
        updated_t: 0,
      },
    ];
    // Median of [10, 20] = (10 + 20) / 2 = 15
    expect(
      await extractBestPrice(offers, "Product", async () => "comparable"),
    ).toBe(15.0);
  });

  it("ignores outlier high prices via median", async () => {
    const offers: UPCitemdbOffer[] = [
      {
        merchant: "A",
        domain: "a.com",
        title: "Product",
        currency: "",
        price: 5.0,
        link: "",
        updated_t: 0,
      },
      {
        merchant: "B",
        domain: "b.com",
        title: "Product",
        currency: "",
        price: 6.0,
        link: "",
        updated_t: 0,
      },
      {
        merchant: "C",
        domain: "c.com",
        title: "Product",
        currency: "",
        price: 100.0,
        link: "",
        updated_t: 0,
      }, // outlier
    ];
    // Sorted: [5, 6, 100], median = 6
    expect(
      await extractBestPrice(offers, "Product", async () => "comparable"),
    ).toBe(6.0);
  });
});
