import { describe, expect, it } from "vitest";

import { referenceScopeFields, referenceScopeFor } from "./reference-scope";

describe("referenceScopeFor", () => {
  const reference = {
    entity: "planting",
    multiple: true,
    filters: [],
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
});

describe("fixed reference restrictions", () => {
  it("intersects dependent filters so a picker cannot broaden declared owner kinds", () => {
    const reference = {
      entity: "ledgerParty",
      multiple: false,
      filters: [{ field: "kind", values: ["member", "guest"] }],
      scope: [{ sourceField: "chosenKinds", targetField: "kind" }],
    };
    expect(
      referenceScopeFor(reference, { chosenKinds: ["household", "guest"] }),
    ).toEqual({ kind: ["guest"] });
    expect(
      referenceScopeFor(reference, { chosenKinds: "household" }),
    ).toBeNull();
  });
});
