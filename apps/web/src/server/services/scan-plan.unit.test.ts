import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { planScan, type ScanFacts } from "./scan-plan";

const HERE = testShortcode("location", "LOC-HERE");
const AWAY = testShortcode("location", "LOC-AWAY");
const ATTIC = testShortcode("location", "LOC-ATTC");

const PRODUCT = {
  id: testShortcode("product", "PRD-BOOK"),
  name: "The Pragmatic Programmer",
};

const entry = (id: string) => testShortcode("inventory", id);

const row = (
  id: string,
  locationId: LocationShortcode,
  name: string,
  value = 1,
  unit = "each",
) => ({
  id: entry(id),
  amount: { value, unit },
  location: { id: locationId, name },
});

const facts = (stock: ScanFacts["stock"]): ScanFacts => ({
  product: PRODUCT,
  stock,
});

describe("planScan", () => {
  it("adds when nothing of the product is stocked anywhere", () => {
    expect(planScan(facts([]), HERE)).toEqual({
      kind: "add",
      product: PRODUCT,
      strays: [],
    });
  });

  it("confirms rather than increments when it is already on this shelf", () => {
    const plan = planScan(facts([row("INV-0001", HERE, "Bookshelf")]), HERE);

    expect(plan).toEqual({
      kind: "confirm",
      product: PRODUCT,
      entryId: entry("INV-0001"),
      strays: [],
    });
  });

  // The whole point of the presence-sweep model: re-sweeping a correct shelf
  // must be a no-op. An increment rule here would double a bookshelf, because
  // ISBN-created products carry `expectedQuantity: null`, not 1.
  it("is idempotent across repeated scans of the same shelved item", () => {
    const input = facts([row("INV-0001", HERE, "Bookshelf")]);

    expect(planScan(input, HERE)).toEqual(planScan(input, HERE));
  });

  it("queues a decision when the only copy lives elsewhere", () => {
    expect(
      planScan(facts([row("INV-0002", AWAY, "Office shelf")]), HERE),
    ).toEqual({
      kind: "decide",
      product: PRODUCT,
      strays: [
        {
          entryId: entry("INV-0002"),
          location: { id: AWAY, name: "Office shelf" },
          amount: { value: 1, unit: "each" },
          ambiguousQuantity: false,
        },
      ],
    });
  });

  it("flags a multi-unit source row as an ambiguous move", () => {
    const plan = planScan(facts([row("INV-0003", AWAY, "Pantry", 5)]), HERE);

    expect(plan.kind).toBe("decide");
    expect(plan.strays).toEqual([
      {
        entryId: entry("INV-0003"),
        location: { id: AWAY, name: "Pantry" },
        amount: { value: 5, unit: "each" },
        ambiguousQuantity: true,
      },
    ]);
  });

  it("treats a sub-unit source row as movable whole", () => {
    const plan = planScan(
      facts([row("INV-0004", AWAY, "Pantry", 0.5, "lb")]),
      HERE,
    );

    expect(plan.strays[0]?.ambiguousQuantity).toBe(false);
  });

  // A copy here says nothing about the copy in the other room, so the local row
  // is confirmed AND the remote one still queues.
  it("confirms here and still queues strays elsewhere", () => {
    const plan = planScan(
      facts([
        row("INV-0005", HERE, "Bookshelf"),
        row("INV-0006", AWAY, "Office shelf"),
      ]),
      HERE,
    );

    expect(plan.kind).toBe("confirm");
    expect(plan.strays.map((s) => s.entryId)).toEqual([entry("INV-0006")]);
  });

  it("queues every stray when the product is spread across locations", () => {
    const plan = planScan(
      facts([
        row("INV-0007", AWAY, "Office shelf"),
        row("INV-0008", ATTIC, "Attic bin", 3),
      ]),
      HERE,
    );

    expect(plan.kind).toBe("decide");
    expect(
      plan.strays.map((s) => [s.location.name, s.ambiguousQuantity]),
    ).toEqual([
      ["Office shelf", false],
      ["Attic bin", true],
    ]);
  });
});
