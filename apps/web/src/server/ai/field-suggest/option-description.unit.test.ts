import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { describe, expect, it } from "vitest";

import { fieldSuggestSpecFor } from "~/server/ai/field-suggest/registry";

describe("suggestion enum descriptions", () => {
  it("uses the manifest option meaning for an enum choice", () => {
    const field = entityFieldModels.expense.fields.find(
      (candidate) => candidate.key === "lineKind",
    );
    const option = field?.control?.options?.find(
      ({ value }) => value === "tax",
    );
    const spec = fieldSuggestSpecFor("expense", "lineKind");

    expect(option?.description).toBeTruthy();
    expect(spec?.kind).toBe("enum");
    expect(spec?.kind === "enum" ? spec.describe("tax") : undefined).toBe(
      option?.description,
    );
  });
});
