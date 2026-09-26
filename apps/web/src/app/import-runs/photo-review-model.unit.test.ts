import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PhotoGroupProposal } from "@cubby/schemas/photo-import-run";
import { describe, expect, it } from "vitest";

import {
  mergeGroups,
  moveImage,
  needsStockDecision,
  receiveAllInto,
  toGroupInput,
} from "./photo-review-model";

const img = (code: string) => parseShortcodeFor("image", code);

const proposal = (
  groupKey: string,
  images: string[],
  state: PhotoGroupProposal["state"] = "proposed",
): PhotoGroupProposal => ({
  groupKey,
  state,
  images: images.map((code, index) => ({
    id: img(code),
    purpose: index === 0 ? "item" : "label",
  })),
  skip: [],
  product: { kind: "create", create: { name: `Item ${groupKey}` } },
  committedProduct: null,
  inventory: null,
  stockedHere: null,
  evidence: null,
  conflict: null,
  lastError: null,
  missingImageCount: 0,
  committedAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("photo review edits", () => {
  const proposals = [
    proposal("a", ["IMG-AAA2", "IMG-AAA3"]),
    proposal("b", ["IMG-BBB2"]),
    proposal("a-2", ["IMG-CCC2"], "committed"),
  ];

  it.each([
    {
      name: "moving the last photo out removes the emptied group",
      edit: () => moveImage(proposals, img("IMG-BBB2"), "a"),
      groups: { a: ["IMG-AAA2:item", "IMG-AAA3:label", "IMG-BBB2:label"] },
      removed: ["b"],
    },
    {
      name: "splitting picks a groupKey no proposal uses, skipping committed ones",
      edit: () => moveImage(proposals, img("IMG-AAA3"), null),
      groups: { a: ["IMG-AAA2:item"], "a-3": ["IMG-AAA3:item"] },
      removed: [],
    },
    {
      name: "an unassigned photo joins a group without touching others",
      edit: () => moveImage(proposals, img("IMG-NEW2"), "b"),
      groups: { b: ["IMG-BBB2:item", "IMG-NEW2:label"] },
      removed: [],
    },
    {
      name: "merging folds photos in as label shots and drops the source",
      edit: () => mergeGroups(proposals, "b", "a"),
      groups: { a: ["IMG-AAA2:item", "IMG-AAA3:label", "IMG-BBB2:label"] },
      removed: ["b"],
    },
  ])("$name", ({ edit, groups, removed }) => {
    const result = edit();
    expect(
      Object.fromEntries(
        result.groups.map((group) => [
          group.groupKey,
          group.images.map((image) => `${image.id}:${image.purpose}`),
        ]),
      ),
    ).toEqual(groups);
    expect(result.removeGroupKeys).toEqual(removed);
  });

  // Regression: a Product or Location deleted after proposing used to be
  // saved back as "create a Product named after the group" / "no inventory",
  // silently rewriting the reviewer's choice on any unrelated edit.
  describe("a deleted reference blocks every save that does not replace it", () => {
    const deletedProduct: PhotoGroupProposal = {
      ...proposal("gone", ["IMG-DDD2", "IMG-DDD3"]),
      product: { kind: "existing", existing: null },
    };
    const deletedLocation: PhotoGroupProposal = {
      ...proposal("lost", ["IMG-EEE2"]),
      inventory: {
        locationId: null,
        locationName: null,
        quantity: 2,
      },
    };
    const stale = [deletedProduct, deletedLocation, proposals[1]!];

    it.each([
      {
        name: "moving a photo out of a group with a deleted product",
        edit: () => moveImage(stale, img("IMG-DDD3"), "b"),
        error: /product was deleted/,
      },
      {
        name: "moving a photo into a group with a deleted location",
        edit: () => moveImage(stale, img("IMG-BBB2"), "lost"),
        error: /location was deleted/,
      },
    ])("refuses $name", ({ edit, error }) => {
      expect(edit).toThrow(error);
    });

    it("accepts a save that picks the replacement", () => {
      const replacement = parseShortcodeFor("product", "PRD-4K7M");
      expect(
        toGroupInput(deletedProduct, {
          product: { kind: "existing", existingId: replacement },
        }).product,
      ).toEqual({ kind: "existing", existingId: replacement });
      expect(
        toGroupInput(deletedLocation, { inventory: undefined }).inventory,
      ).toBeUndefined();
    });
  });
});

describe("where approved items are received", () => {
  const closet = parseShortcodeFor("location", "LOC-4K7M");
  const withInventory = (
    base: PhotoGroupProposal,
    inventory: PhotoGroupProposal["inventory"],
    stockedHere: PhotoGroupProposal["stockedHere"] = null,
  ): PhotoGroupProposal => ({ ...base, inventory, stockedHere });

  it("points every proposed group at one location, keeping each quantity", () => {
    const edit = receiveAllInto(
      [
        withInventory(proposal("a", ["IMG-AAA2"]), {
          locationId: null,
          locationName: null,
          quantity: 3,
        }),
        proposal("b", ["IMG-BBB2"]),
        proposal("c", ["IMG-CCC2"], "committed"),
      ],
      closet,
    );
    expect(
      edit.groups.map((group) => [group.groupKey, group.inventory]),
    ).toEqual([
      ["a", { locationId: closet, quantity: 3 }],
      ["b", { locationId: closet, quantity: 1 }],
    ]);
  });

  it("holds approval until the reviewer decides about existing stock", () => {
    const stocked = withInventory(
      proposal("a", ["IMG-AAA2"]),
      { locationId: closet, locationName: "Closet", quantity: 1 },
      {
        inventoryId: parseShortcodeFor("inventory", "INV-4K7M"),
        quantity: 2,
        unit: "each",
      },
    );
    expect(needsStockDecision(stocked)).toBe(true);
    expect(
      needsStockDecision({
        ...stocked,
        inventory: { ...stocked.inventory!, addToExisting: true },
      }),
    ).toBe(false);
    expect(toGroupInput(stocked).inventory?.addToExisting).toBeUndefined();
  });
});
