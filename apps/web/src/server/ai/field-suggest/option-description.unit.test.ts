import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { describe, expect, it } from "vitest";

import {
  FIELD_SUGGEST_REGISTRY,
  fieldSuggestSpecFor,
} from "~/server/ai/field-suggest/registry";

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

  it("declares a non-empty manifest description for every enum suggestion option", () => {
    for (const [key, registrySpec] of Object.entries(FIELD_SUGGEST_REGISTRY)) {
      if (registrySpec.kind !== "enum") continue;
      const separator = key.indexOf(".");
      const entity = key.slice(0, separator);
      const field = key.slice(separator + 1);
      const model = Object.entries(entityFieldModels).find(
        ([name]) => name === entity,
      )?.[1];
      const options = model?.fields.find((candidate) => candidate.key === field)
        ?.control?.options;
      if (!options?.length) throw new Error(`${key} has no enum options`);

      for (const option of options) {
        expect(
          "description" in option && option.description.trim().length > 0,
        ).toBe(true);
      }

      const spec = fieldSuggestSpecFor(entity, field);
      if (spec?.kind !== "enum")
        throw new Error(`${key} does not resolve to an enum suggestion`);
      for (const option of options) {
        const description =
          "description" in option ? option.description : undefined;
        expect(spec.describe(option.value)).toBe(description);
      }
    }
  });
});
