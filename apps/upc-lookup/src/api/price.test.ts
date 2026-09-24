import { describe, it, expect } from "vitest";
import { isMultiPack, extractBestPrice } from "./price";
import type { UPCitemdbOffer } from "./types";

describe("isMultiPack", () => {
  it("detects multi-pack title variants", () => {
    expect(
      [
        "Sample flour, 5 LB, (Pack of 4)",
        "Sample flour (Pack of4)",
        "Sample flour - 5 lb - Case of 4",
        "Sample flour (4x5lb)",
        "Sample flour Pack Of 4",
        "Sample product (4-pack)",
        "Sample kitchen set of 6",
      ].filter((title) => !isMultiPack(title)),
    ).toEqual([]);
  });

  it("does not flag single-item title variants", () => {
    expect(
      ["Sample flour, 5 lb", "Sample flour 5", "19505 Sample flour"].filter(
        isMultiPack,
      ),
    ).toEqual([]);
  });
});

describe("extractBestPrice", () => {
  // Real-world test data from the Bob's Red Mill flour example
  const flourOffers: UPCitemdbOffer[] = [
    {
      merchant: "Newegg.com",
      domain: "newegg.com",
      title: "BOBS RED MILL, FLOUR WHT UNBLCH, 5 LB, (Pack of 4)",
      currency: "",
      price: 44.26,
      link: "",
      updated_t: 1541698267,
    },
    {
      merchant: "UnbeatableSale.com",
      domain: "unbeatablesale.com",
      title: "19505 Unbleached White Flour",
      currency: "",
      list_price: "17.6",
      price: 10.08,
      link: "",
      updated_t: 1765790253,
    },
    {
      merchant: "Sears",
      domain: "sears.com",
      title: "Bob's Red Mill Unbleached White Flour (4x5lb)",
      currency: "",
      price: 40.98,
      link: "",
      updated_t: 1481112348,
    },
    {
      merchant: "Rakuten(Buy.com)",
      domain: "rakuten.com",
      title: "BOB'S RED MILL Unbleached White Flour 5",
      currency: "",
      price: 29.69,
      link: "",
      updated_t: 1558537267,
    },
    {
      merchant: "Wal-Mart.com",
      domain: "walmart.com",
      title:
        "Bob s Red Mill Unbleached White All-Purpose Baking Flour - 5 lb - Case of 4",
      currency: "",
      price: 43.77,
      link: "",
      updated_t: 1763964903,
    },
    {
      merchant: "Newegg Business",
      domain: "neweggbusiness.com",
      title:
        "Bob's Red Mill Flour Unbleached White Pastry, 5-pounds (Pack of4)",
      currency: "",
      price: 44.71,
      link: "",
      updated_t: 1526486869,
    },
    {
      merchant: "Albertsons",
      domain: "albertsons.com",
      title: "Bob's Red Mill - White Flour 5.00 lb",
      currency: "",
      price: 0, // Invalid price
      link: "",
      updated_t: 1484640880,
    },
    {
      merchant: "Pricefalls.com",
      domain: "pricefalls.com",
      title: "Flour Wht Unblch 5 Lb Pack Of 4",
      currency: "",
      price: 45.91,
      link: "",
      updated_t: 1484937931,
    },
    {
      merchant: "HerbsPro",
      domain: "HerbsPro",
      title: "Bobs Red Mill, Unbleached White All-Purpose Flour, 5 Lb",
      currency: "",
      list_price: "11.09",
      price: 6.65,
      link: "",
      updated_t: 1749511124,
    },
  ];

  it("filters out multi-pack offers and returns median of valid prices", () => {
    const price = extractBestPrice(flourOffers);
    // Valid single-item prices: $10.08, $29.69, $6.65
    // Sorted: $6.65, $10.08, $29.69
    // Median (middle of 3): $10.08
    expect(price).toBe(10.08);
  });

  it("returns null for empty offers", () => {
    expect(extractBestPrice([])).toBe(null);
  });

  it("returns null when all prices are zero", () => {
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
    expect(extractBestPrice(offers)).toBe(null);
  });

  it("falls back to multi-pack price when no single-item prices exist", () => {
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
    // Falls back to first non-zero price since no single-item offers
    expect(extractBestPrice(offers)).toBe(40.0);
  });

  it("handles single valid offer", () => {
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
    expect(extractBestPrice(offers)).toBe(12.99);
  });

  it("calculates average for even number of prices", () => {
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
    expect(extractBestPrice(offers)).toBe(15.0);
  });

  it("ignores outlier high prices via median", () => {
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
    expect(extractBestPrice(offers)).toBe(6.0);
  });
});
