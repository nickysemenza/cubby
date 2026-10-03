import {
  inventoryShortcode,
  locationShortcode,
} from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import { describeDiscard, type DiscardShelf } from "./discard-preview";

// Synthetic shelves: a part-used tray and a full box in different rooms.
const shelf = (
  id: string,
  locationId: string,
  name: string,
  value: number,
): DiscardShelf => ({
  id: inventoryShortcode.parse(id),
  amount: { value, unit: "each" },
  location: { id: locationShortcode.parse(locationId), name },
});
const tray = shelf("INV-AAAA", "LOC-AAAA", "Workshop", 3);
const box = shelf("INV-BBBB", "LOC-BBBB", "Garage", 12);

const input = (over: Partial<Parameters<typeof describeDiscard>[1]> = {}) => ({
  quantity: 1,
  adjustInventory: true,
  inventoryEntryId: null,
  ...over,
});

describe("describeDiscard", () => {
  it("records a ledger-only exit for an unstocked product", () => {
    expect(describeDiscard([], input())).toMatchObject({
      ledgerOnly: true,
      selectedShelf: null,
      needsShelfChoice: false,
      warning: null,
    });
  });

  it("selects the sole shelf without asking", () => {
    expect(describeDiscard([tray], input())).toMatchObject({
      selectedShelf: tray,
      needsShelfChoice: false,
    });
  });

  it("owes a shelf choice with several shelves and none picked", () => {
    expect(describeDiscard([tray, box], input())).toMatchObject({
      selectedShelf: null,
      needsShelfChoice: true,
    });
  });

  it("owes no shelf choice when the shelf is left alone", () => {
    expect(
      describeDiscard([tray, box], input({ adjustInventory: false })),
    ).toMatchObject({ needsShelfChoice: false });
  });

  it("warns when the discard empties the shelf, without blocking", () => {
    const preview = describeDiscard([tray], input({ quantity: 3 }));
    expect(preview.warning?.tone).toBe("warning");
    expect(preview.warning?.message).toContain("Workshop");
  });

  it("warns destructively when more is discarded than the shelf holds", () => {
    const preview = describeDiscard([tray], input({ quantity: 5 }));
    expect(preview.warning).toMatchObject({ tone: "destructive" });
    expect(preview.warning?.message).toContain("−5");
  });

  it("warns that the shelf will still show stock when it is left alone", () => {
    const preview = describeDiscard(
      [tray],
      input({ quantity: 3, adjustInventory: false }),
    );
    expect(preview.warning?.tone).toBe("warning");
    expect(preview.warning?.message).toContain("still show 3 each");
  });

  it("stays quiet for a partial discard or an unset quantity", () => {
    expect(describeDiscard([box], input({ quantity: 2 })).warning).toBeNull();
    expect(
      describeDiscard([tray], input({ quantity: 2, adjustInventory: false }))
        .warning,
    ).toBeNull();
    expect(
      describeDiscard([tray], input({ quantity: null })).warning,
    ).toBeNull();
  });

  it("uses the named shelf among several", () => {
    const preview = describeDiscard(
      [tray, box],
      input({
        quantity: 12,
        inventoryEntryId: inventoryShortcode.parse("INV-BBBB"),
      }),
    );
    expect(preview.selectedShelf).toBe(box);
    expect(preview.needsShelfChoice).toBe(false);
    expect(preview.warning?.message).toContain("Garage");
  });
});
