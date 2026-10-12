import { suggestFieldKeys } from "@cubby/schemas/entity-fields";
import { describe, expect, it } from "vitest";

import { decisionCatalogRows } from "./decision-catalog";

describe("Decisions catalog", () => {
  it("lists every manifest suggest field exactly once", () => {
    const fieldKeys = decisionCatalogRows()
      .filter((row) => row.field !== null)
      .map((row) => row.key);
    expect(fieldKeys.sort()).toEqual([...suggestFieldKeys].sort());
  });

  it("renders each prompt's subject into the request the model receives", () => {
    for (const row of decisionCatalogRows()) {
      expect(JSON.stringify(row.prompt.input)).toContain(
        JSON.stringify(row.prompt.subject),
      );
    }
  });
});
