import { describe, expect, it } from "vitest";

import { filterNotionPreview, updateVisibleSelection } from "./preview-filters";

const preview = [
  { pageId: "a", recipe: { meta: { title: "Miso Noodles" } }, status: "new" },
  {
    pageId: "b",
    recipe: { meta: { title: "TACOS al Pastor" } },
    status: "will-update",
  },
  {
    pageId: "c",
    recipe: { meta: { title: "Needs Help" } },
    status: "needs-formatting",
  },
  {
    pageId: "d",
    recipe: { meta: { title: "Already Here" } },
    status: "unchanged",
  },
] as const;

describe("Notion preview filters", () => {
  it("searches recipe names case-insensitively alongside the status filter", () => {
    expect(
      filterNotionPreview(preview, "tacos", "all").map((i) => i.pageId),
    ).toEqual(["b"]);
    expect(
      filterNotionPreview(preview, "", "needs-formatting").map((i) => i.pageId),
    ).toEqual(["c"]);
    expect(filterNotionPreview(preview, "miso", "will-update")).toEqual([]);
  });

  it("selects and deselects only visible actionable rows", () => {
    const visible = [preview[0], preview[1]];
    const hiddenSelection = new Set(["d"]);

    expect([...updateVisibleSelection(hiddenSelection, visible)]).toEqual([
      "d",
      "a",
      "b",
    ]);
    expect([
      ...updateVisibleSelection(new Set(["d", "a", "b"]), visible),
    ]).toEqual(["d"]);
  });
});
