import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import {
  type ProductMovementTimeline,
  toEntityTimeline,
} from "./movement-timeline";

const product = parseShortcodeFor("product", "PRD-TM22");
const acquired = parseShortcodeFor("expense", "EXP-TM22");
const sold = parseShortcodeFor("expense", "EXP-TM23");

const timeline: ProductMovementTimeline = {
  products: [
    {
      id: product,
      name: "Bench vise",
      manufacturer: "Acme",
      category: null,
      coverImageUrl: null,
      usedOnProjects: [],
      ownershipIntervals: [{ start: "2026-01-10", end: "2026-03-01" }],
      confidenceLostAt: "2026-03-01",
    },
  ],
  groups: [
    {
      key: "purchase:PUR-TM22",
      date: "2026-01-10",
      purchase: {
        id: parseShortcodeFor("purchase", "PUR-TM22"),
        displayLabel: "Order 42",
        orderId: "42",
        date: "2026-01-10",
        vendor: { id: parseShortcodeFor("vendor", "VEN-TM22"), name: "Toolco" },
      },
      movements: [
        {
          expenseId: acquired,
          productId: product,
          name: "Bench vise",
          kind: "acquired",
          cost: 120,
          quantity: 1,
          signedQuantity: 1,
          expenseDate: "2026-01-10",
          chargedTo: null,
          provenanceOnly: false,
        },
      ],
    },
    {
      key: "expense:EXP-TM23",
      date: "2026-03-01",
      purchase: null,
      movements: [
        {
          expenseId: sold,
          productId: product,
          name: "Sold the vise",
          kind: "exited",
          cost: -80,
          quantity: 1,
          signedQuantity: -1,
          expenseDate: "2026-03-02",
          chargedTo: null,
          provenanceOnly: false,
        },
        {
          expenseId: null,
          productId: product,
          name: "Unitemized purchase product",
          kind: "acquired",
          cost: null,
          quantity: null,
          signedQuantity: null,
          expenseDate: "2026-03-01",
          chargedTo: null,
          provenanceOnly: true,
        },
      ],
    },
  ],
  summary: {
    matchingProducts: 3,
    productsWithMovements: 1,
    movementCount: 3,
    spent: 120,
    recovered: 80,
    netCost: 40,
    unknownAmountCount: 1,
  },
  extent: { from: "2026-01-10", to: "2026-03-01" },
  omitted: { productsWithoutMovements: 2, plannedMovements: 1 },
  meta: { totalCount: 1, pageIndex: 0, pageSize: 200 },
};

describe("toEntityTimeline", () => {
  const out = toEntityTimeline(timeline);

  it("keeps the ledger sign on amounts and links each movement to its expense", () => {
    const events = out.groups.flatMap((group) => group.events);
    expect(events.map((event) => [event.kind, event.amount])).toEqual([
      ["acquired", 120],
      ["exited", -80],
      ["acquired", null],
    ]);
    expect(events[0]?.link).toEqual({ entity: "expense", id: acquired });
    // Provenance-only rows have no expense to open; they fall back to the product.
    expect(events[2]?.link).toEqual({ entity: "product", id: product });
    expect(events[1]?.detail).toContain("Ledger date 2026-03-02");
  });

  it("labels purchase groups by vendor and order and leaves standalone groups unlabelled", () => {
    expect(out.groups.map((group) => [group.label, group.link])).toEqual([
      ["Toolco · Order 42", { entity: "purchase", id: "PUR-TM22" }],
      [null, null],
    ]);
  });

  it("marks proven ownership confident and the span after confidence loss as open and unconfident", () => {
    expect(out.rows?.[0]?.intervals).toEqual([
      { start: "2026-01-10", end: "2026-03-01", confident: true },
      { start: "2026-03-01", end: null, confident: false },
    ]);
    expect(out.rows?.[0]?.markers.map((marker) => marker.kind)).toEqual([
      "acquired",
      "exited",
      "acquired",
    ]);
  });

  it("carries the six summary tiles, the omitted sentences, and the extent", () => {
    expect(out.stats).toEqual([
      { key: "products", label: "Products", value: "3" },
      { key: "movements", label: "Movements", value: "3" },
      { key: "spent", label: "Spent", value: "$120.00" },
      { key: "recovered", label: "Recovered", value: "$80.00" },
      { key: "netCost", label: "Net cost", value: "$40.00" },
      { key: "unknown", label: "Unknown / unitemized", value: "1" },
    ]);
    expect(out.notes).toEqual([
      "2 matching products have no recorded movement in this window.",
      "1 planned movement is omitted.",
    ]);
    expect(out.extent).toEqual({ from: "2026-01-10", to: "2026-03-01" });
  });

  it("passes the page through and says the totals cover only this page when more products moved", () => {
    expect(out.meta).toEqual({ totalCount: 1, pageIndex: 0, pageSize: 200 });
    const paged = toEntityTimeline({
      ...timeline,
      meta: { totalCount: 3, pageIndex: 1, pageSize: 1 },
    });
    expect(paged.meta).toEqual({ totalCount: 3, pageIndex: 1, pageSize: 1 });
    expect(paged.notes[0]).toBe(
      "Movements and totals cover the 1 product on this page of 3.",
    );
  });
});
