import { describe, expect, it } from "vitest";

import { collectTableEntityMediaRefs } from "./table-entity-media";
import { attachCubbyColumnMeta } from "./table-meta";

describe("collectTableEntityMediaRefs", () => {
  it("collects every visible collection ref across rows at one owner", () => {
    const rows = [
      { original: { productIds: ["PRD-ONE", "PRD-TWO"] } },
      { original: { productIds: ["PRD-TWO", "PRD-THREE"] } },
    ];
    const visibleColumns = [
      {
        columnDef: {
          meta: attachCubbyColumnMeta<(typeof rows)[number]["original"]>({
            entityRefs: (row) =>
              row.productIds.map((entityId) => ({
                entityType: "product",
                entityId,
              })),
          }),
        },
      },
      { columnDef: { meta: undefined } },
    ];

    expect(collectTableEntityMediaRefs(visibleColumns, rows)).toEqual([
      { entityType: "product", entityId: "PRD-ONE" },
      { entityType: "product", entityId: "PRD-TWO" },
      { entityType: "product", entityId: "PRD-TWO" },
      { entityType: "product", entityId: "PRD-THREE" },
    ]);
  });
});
