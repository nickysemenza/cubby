import { describe, expect, it } from "vitest";

import {
  preserveSelectedPickerItems,
  referenceScopeFields,
  referenceScopeFor,
} from "./reference-scope";

describe("referenceScopeFor", () => {
  const reference = {
    entity: "planting",
    multiple: true,
    scope: [
      { sourceField: "locationId", targetField: "locationId" },
      { sourceField: "observedOn", targetField: "activeOn" },
    ],
  };

  it("keeps the candidate query closed while a dependent value is missing", () => {
    expect(referenceScopeFor(reference, { locationId: "LOC-TEST" })).toBeNull();
    expect(referenceScopeFields(reference)).toEqual([
      "locationId",
      "observedOn",
    ]);
  });

  it("maps all dependent values without changing the selected id array", () => {
    expect(
      referenceScopeFor(reference, {
        locationId: "LOC-TEST",
        observedOn: "2026-09-20",
      }),
    ).toEqual({ locationId: "LOC-TEST", activeOn: "2026-09-20" });
  });

  it("keeps selected ids visible when a narrower scope drops their candidates", () => {
    expect(
      preserveSelectedPickerItems(
        [{ id: "PLT-NEW", name: "New planting" }],
        ["PLT-OLD", "PLT-NEW"],
      ),
    ).toEqual([
      { id: "PLT-OLD", name: "PLT-OLD" },
      { id: "PLT-NEW", name: "New planting" },
    ]);
  });
});
