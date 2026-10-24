import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { describe, expect, it } from "vitest";

import { classificationAllowsField } from "~/server/domains/spending-category/repo/classification-field-policy";

describe("credit-card field applicability", () => {
  it.each(["bank_account", "stored_value", "cash", "other"])(
    "refuses card-only fields for %s before suggestion or editing",
    (kind) => {
      for (const field of ["network", "primaryCardholderId"]) {
        expect(
          classificationAllowsField(
            "financialAccount",
            { identity: { kind } },
            field,
          ),
        ).toBe(false);
        expect(
          classificationAllowsField(
            "financialAccount",
            { identity: JSON.stringify({ kind }) },
            field,
          ),
        ).toBe(false);
      }
    },
  );
  it("allows credit-card fields", () => {
    for (const field of ["network", "primaryCardholderId"])
      expect(
        classificationAllowsField(
          "financialAccount",
          { identity: { kind: "credit_card" } },
          field,
        ),
      ).toBe(true);
  });
});

it("limits the primary-cardholder picker to member parties", () => {
  const field = entityFieldModels.financialAccount.fields.find(
    (field) => field.key === "primaryCardholderId",
  );
  expect(field?.reference?.filters).toEqual([
    { field: "kind", values: ["member"] },
  ]);
});
