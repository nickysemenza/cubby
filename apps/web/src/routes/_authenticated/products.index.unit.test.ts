import { describe, expect, it } from "vitest";
import { productSearchSchema } from "~/entities/list-search";

describe("product route timeline search validation", () => {
  it("accepts every renderer and independent movement state", () => {
    expect(
      productSearchSchema.parse({
        view: "lifecycles",
        movementFrom: "2020-01-02",
        movementTo: "2025-03-04",
        movementOrder: "asc",
        manufacturer: "Acme",
      }),
    ).toMatchObject({
      view: "lifecycles",
      movementFrom: "2020-01-02",
      movementTo: "2025-03-04",
      movementOrder: "asc",
      manufacturer: "Acme",
    });

    for (const view of ["table", "shelf", "events", "lifecycles"]) {
      expect(productSearchSchema.parse({ view })).toMatchObject({ view });
    }
  });

  it("drops malformed timeline state without widening Product filters", () => {
    expect(
      productSearchSchema.parse({
        view: "calendar",
        movementFrom: "not-a-date",
        movementOrder: "sideways",
        tags: "M18",
      }),
    ).toMatchObject({
      view: undefined,
      movementFrom: undefined,
      movementOrder: undefined,
      tags: "M18",
    });
  });
});
