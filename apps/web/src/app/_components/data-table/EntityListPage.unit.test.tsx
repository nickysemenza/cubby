import { describe, expect, it } from "vitest";

import { entityListPreviewOptions } from "./EntityListPage";

describe("EntityListPage preview contract", () => {
  it("uses the responsive inspector for canonical entity ids", () => {
    expect(entityListPreviewOptions(undefined)).toEqual({
      idField: undefined,
      responsiveInspector: true,
    });
  });

  it("preserves a declared alternate preview id field", () => {
    expect(entityListPreviewOptions({ idField: "fdc_id" })).toEqual({
      idField: "fdc_id",
      responsiveInspector: true,
    });
  });

  it("removes the preview seam only when the page explicitly opts out", () => {
    expect(entityListPreviewOptions(false)).toBeUndefined();
  });
});
