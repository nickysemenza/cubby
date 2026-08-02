import { describe, expect, it } from "vitest";
import { flattenUniquePageItems } from "./infinite-page-utils";

describe("flattenUniquePageItems", () => {
  it("preserves first-seen page order and removes repeated ids", () => {
    const first = { id: "a", value: "first" };
    expect(
      flattenUniquePageItems([
        { items: [first, { id: "b", value: "second" }] },
        {
          items: [
            { id: "b", value: "refetched" },
            { id: "c", value: "third" },
            { id: "c", value: "same-page duplicate" },
          ],
        },
      ]),
    ).toEqual([
      first,
      { id: "b", value: "second" },
      { id: "c", value: "third" },
    ]);
  });

  it("returns an empty list before pages load", () => {
    expect(flattenUniquePageItems(undefined)).toEqual([]);
  });
});
