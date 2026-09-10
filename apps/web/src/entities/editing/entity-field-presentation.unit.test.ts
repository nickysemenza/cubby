import { describe, expect, it } from "vitest";

import { entityFieldPresentation } from "./entity-field-presentation";

describe("entityFieldPresentation", () => {
  it("uses model labels and control metadata for ordinary fields", () => {
    expect(
      entityFieldPresentation("ingredient", "usuallyOnHand", "edit"),
    ).toMatchObject({
      label: "Usually on hand",
      description:
        "Assume I have enough for recipe planning. Recorded inventory stays separate.",
      control: { kind: "checkbox", renderer: null },
      editable: true,
    });
  });

  it("derives create and update permission from the model contracts", () => {
    expect(
      entityFieldPresentation("image", "filename", "create").editable,
    ).toBe(false);
    expect(entityFieldPresentation("image", "filename", "edit").editable).toBe(
      true,
    );
  });

  it("rejects fields without a declared ordinary control", () => {
    expect(() => entityFieldPresentation("ingredient", "id", "edit")).toThrow(
      "Field ingredient.id has no editor control",
    );
  });
});
