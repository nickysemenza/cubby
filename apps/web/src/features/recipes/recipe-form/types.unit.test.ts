import { describe, expect, it } from "vitest";

import { formSchema } from "./types";

// A name-only recipe with one empty section — the form's initial state. The catch
// is that react-hook-form materializes the nullable object fields (`meta`, `yield`)
// into objects full of `undefined` the moment their nested inputs render, even when
// the user never touches them. The form schema must accept that shape or the whole
// form silently refuses to submit (the original "Create does nothing" bug).
const nameOnlyForm = {
  name: "Just a name",
  // react-hook-form turns `meta: null` into this once the URL input mounts.
  meta: { url: undefined },
  // ...and `yield: null` into this once the value/unit inputs mount.
  yield: { value: undefined, unit: undefined },
  servings: null,
  tags: [],
  notes: null,
  sections: [{ name: null, ingredients: [], instructions: [] }],
};

describe("formSchema", () => {
  it("accepts a name-only recipe with materialized-empty meta and yield", () => {
    expect(formSchema.safeParse(nameOnlyForm).success).toBe(true);
  });

  it("requires a unit once a yield value is entered", () => {
    const result = formSchema.safeParse({
      ...nameOnlyForm,
      yield: { value: 24, unit: "" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a fully specified yield", () => {
    const result = formSchema.safeParse({
      ...nameOnlyForm,
      yield: { value: 24, unit: "cookies" },
    });
    expect(result.success).toBe(true);
  });

  it("still requires a name", () => {
    expect(formSchema.safeParse({ ...nameOnlyForm, name: "" }).success).toBe(
      false,
    );
  });

  // An ingredient row with one amount slot, exercising the draftAmount refine.
  const formWithAmount = (amount: { value: unknown; unit: unknown }) => ({
    ...nameOnlyForm,
    sections: [
      {
        name: null,
        ingredients: [
          {
            type: "ingredient",
            ingredient: { id: "i-1", name: "Vegetable oil" },
            recipe: null,
            amounts: [amount],
          },
        ],
        instructions: [],
      },
    ],
  });

  it("accepts an amount-less ingredient (both qty and unit blank)", () => {
    const result = formSchema.safeParse(
      formWithAmount({ value: null, unit: "" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a fully specified amount", () => {
    const result = formSchema.safeParse(
      formWithAmount({ value: 250, unit: "g" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a partial amount with a quantity but no unit", () => {
    const result = formSchema.safeParse(
      formWithAmount({ value: 250, unit: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a partial amount with a unit but no quantity", () => {
    const result = formSchema.safeParse(
      formWithAmount({ value: null, unit: "g" }),
    );
    expect(result.success).toBe(false);
  });
});
