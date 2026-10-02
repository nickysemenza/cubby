import { describe, expect, it } from "vitest";

import type { ComboboxItem } from "./combobox-types";
import {
  resolveBlankFilterKey,
  stabilizeGroupOrder,
} from "./entity-search-hooks";

describe("resolveBlankFilterKey", () => {
  it("resolves ingredient's name filter to nameFilter", () => {
    // ingredient's `name` column filter descriptor declares `field: "nameFilter"`
    // (see entity-filter-bindings.gen.ts) — the blank-query list request keys
    // on that field, not a hand-listed default.
    expect(resolveBlankFilterKey("ingredient")).toBe("nameFilter");
  });

  it("resolves task's name filter to search", () => {
    // task's `name` column filter descriptor declares `field: "search"` — the
    // one place the manifest-resolved key diverges from `nameFilter`.
    expect(resolveBlankFilterKey("task")).toBe("search");
  });

  it("resolves recipe, location, and product to nameFilter, project to search", () => {
    expect(resolveBlankFilterKey("recipe")).toBe("nameFilter");
    expect(resolveBlankFilterKey("location")).toBe("nameFilter");
    expect(resolveBlankFilterKey("product")).toBe("nameFilter");
    expect(resolveBlankFilterKey("project")).toBe("search");
  });
});

function grouped(
  id: string,
  groupId: string,
  groupLabel: string,
): ComboboxItem {
  return {
    id,
    name: id,
    presentation: { group: { id: groupId, label: groupLabel, order: 0 } },
  };
}

describe("stabilizeGroupOrder", () => {
  it("renumbers by each group's first appearance, clustering interleaved rows", () => {
    // A blank-query roster sorted by the row's OWN name interleaves roots —
    // "Bin" (Garage) sorts before "Drawer" (Kitchen) sorts before "Shelf"
    // (Garage again) — without this, the Garage/Kitchen header would repeat.
    const items = [
      grouped("bin", "garage", "Garage"),
      grouped("drawer", "kitchen", "Kitchen"),
      grouped("shelf", "garage", "Garage"),
    ];

    expect(
      stabilizeGroupOrder(items).map((item) => item.presentation?.group),
    ).toEqual([
      { id: "garage", label: "Garage", order: 0 },
      { id: "kitchen", label: "Kitchen", order: 1 },
      { id: "garage", label: "Garage", order: 0 },
    ]);
  });

  it("leaves ungrouped items untouched", () => {
    const ungrouped: ComboboxItem = { id: "x", name: "X" };
    expect(stabilizeGroupOrder([ungrouped])[0]).toBe(ungrouped);
  });
});
