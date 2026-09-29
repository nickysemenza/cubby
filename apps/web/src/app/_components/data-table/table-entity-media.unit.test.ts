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
                entityKind: "product",
                entityId,
              })),
          }),
        },
      },
      { columnDef: { meta: undefined } },
    ];

    expect(collectTableEntityMediaRefs(visibleColumns, rows)).toEqual([
      { entityKind: "product", entityId: "PRD-ONE" },
      { entityKind: "product", entityId: "PRD-TWO" },
      { entityKind: "product", entityId: "PRD-TWO" },
      { entityKind: "product", entityId: "PRD-THREE" },
    ]);
  });
});
