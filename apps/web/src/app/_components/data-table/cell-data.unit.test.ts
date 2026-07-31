import { describe, expect, it, vi } from "vitest";
import { entityCellData } from "./cell-data";

interface Row {
  id: string;
  relation: { id: string; name: string } | null;
}

const filled: Row = { id: "row-1", relation: { id: "rel-1", name: "One" } };

describe("entityCellData clear capability", () => {
  it("does not expose clearing for a required relation", () => {
    const data = entityCellData<Row>(
      "location",
      (row) => row.relation,
      async () => {},
    );
    expect(data.applyClear).toBeUndefined();
  });

  it("exposes clearing only when the nullable adapter supplies it", async () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    const data = entityCellData<Row>(
      "location",
      (row) => row.relation,
      async () => {},
      clear,
    );
    await expect(data.applyClear?.(filled)).resolves.toBeNull();
    expect(clear).toHaveBeenCalledWith(filled);
  });
});
