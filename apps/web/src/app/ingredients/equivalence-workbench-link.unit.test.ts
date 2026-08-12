import { unsafeIngredientShortcode } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";
import {
  enrichmentWorkbenchQueryInput,
  equivalenceDraftFromSearch,
  equivalenceWorkbenchSearch,
} from "./equivalence-workbench-link";
import { blankConvRow } from "./workbench-editor-core";

describe("equivalence workbench deep link", () => {
  it("carries the ingredient and candidate conversion into visible URL state", () => {
    expect(
      equivalenceWorkbenchSearch({
        ingredientId: unsafeIngredientShortcode("ING-4K7M"),
        ingredientName: "Flour",
        unitA: "cup",
        unitB: "g",
        occurrences: 3,
        medianRatio: 127.25,
        ratioSpread: { min: 125, max: 130 },
        examples: [],
      }),
    ).toEqual({
      focus: "ING-4K7M",
      equivalenceFromUnit: "cup",
      equivalenceToUnit: "g",
      equivalenceToValue: 127.25,
    });
  });

  it("builds a prefilled mapping only when every conversion field is valid", () => {
    const draft = equivalenceDraftFromSearch({
      equivalenceFromUnit: "cup",
      equivalenceToUnit: "g",
      equivalenceToValue: 127.25,
    });
    expect(draft).toEqual({
      fromValue: 1,
      fromUnit: "cup",
      toValue: 127.25,
      toUnit: "g",
    });
    expect(
      blankConvRow(draft?.fromUnit, {
        fromValue: draft?.fromValue ?? 0,
        toValue: draft?.toValue ?? 0,
        toUnit: draft?.toUnit ?? "",
      }),
    ).toMatchObject({
      fromQty: "1",
      fromUnit: "cup",
      toQty: "127.25",
      toUnit: "g",
    });
    expect(
      equivalenceDraftFromSearch({
        equivalenceFromUnit: "cup",
        equivalenceToUnit: "g",
        equivalenceToValue: 0,
      }),
    ).toBeUndefined();
    expect(
      equivalenceDraftFromSearch({ equivalenceFromUnit: "cup" }),
    ).toBeUndefined();
  });

  it("restricts the server worklist only for equivalence intent", () => {
    const initialConversion = {
      fromValue: 1,
      fromUnit: "cup",
      toValue: 127.25,
      toUnit: "g",
    };
    expect(
      enrichmentWorkbenchQueryInput({
        focus: "ING-4K7M",
        initialConversion,
      }),
    ).toEqual({ focusId: "ING-4K7M" });
    expect(
      enrichmentWorkbenchQueryInput({ focus: "ING-4K7M" }),
    ).toBeUndefined();
    expect(
      enrichmentWorkbenchQueryInput({
        focus: "ING-4K7M",
        recipeId: "RCP-4K7M",
        initialConversion,
      }),
    ).toEqual({ recipeId: "RCP-4K7M" });
  });
});
