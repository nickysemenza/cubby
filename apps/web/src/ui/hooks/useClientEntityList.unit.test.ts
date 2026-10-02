import { describe, expect, it } from "vitest";

import { filterClientRows } from "./useClientEntityList";

describe("client list primary search", () => {
  it("filters the complete projection before the caller takes a page", () => {
    const rows = [
      { id: "CKB-1", book: "Apple Cakes", author: ["A. Baker"] },
      { id: "CKB-2", book: "Bread Basics", author: ["B. Cook"] },
      { id: "CKB-3", book: "Garden Preserves", author: ["C. Baker"] },
    ];

    const filtered = filterClientRows(rows, "BAKER", (row, query) =>
      [row.book, ...row.author].some((value) =>
        value.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    );

    // A one-row page taken after this result contains CKB-3, rather than
    // skipping it because it followed an unmatched row in the full response.
    expect(filtered.slice(1, 2).map((row) => row.id)).toEqual(["CKB-3"]);
    expect(filtered).toHaveLength(2);
  });

  it("keeps all rows when the query is empty or no matcher is declared", () => {
    const rows = [{ id: "CKB-1" }, { id: "CKB-2" }];
    expect(filterClientRows(rows, "   ")).toEqual(rows);
    expect(filterClientRows(rows, "bread")).toEqual(rows);
  });
});
