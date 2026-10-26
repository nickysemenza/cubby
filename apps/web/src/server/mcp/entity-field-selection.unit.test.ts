import { describe, expect, it } from "vitest";

import { readSelection } from "./entity-field-selection";

describe("compact media contract", () => {
  it.each([
    { entity: "product", fields: ["itemImageCount", "labelImageCount"] },
    { entity: "vendor", fields: ["logo"] },
    { entity: "purchase", fields: ["vendorLogo"] },
  ])(
    "omits $entity media while retaining explicit field selection",
    ({ entity, fields }) => {
      const compact = readSelection({
        action: "list",
        entity,
        resultDetail: "compact",
      });
      expect(compact?.kind).toBe("compact");
      if (compact?.kind !== "compact")
        throw new Error("Expected compact selection");
      for (const field of fields) expect(compact.keys).not.toContain(field);
      expect(readSelection({ action: "list", entity, fields })).toEqual({
        kind: "fields",
        paths: fields.map((field) => [field]),
      });
    },
  );
});
